/**
 * Pure detectors for the email intelligence pipeline. No DB access, no
 * network calls — everything is parsing of headers and bodies. Keeping
 * these separate from the orchestrator makes them trivial to unit-test
 * with fixture emails.
 *
 * Each detector errs on the side of returning null / [] when a pattern
 * is ambiguous; downstream proposals are reviewed by a human before
 * any side-effect, so false positives cost a click but false negatives
 * cost a missed signal.
 */

// Free-mail domains: addresses on these are never treated as
// "domain-of-a-funder" signal and senders matching common bulk
// patterns are filtered out of the unrecognized-correspondent panel.
// The list now lives in freeMailDomains.ts (shared with the
// emailMatcher domain branch) so the two can no longer drift apart.
export { FREE_MAIL_DOMAINS, domainOf, isFreeMailDomain } from "./freeMailDomains";

// ──────────────────────────────────────────────────────────────────
// LinkedIn job-change detection
// ──────────────────────────────────────────────────────────────────

const LINKEDIN_NOTIFICATION_SENDERS = new Set([
  "notifications-noreply@linkedin.com",
  "notifications@linkedin.com",
  "messaging-digest-noreply@linkedin.com",
  "jobs-noreply@linkedin.com",
  "jobs-listings@linkedin.com",
]);

export function isLinkedInNotificationSender(from: string | null | undefined): boolean {
  if (!from) return false;
  const lower = from.toLowerCase();
  if (LINKEDIN_NOTIFICATION_SENDERS.has(lower)) return true;
  // Catch-all: any noreply@linkedin.com or notifications-*@linkedin.com
  return /(^|[<\s])(notifications?[^@]*|.*-noreply)@linkedin\.com/i.test(from);
}

export interface LinkedInJobChange {
  personName: string;
  newTitle: string | null;
  newCompany: string;
  sourceLine: string;
}

/**
 * Pull job-change items out of a LinkedIn notification email. Handles
 * both the weekly "network catch-up" digest (multiple items per email)
 * and single-event "X started a new position at Y" notifications.
 *
 * We strip HTML to plain text first because LinkedIn's HTML is heavily
 * table-nested and the patterns are easier to spot in the rendered
 * text. The text body LinkedIn ships alongside the HTML is fine to
 * use directly when present.
 */
export function extractLinkedInJobChanges(
  bodyText: string | null,
  bodyHtml: string | null,
  subject: string | null,
): LinkedInJobChange[] {
  const text = (bodyText && bodyText.trim().length > 0
    ? bodyText
    : stripHtml(bodyHtml ?? "")) ?? "";
  if (!text) return [];

  const out: LinkedInJobChange[] = [];
  const seen = new Set<string>();
  const push = (item: LinkedInJobChange) => {
    const key = `${item.personName.toLowerCase()}|${item.newCompany.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  // Pattern A: "Jane Doe started a new position as Director of X at Acme"
  // Pattern B: "Jane Doe is now Director of X at Acme"
  // Pattern C: "Jane Doe started a new position at Acme"
  // We require the name to look like a name (2–4 capitalized tokens, no
  // ALL CAPS marketing copy).
  const namePat = "([A-Z][a-zA-Z'’.-]{1,}(?:\\s+[A-Z][a-zA-Z'’.-]{1,}){1,3})";
  // Title can contain commas/hyphens/&; bound on " at " (greedy fallback
  // would slurp the company name).
  const titlePat = "((?:[A-Z][\\w.&,/'’-]*|\\s|of|the|and|for|to|&)+?)";
  const companyPat = "([\\w][\\w &.,'’()/-]{1,80}?)(?=[\\s.!\\n,]*(?:$|congratulate|view|see|reply|sent\\sfrom|unsubscribe))";

  const patterns = [
    new RegExp(`${namePat}\\s+started\\s+a\\s+new\\s+position\\s+as\\s+${titlePat}\\s+at\\s+${companyPat}`, "gim"),
    new RegExp(`${namePat}\\s+is\\s+now\\s+${titlePat}\\s+at\\s+${companyPat}`, "gim"),
    new RegExp(`${namePat}\\s+started\\s+a\\s+new\\s+position\\s+at\\s+${companyPat}`, "gim"),
    new RegExp(`Congratulate\\s+${namePat}\\s+(?:on|for)\\s+(?:starting\\s+a\\s+new\\s+position|the\\s+new\\s+role)(?:\\s+as\\s+${titlePat})?\\s+at\\s+${companyPat}`, "gim"),
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const sourceLine = m[0].trim().replace(/\s+/g, " ").slice(0, 240);
      // Patterns vary in capture group count — handle both 2-group
      // (name + company) and 3-group (name + title + company) shapes.
      const personName = (m[1] ?? "").trim();
      const companyRaw = (m[3] ?? m[2] ?? "").trim();
      const titleRaw = (m[3] ? m[2] : null)?.trim() ?? null;
      const cleanedCompany = cleanCompany(companyRaw);
      const cleanedTitle = titleRaw ? cleanTitle(titleRaw) : null;
      if (!personName || !cleanedCompany) continue;
      if (looksLikeMarketingNoise(personName) || looksLikeMarketingNoise(cleanedCompany)) {
        continue;
      }
      push({
        personName,
        newTitle: cleanedTitle && cleanedTitle.length > 1 ? cleanedTitle : null,
        newCompany: cleanedCompany,
        sourceLine,
      });
    }
  }

  // Subject line frequently has the strongest single-event signal:
  // "Congratulate Jane Doe on the new role"
  if (subject && out.length === 0) {
    const subjMatch = subject.match(
      /(?:Congratulate|Wish)\s+([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,3})/,
    );
    if (subjMatch) {
      // We have the name but no company yet — scan the body for
      // "at <Company>" right after that name.
      const name = subjMatch[1];
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const bodyHit = text.match(
        new RegExp(`${escaped}[^.]{0,200}?\\bat\\s+([\\w][\\w &.,'’()/-]{1,80})`, "i"),
      );
      if (bodyHit) {
        const company = cleanCompany(bodyHit[1]);
        if (company && !looksLikeMarketingNoise(company)) {
          push({
            personName: name,
            newTitle: null,
            newCompany: company,
            sourceLine: bodyHit[0].trim().slice(0, 240),
          });
        }
      }
    }
  }

  return out;
}

function cleanCompany(raw: string): string {
  return raw
    .replace(/[.!,;:\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function cleanTitle(raw: string): string {
  return raw
    .replace(/[.!,;:\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function looksLikeMarketingNoise(s: string): boolean {
  if (!s) return true;
  const trimmed = s.trim();
  if (trimmed.length < 2 || trimmed.length > 120) return true;
  // Reject things like "View", "See more", "Reply", "Sent from LinkedIn"
  return /\b(view|see more|reply|sent from|linkedin|unsubscribe|jobs?|notification|update|message|inmail|premium)\b/i
    .test(trimmed) &&
    /\b(view|see|reply|sent|notification|inmail|unsubscribe)\b/i.test(trimmed);
}

// ──────────────────────────────────────────────────────────────────
// Bounce detection
// ──────────────────────────────────────────────────────────────────

const BOUNCE_SENDER_PATTERNS: RegExp[] = [
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^bounces?\+/i,
  /^bounces?@/i,
  /noreply.*bounce/i,
];

export function isBounceSender(from: string | null | undefined): boolean {
  if (!from) return false;
  return BOUNCE_SENDER_PATTERNS.some((re) => re.test(from));
}

export interface BounceParse {
  recipient: string;
  smtpCode: string | null;
  enhancedCode: string | null;
  isHard: boolean;
  reason: string | null;
}

const SOFT_BOUNCE_HINTS = [
  /mailbox.*full/i,
  /quota/i,
  /temporarily/i,
  /try again later/i,
  /4\.\d\.\d/, // 4.x.x enhanced status codes are transient
];
const HARD_BOUNCE_HINTS = [
  /user unknown/i,
  /no such user/i,
  /recipient (?:address )?rejected/i,
  /address not found/i,
  /does not exist/i,
  /no mailbox here/i,
  /account (?:has been )?(?:disabled|deactivated|suspended)/i,
  /5\.1\.[01]/, // 5.1.0 / 5.1.1 — bad destination mailbox
];

export function parseBounce(
  subject: string | null,
  bodyText: string | null,
  bodyHtml: string | null,
): BounceParse | null {
  const text = (bodyText && bodyText.trim().length > 0
    ? bodyText
    : stripHtml(bodyHtml ?? "")) ?? "";
  if (!text && !subject) return null;
  const haystack = `${subject ?? ""}\n${text}`;

  // Failed recipient line — standard DSN format
  let recipient: string | null = null;
  const failedRecipMatch = text.match(/Final-Recipient:\s*[^;]+;\s*([^\s>]+@[^\s>]+)/i)
    ?? text.match(/Original-Recipient:\s*[^;]+;\s*([^\s>]+@[^\s>]+)/i)
    ?? text.match(/(?:to|recipient|address)\s*[:<]?\s*([^\s<>"]+@[^\s<>"]+)/i)
    ?? text.match(/<([^\s<>]+@[^\s<>]+)>:\s*(?:host|user|mailbox|no such)/i);
  if (failedRecipMatch) recipient = failedRecipMatch[1];
  if (!recipient) return null;
  recipient = recipient.replace(/[.,;:>]+$/g, "").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return null;

  // Enhanced status code (e.g. 5.1.1)
  const enhMatch = haystack.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/);
  const enhanced = enhMatch ? enhMatch[1] : null;
  // SMTP reply code (3-digit, typically following "550")
  const smtpMatch = haystack.match(/\b([45]\d{2})\b/);
  const smtp = smtpMatch ? smtpMatch[1] : null;

  let isHard = false;
  if (enhanced && /^5\./.test(enhanced)) isHard = true;
  if (smtp && /^5/.test(smtp)) isHard = true;
  if (HARD_BOUNCE_HINTS.some((re) => re.test(haystack))) isHard = true;
  if (SOFT_BOUNCE_HINTS.some((re) => re.test(haystack)) && !HARD_BOUNCE_HINTS.some((re) => re.test(haystack))) {
    isHard = false;
  }

  // Short reason snippet — first ~140 chars of the body line containing
  // the recipient or the SMTP code, for human review.
  const reasonLine = text
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().includes(recipient!) || (enhanced && l.includes(enhanced))) ?? null;
  const reason = reasonLine ? reasonLine.trim().slice(0, 200) : null;

  return { recipient, smtpCode: smtp, enhancedCode: enhanced, isHard, reason };
}

// ──────────────────────────────────────────────────────────────────
// Auto-responder + "I've moved" detection
// ──────────────────────────────────────────────────────────────────

const AUTO_RESPONDER_SUBJECT_RE =
  /\b(out of (?:the )?office|automatic reply|auto-?reply|on (?:vacation|leave|holiday|sabbatical)|away from (?:my )?(?:desk|email|office)|no longer (?:with|at))\b/i;

export function isAutoResponder(
  subject: string | null,
  bodyText: string | null,
): boolean {
  if (subject && AUTO_RESPONDER_SUBJECT_RE.test(subject)) return true;
  if (bodyText) {
    const head = bodyText.slice(0, 600);
    if (/\bI(?:'m| am) (?:currently )?out of (?:the )?office\b/i.test(head)) return true;
    if (/\bauto(?:matic)?(?:[- ])?(?:reply|response)\b/i.test(head)) return true;
    if (/\bno longer (?:with|at|employed)\b/i.test(head)) return true;
  }
  return false;
}

export interface AutoResponderMove {
  leftCompany: string | null;
  newCompany: string | null;
  newEmail: string | null;
  quotedSnippet: string;
}

export function parseAutoResponderMove(
  bodyText: string | null,
  bodyHtml: string | null,
): AutoResponderMove | null {
  const text = (bodyText && bodyText.trim().length > 0
    ? bodyText
    : stripHtml(bodyHtml ?? "")) ?? "";
  if (!text) return null;
  const head = text.slice(0, 1200);

  // Plain out-of-office / vacation auto-replies are noise: the person
  // is still at the org, just temporarily away. Bail when the message
  // reads like an OOO AND carries none of the "I left / I moved on"
  // departure signals. (We still continue if a departure phrase is
  // present, since some people word a permanent departure as an OOO.)
  const oooRe =
    /\b(out\s+of\s+(?:the\s+)?office|on\s+(?:vacation|holiday|leave|pto|annual\s+leave|parental\s+leave|maternity\s+leave|paternity\s+leave|sabbatical)|away\s+from\s+(?:my\s+)?(?:desk|email|the\s+office)|currently\s+(?:traveling|travelling|away)|will\s+be\s+(?:out|away)|limited\s+access\s+to\s+(?:my\s+)?email|return(?:ing)?\s+(?:on|to\s+the\s+office))\b/i;
  const departureRe =
    /\b(no\s+longer\s+(?:work|employed|with|at)|has\s+left|have\s+left|I\s+have\s+left|moved\s+on|new\s+(?:role|position|job|opportunity|chapter)|joined|accepted\s+a\s+(?:new\s+)?(?:role|position)|departed|resigned|last\s+day)\b/i;
  if (oooRe.test(head) && !departureRe.test(head)) return null;

  let leftCompany: string | null = null;
  let newCompany: string | null = null;
  let newEmail: string | null = null;

  // "I no longer work at Acme" / "I am no longer with Acme Corp"
  const leftMatch = head.match(
    /\b(?:I(?:'m| am)?|no longer)\s*(?:am\s+)?no\s+longer\s+(?:work(?:ing)?\s+(?:at|for|with)|with|at|employed\s+(?:at|by))\s+([A-Z][\w &.,'’()/-]{2,80})/i,
  ) ?? head.match(
    /\bhas\s+left\s+([A-Z][\w &.,'’()/-]{2,80})/i,
  );
  if (leftMatch) leftCompany = cleanCompany(leftMatch[1]);

  // "I'm now at Acme" / "I have joined Acme" / "I've moved to Acme"
  const newMatch = head.match(
    /\b(?:I(?:'m| am| have| 've)?\s+(?:now\s+(?:at|with)|joined|moved\s+to|started\s+(?:a\s+new\s+)?(?:role|position)\s+(?:at|with))|currently\s+(?:at|with))\s+([A-Z][\w &.,'’()/-]{2,80})/i,
  );
  if (newMatch) newCompany = cleanCompany(newMatch[1]);

  // "Please reach me at jane@newco.com" / "new email: jane@newco.com"
  const emailMatch = head.match(
    /\b(?:reach(?:ed)?(?:\s+me)?(?:\s+at)?|contact\s+me(?:\s+at)?|new\s+email(?:\s+address)?(?:\s+is)?|email\s+me(?:\s+at)?|please\s+email)\s*[:\s]+([^\s<>"]+@[^\s<>"]+)/i,
  );
  if (emailMatch) newEmail = emailMatch[1].toLowerCase().replace(/[.,;:>]+$/g, "");

  // Only surface a genuine MOVE: the person must have either left an
  // org or joined/started somewhere new. A bare forwarding address
  // ("for urgent matters email my colleague at x@co.com") on its own is
  // NOT a move — those frequently appear in OOO replies.
  if (!leftCompany && !newCompany) return null;
  const snippet = head.replace(/\s+/g, " ").trim().slice(0, 280);
  return { leftCompany, newCompany, newEmail, quotedSnippet: snippet };
}

// ──────────────────────────────────────────────────────────────────
// Email signature parsing
// ──────────────────────────────────────────────────────────────────

export interface SignatureParse {
  name: string | null;
  title: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * Try to pull title / phone / company out of the trailing signature
 * block of an inbound email. Heuristic:
 *   1. Take the last ~25 non-empty lines before any quoted-reply
 *      marker ("On … wrote:", "From: ", "-----Original Message-----").
 *   2. Look for the standard sig-card patterns:
 *      - phone: groups of digits / parens / dashes (≥7 digits total)
 *      - email: anything matching the email regex
 *      - title: short line (<=90 chars) containing a common title token
 *      - company: a line that looks org-shaped (Inc / LLC /
 *        Foundation / etc, OR all-capitalized words)
 *
 * Returns null if we can't find at least one of title / phone / company.
 */
// Validates that a candidate substring is actually phone-shaped, not a
// year range, ZIP+4, account/order number, Zoom meeting id, etc.
// Real phone numbers carry 10 (US) up to 15 (E.164) digits. Without a
// phone label on the line we additionally require a separator / "+" /
// "(" so a bare long digit run can't masquerade as a phone.
function looksLikePhone(raw: string, hasLabel: boolean): boolean {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return false;
  // All-identical or trivially sequential digit runs aren't phones.
  if (/^(\d)\1+$/.test(digits)) return false;
  if (!hasLabel) {
    const hasShape = /[()\-.\s]/.test(trimmed) || trimmed.startsWith("+");
    if (!hasShape) return false;
  }
  return true;
}

export function parseEmailSignature(
  bodyText: string | null,
  bodyHtml: string | null,
): SignatureParse | null {
  // When HTML is available we prefer it because we can structurally
  // drop quoted-reply blocks (Gmail wraps them in
  // `<div class="gmail_quote">` / `<blockquote>`, Apple Mail uses
  // `<blockquote type="cite">`). Stripping these BEFORE the regex
  // splits below prevents a stray prior message's signature (often
  // the mailbox owner's own outbound sig) from being parsed as if it
  // belonged to the current sender.
  let text: string;
  if (bodyHtml && bodyHtml.trim().length > 0) {
    const dequoted = bodyHtml
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, " ")
      .replace(
        /<div[^>]*class=["'][^"']*gmail_quote[^"']*["'][\s\S]*$/gi,
        " ",
      );
    text = stripHtml(dequoted);
    // Some clients (Outlook) don't use blockquote and we end up with
    // a flat text dump even from HTML. Fall through to the text
    // marker splitter below regardless.
    if (!text && bodyText) text = bodyText;
  } else {
    text = bodyText ?? "";
  }
  if (!text) return null;

  // Trim the quoted-reply tail. Covers Gmail ("On … wrote:"),
  // Outlook ("From: " header block, "________________________________"
  // divider), Apple Mail ("Begin forwarded message:"), Spanish/French
  // Gmail ("El … escribió:", "Le … a écrit:"), and the loose "wrote:"
  // line that some clients emit without the "On " prefix.
  const beforeQuote = text
    .split(
      /\n\s*(?:On\s+.{1,80}\s+wrote:|El\s+.{1,80}\s+escribi[oó]:|Le\s+.{1,80}\s+a\s+[ée]crit\s*:|From:\s|-----\s*Original Message\s*-----|________________________________|Begin\s+forwarded\s+message:|>\s)/i,
    )[0] ?? text;
  const lines = beforeQuote
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  // The signature is in the last ~12 lines but we look back 25 to be
  // safe for verbose sigs with social handles, pronouns, addresses.
  const tail = lines.slice(-25);

  const titleTokens = /\b(CEO|COO|CFO|CTO|CIO|CMO|President|Vice\s+President|VP|Director|Manager|Head\s+of|Partner|Founder|Co-?Founder|Owner|Principal|Lead|Officer|Counsel|Coordinator|Associate|Analyst|Consultant|Advisor|Strategist|Engineer|Trustee|Chair(?:person)?|Executive)\b/i;
  const orgTokens = /\b(Inc\.?|LLC|Ltd\.?|Foundation|Trust|Fund|Partners|Capital|Group|Holdings?|Family\s+Office|Philanthropies|Philanthropy|Schools?|University|College|Institute|Association|Society|Bank|Bancorp|Charity|Charitable)\b/;
  // Phone label that, when present on a line, lets us accept a plain
  // 10–15 digit run as a phone even without separators.
  const phoneLabelRe = /\b(phone|tel|telephone|mobile|cell|office|direct|fax|call|ph|mob)\b|(?:^|\s)(?:o|m|c|p|d|f|t)\s*[:.]\s*(?=.*\d)/i;
  // Candidate phone substring: optional +country, optional (area),
  // then digit groups joined by space / dot / hyphen. Requires at
  // least one separator so we don't latch onto bare ID/account/Zoom
  // numbers. The label path below covers separator-less real numbers.
  const phoneRe =
    /(?:\+?\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)\s?)?\d{2,4}(?:[\s.\-]\d{2,4}){1,4}(?:\s*(?:x|ext\.?)\s*\d{1,5})?/i;
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  // Words that mark a line as prose / CTA / self-reference rather than
  // a real company name. "wildflower" is the mailbox owner's own org —
  // a correspondent's employer is never Wildflower, so a parsed
  // "company" mentioning it is a mis-parse.
  const companyProseRe =
    /\b(membership|for all|on behalf|please|thank|regards|sincerely|looking forward|sent from|wildflower)\b/i;

  // Zoom / Google Meet / Teams dial-in blocks list "one tap mobile" and
  // "dial by your location" numbers that are MEETING ACCESS numbers, not
  // the sender's personal phone. Mark every line inside such a block so
  // the phone detector skips them — a genuine labeled / separator-shaped
  // personal number elsewhere in the signature is still picked up.
  const meetingCueRe =
    /\b(zoom|google\s+meet|microsoft\s+teams|webex|gotomeeting|dial\s+by\s+your\s+location|dial[-\s]?in|one[-\s]?tap\s+mobile|join\s+by\s+phone|meeting\s+id|passcode|find\s+your\s+local\s+number|international\s+numbers?\s+available)\b|PIN\s*:|,,\s*\d|#\s*$/i;
  // A line that starts as a phone number (e.g. "+1 312 626 6799 US (Chicago)").
  const dialNumberLineRe = /^\+?\d[\d\s().\-]{6,}\d/;
  const meetingTainted = new Array<boolean>(tail.length).fill(false);
  let inMeetingBlock = false;
  for (let i = 0; i < tail.length; i++) {
    const l = tail[i];
    if (meetingCueRe.test(l)) {
      meetingTainted[i] = true;
      inMeetingBlock = true;
      continue;
    }
    if (inMeetingBlock) {
      // Inside a dial-in block, bare number lines are additional access
      // numbers — keep tainting them. Any other content line closes it.
      if (dialNumberLineRe.test(l)) {
        meetingTainted[i] = true;
        continue;
      }
      inMeetingBlock = false;
    }
  }

  let title: string | null = null;
  let company: string | null = null;
  let phone: string | null = null;
  let email: string | null = null;

  for (let li = 0; li < tail.length; li++) {
    const line = tail[li];
    if (!email) {
      const m = line.match(emailRe);
      if (m) email = m[0].toLowerCase();
    }
    if (!phone && !meetingTainted[li]) {
      const hasLabel = phoneLabelRe.test(line);
      const m = line.match(phoneRe);
      if (m && looksLikePhone(m[0], hasLabel)) {
        phone = m[0].trim();
      } else if (hasLabel) {
        // Labelled line ("Mobile: 5551234567") — accept a bare 10–15
        // digit run that the separator-requiring regex above skipped.
        const bare = line.match(/\+?\d[\d\s().\-]{8,}\d/);
        if (bare && looksLikePhone(bare[0], true)) phone = bare[0].trim();
      }
    }
    if (!title && line.length <= 90 && titleTokens.test(line)) {
      // Strip leading bullet / icon chars
      title = line.replace(/^[\W_]+/, "").trim();
    }
    if (
      !company &&
      line.length <= 120 &&
      orgTokens.test(line) &&
      !titleTokens.test(line) &&
      // Reject lines that merely contain an org token but are really
      // prose / a call-to-action / a reference to the mailbox owner's
      // own org ("…membership for all Wildflower Schools"). These
      // produced bogus "company changed" drift for senders whose true
      // employer was elsewhere.
      !companyProseRe.test(line) &&
      // A real company line is a handful of (mostly capitalized) words,
      // not a sentence. Cap the wordy ones out.
      line.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length <= 7
    ) {
      company = line.replace(/^[\W_]+/, "").trim();
    }
  }

  // Name guess — if we see "First Last" alone on a line in the tail,
  // and it sits right above title/company, use it. Optional.
  let name: string | null = null;
  for (let i = 0; i < tail.length; i++) {
    const l = tail[i];
    if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z'’.-]+){1,3}$/.test(l)) {
      name = l;
      break;
    }
  }

  if (!title && !company && !phone) return null;
  return { name, title, company, phone, email };
}

// ──────────────────────────────────────────────────────────────────
// Grant opportunity detection
// ──────────────────────────────────────────────────────────────────

// Known senders of grant / RFP digests. Don't have to be exhaustive
// — the subject-line heuristic below catches the long tail.
const GRANT_DIGEST_SENDERS: RegExp[] = [
  /@(?:philanthropynewsdigest|philanthropy\.com|insidephilanthropy|philanthropytoday)\b/i,
  /@(?:candid\.org|grantstation|grantwatch|grantsforward|grants\.gov)\b/i,
  /@(?:cof|cof\.org|councilonfoundations|geofunders|tsne|edutopia)\b/i,
  /@(?:fundsforngos|grantspace|fconline|foundationcenter)\b/i,
  /\bnewsletter@/i,
  /\bdigest@/i,
  /\brfp@/i,
  /\bgrants?@/i,
];

const GRANT_SUBJECT_RE =
  /\b(request\s+for\s+proposals?|RFP|RFA|RFQ|letter\s+of\s+(?:inquiry|interest)|LOI|grant\s+(?:opportunity|opportunities|announcement|alert|cycle|deadline|round)|funding\s+(?:opportunity|opportunities|announcement|available)|(?:now\s+)?accepting\s+applications|call\s+for\s+(?:proposals|applications)|(?:open|new)\s+(?:grant|funding))\b/i;

const GRANT_BODY_HINTS_RE =
  /\b(deadline|due\s+(?:by|date)|apply\s+by|application\s+(?:deadline|due)|letter\s+of\s+(?:inquiry|interest)|LOI|request\s+for\s+proposals?|RFP|grant\s+(?:opportunity|amount|range|award|cycle))\b/i;

// Words that, when paired with a dollar amount, indicate the amount
// represents grant funding (not a ticket price, course price, salary,
// etc.). Used to gate the AMOUNT_RE signal so that "4-day intensive |
// $199" no longer counts as a grant opportunity.
const GRANT_AMOUNT_CONTEXT_RE =
  /\b(funding|grant|award|prize|fellowship|scholarship|stipend|investment|RFP|RFA|LOI)\b/i;

// Subjects that signal an event invite / newsletter / promo rather
// than an open grant. If the subject (or the candidate block) matches
// one of these AND the subject doesn't also explicitly mention RFP /
// LOI / grant funding, we skip extraction entirely.
const NON_GRANT_EVENT_RE =
  /\b(webinar|info(?:rmation)?\s+session|demo(?:\s+day)?|bootcamp|intensive|workshop|conference|summit|meetup|happy\s+hour|fireside\s+chat|networking|panel\s+discussion|office\s+hours|ask\s+me\s+anything|AMA|book\s+launch|product\s+launch|new\s+feature|release\s+notes|case\s+study)\b/i;

// First-line patterns that mean the block is the tail of a quoted
// reply / forwarded message, not a real opportunity description.
const QUOTED_TAIL_FIRST_LINE_RE =
  /^(?:>|_{3,}|-{3,}|={3,}|\*{3,}|#{3,}|<https?:|Forwarded\s+message|Begin\s+forwarded\s+message|On\s+.{1,80}\s+wrote:|From:\s|Sent\s+from\s+my)/i;

// Grant WINNER / recipient announcements. These celebrate awards
// already made — not a new opportunity to apply for. We suppress them
// entirely (subject-level) and per-block. Deliberately phrased to
// catch past-tense / "meet our grantees" language without snaring
// future-tense opportunity copy like "grants will be awarded to
// selected applicants".
const GRANT_WINNER_RE =
  /\b(congratulations\s+to|winners?\s+(?:are|have\s+been|announced|named|selected)|recipients?\s+(?:are|have\s+been|announced|named|selected)|grantees?\s+(?:are|have\s+been|announced|named|selected)|meet\s+(?:our|the)\s+(?:\d{4}\s+)?(?:grantees|recipients|winners|fellows|cohort|awardees)|proud\s+to\s+announce\s+(?:our|the|this\s+year'?s)\s+(?:\d{4}\s+)?(?:grantees|recipients|winners|awardees|fellows|cohort)|(?:has|have)\s+been\s+awarded|awarded\s+grants?\s+to|recipients?\s+of\s+(?:our|the|this))\b/i;

// Future-facing "you can still apply" language. Used to gate the winner
// suppression: a winner announcement is only allowed through when it ALSO
// advertises an OPEN round. Deliberately narrower than GRANT_BODY_HINTS_RE
// (which matches "grant award"/"grant cycle" — phrasing winner emails carry
// naturally) so that a pure "congrats to our grantees" blast can't slip past
// just by mentioning the word "grant".
const GRANT_OPEN_OPPORTUNITY_RE =
  /\b(now\s+accepting|accepting\s+applications|applications?\s+(?:are\s+)?(?:now\s+)?open|now\s+open\s+for\s+applications|open\s+for\s+applications|apply\s+(?:now|today|by|here|online)|deadline\s+to\s+apply|call\s+for\s+(?:proposals?|applications?)|request\s+for\s+proposals?|RFP|letter\s+of\s+(?:inquiry|interest)|LOI|submit\s+(?:your\s+)?(?:application|proposal|LOI))\b/i;

// RFPs whose intent is to HIRE a vendor / contractor / consultant to
// perform work FOR the sender — i.e. the sender is the buyer, not a
// funder. Wildflower is a grant SEEKER, so vendor-procurement RFPs are
// noise. (RFP/RFQ/RFB keywords alone qualify a grant subject, so we
// must explicitly carve these out.)
const VENDOR_RFP_RE =
  /\b(seeking\s+(?:a\s+)?(?:vendor|contractor|consultant|firm|agency|bidder|proposer)|proposals?\s+from\s+(?:qualified\s+)?(?:vendors|contractors|consultants|firms|agencies|bidders|proposers)|scope\s+of\s+work|statement\s+of\s+work|invitation\s+to\s+bid|request\s+for\s+(?:qualifications|bids?|quotations?)|procurement|submit\s+(?:a\s+)?bid|to\s+provide\s+(?:services|goods|consulting))\b/i;

// Promo / newsletter / event-registration / sponsorship copy. These
// are marketing, not open grants. Used as an extra skip filter (the
// event regex above already covers webinars / conferences themselves;
// this targets the "register / buy tickets / sponsor us" call-to-action
// variants and pure promotional blasts).
const PROMO_REGISTRATION_RE =
  /\b(register\s+(?:now|today|here|online)|registration\s+(?:is\s+)?(?:now\s+)?open|reserve\s+your\s+(?:seat|spot|place)|early\s+bird|save\s+the\s+date|buy\s+(?:tickets|your\s+ticket)|tickets?\s+(?:are\s+)?(?:now\s+)?(?:available|on\s+sale)|sponsorship\s+opportunit|become\s+a\s+sponsor|exhibitor|sign\s+up\s+(?:now|today)|limited\s+(?:seats|spots))\b/i;

const DEADLINE_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Parse a deadline string into a UTC Date ONLY when it carries an
// explicit 4- or 2-digit year. Bare "Dec 15" returns null so we never
// guess the year (and therefore never suppress on a guess).
function parseDeadlineDate(s: string): Date | null {
  const str = s.trim();
  let m = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return new Date(Date.UTC(y, +m[1] - 1, +m[2]));
  }
  m = str.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m) {
    const mon = DEADLINE_MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (mon === undefined) return null;
    return new Date(Date.UTC(+m[3], mon, +m[2]));
  }
  return null;
}

// True only when the deadline carried an explicit year AND falls
// strictly before the reference day. Unknown / yearless deadlines are
// never treated as passed (conservative — we'd rather surface a maybe
// than hide a live opportunity).
export function deadlineHasPassed(deadline: string | null, reference: Date): boolean {
  if (!deadline) return false;
  const parsed = parseDeadlineDate(deadline);
  if (!parsed) return false;
  const refDay = Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate(),
  );
  return parsed.getTime() < refDay;
}

/**
 * Heuristic: does this sender/subject look like a grants newsletter
 * or RFP announcement worth scanning for opportunities? Returns true
 * when EITHER the sender domain/local-part is a known philanthropy
 * digest OR the subject line explicitly advertises a grant / RFP /
 * LOI. Body inspection is left to `extractGrantOpportunities` —
 * keeping this header-only lets the gmailSync pre-fetch gate stay
 * cheap.
 */
export function isLikelyGrantDigest(
  fromEmail: string | null | undefined,
  subject: string | null | undefined,
): boolean {
  if (fromEmail && GRANT_DIGEST_SENDERS.some((re) => re.test(fromEmail))) {
    return true;
  }
  if (subject && GRANT_SUBJECT_RE.test(subject)) return true;
  return false;
}

export interface GrantOpportunity {
  title: string;
  funderName: string | null;
  deadline: string | null;
  amount: string | null;
  url: string | null;
  snippet: string;
}

// Date-ish chunk: "December 15, 2026", "Dec 15", "12/15/2026", "2026-12-15".
// The `(?!\d)` after the day token is load-bearing: without it, "May 2026"
// (a bare month+year with no day) parses as "May 20" by grabbing the
// first two digits of the year as a day-of-month. The negative lookahead
// forces the day to be followed by a non-digit so the year digits of a
// bare "Month Year" string don't get mis-parsed as a day.
const DEADLINE_RE = new RegExp(
  [
    "(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)",
    "\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+\\d{4})?)",
    "|\\d{1,2}/\\d{1,2}/\\d{2,4}(?!\\d)",
    "|\\d{4}-\\d{2}-\\d{2}(?!\\d)",
  ].join(""),
  "i",
);

// Money-ish chunk: "$50,000", "$50K", "$50,000 - $500,000", "up to $1M".
const AMOUNT_RE =
  /(?:up\s+to\s+)?\$\s?\d[\d,]*(?:\.\d{1,2})?(?:\s*[KMB])?(?:\s*[-–to]+\s*\$?\s?\d[\d,]*(?:\.\d{1,2})?(?:\s*[KMB])?)?/i;

// Captures the visible href of a link in either plain text or stripped
// HTML, anchored on common grant-application words.
const URL_RE = /https?:\/\/[^\s<>"')]+/g;

/**
 * Scan a grants-newsletter / RFP-announcement message for individual
 * opportunities. Returns one entry per opportunity we can isolate.
 *
 * Strategy:
 *   1. Strip HTML to plain text.
 *   2. Split the body into "blocks" — separated by blank lines or
 *      headings. Each block is a candidate opportunity item.
 *   3. Keep a block only if it carries at least one grant-shaped
 *      signal (deadline word / dollar amount / RFP keyword / apply
 *      verb) — otherwise it's masthead / footer / unrelated content.
 *   4. From each kept block extract: title (first non-empty line, ≤200
 *      chars), funderName (line containing "Foundation"/"Fund"/
 *      "Trust"/etc.), deadline (first date match), amount (first money
 *      match), url (first http URL).
 *
 * Single-opportunity announcement emails (one block only) are
 * promoted by using the subject as title fallback.
 */
export function extractGrantOpportunities(
  subject: string | null,
  bodyText: string | null,
  bodyHtml: string | null,
  fromEmail: string | null,
  emailSentAt?: Date | null,
): GrantOpportunity[] {
  const text = (bodyText && bodyText.trim().length > 0
    ? bodyText
    : stripHtml(bodyHtml ?? "")) ?? "";
  if (!text && !subject) return [];

  // Reference date for "has this deadline already passed?" checks. We
  // judge against TODAY (not the email's sent date): a grant whose
  // application deadline is already in the past relative to now is a
  // dead lead the reviewer shouldn't have to triage, even if it was
  // still open when the (possibly backfilled / late-synced) email
  // first arrived.
  void emailSentAt;
  const reference = new Date();

  // Event / webinar / demo / bootcamp invites are not grant
  // opportunities, even when they show up in a digest that DOES carry
  // real RFPs. If the subject is clearly an event invite AND it
  // doesn't also explicitly advertise a grant / RFP / LOI / funding
  // round, abandon extraction. (When both are present we let the
  // per-block filter below sort them out.)
  if (
    subject &&
    NON_GRANT_EVENT_RE.test(subject) &&
    !GRANT_SUBJECT_RE.test(subject)
  ) {
    return [];
  }

  // Subject-level suppression of whole emails that are clearly not new
  // grant opportunities: winner/recipient announcements, vendor-hiring
  // RFPs, and promo/registration/sponsorship blasts. We only bail on
  // the WINNER signal when the subject doesn't ALSO advertise a fresh
  // round (some funders announce winners + next cycle in one subject);
  // vendor + promo signals are unambiguous enough to bail outright.
  if (
    subject &&
    GRANT_WINNER_RE.test(subject) &&
    !GRANT_OPEN_OPPORTUNITY_RE.test(subject)
  ) {
    return [];
  }
  if (subject && VENDOR_RFP_RE.test(subject)) return [];
  if (
    subject &&
    PROMO_REGISTRATION_RE.test(subject) &&
    !GRANT_SUBJECT_RE.test(subject)
  ) {
    return [];
  }

  // Block split: 1+ blank lines OR a Markdown/numbered list marker.
  const blocks = text
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const items: GrantOpportunity[] = [];
  const seen = new Set<string>();

  const consider = (block: string, titleOverride?: string) => {
    // Skip blocks that are obviously the tail of a quoted reply or
    // forwarded message — the "title" would be the quote marker
    // itself (e.g. "> Got time to talk before the holidays?",
    // "Forwarded message ---------", a bare "________"), not a real
    // opportunity. Only applies when titleOverride wasn't supplied.
    if (!titleOverride && QUOTED_TAIL_FIRST_LINE_RE.test(block)) return;

    // Per-block event filter: catches digests that legitimately mix
    // RFPs and webinars in the same email. We don't want the webinar
    // entries to land as grant proposals.
    if (NON_GRANT_EVENT_RE.test(block) && !GRANT_BODY_HINTS_RE.test(block)) {
      return;
    }

    // Per-block winner-announcement filter: a digest may pair a fresh
    // RFP with a "congratulations to our 2026 grantees" blurb. Drop the
    // winner blocks; keep the genuine opportunity blocks.
    if (GRANT_WINNER_RE.test(block) && !GRANT_OPEN_OPPORTUNITY_RE.test(block)) {
      return;
    }
    // Vendor-procurement RFP block — sender is hiring, not funding.
    if (VENDOR_RFP_RE.test(block)) return;
    // Promo / registration / sponsorship block with no real grant hint.
    if (PROMO_REGISTRATION_RE.test(block) && !GRANT_BODY_HINTS_RE.test(block)) {
      return;
    }

    // A dollar amount only counts as a grant signal when it sits in
    // grant-context language. Bare price tags ("$199", "$15/mo")
    // would otherwise drag in newsletter / product-launch blocks.
    const amountIsGrantLike =
      AMOUNT_RE.test(block) && GRANT_AMOUNT_CONTEXT_RE.test(block);

    // Block must look grant-shaped — either subject already qualified
    // or the block contents do.
    const blockHasSignal =
      GRANT_BODY_HINTS_RE.test(block) ||
      amountIsGrantLike ||
      DEADLINE_RE.test(block);
    const subjectQualified =
      !!titleOverride && subject ? GRANT_SUBJECT_RE.test(subject) : false;
    if (!blockHasSignal && !subjectQualified) return;

    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0 && !titleOverride) return;
    const rawTitle = titleOverride ?? lines[0];
    const title = rawTitle.replace(/^[\s#*•\-–—>_=]+/, "").trim().slice(0, 200);
    // Title sanity: must have a meaningful word count and not be a
    // URL fragment or pure punctuation / divider.
    if (!title || title.length < 8) return;
    if (QUOTED_TAIL_FIRST_LINE_RE.test(title)) return;
    if (/^https?:|^<https?:/i.test(title)) return;
    const wordCount = title.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length;
    if (wordCount < 3) return;

    let funderName: string | null = null;
    for (const l of lines) {
      const m = l.match(/\b([A-Z][\w&.,'’()/-]*(?:\s+[A-Z][\w&.,'’()/-]*){0,5}\s+(?:Foundation|Fund|Trust|Endowment|Philanthropies|Philanthropy|Initiative|Family\s+Office|Charitable\s+Trust))\b/);
      if (m) {
        funderName = m[1].trim();
        break;
      }
    }

    const deadlineMatch = block.match(
      new RegExp(`(?:deadline|due(?:\\s+(?:by|date))?|apply\\s+by|submit\\s+by|closes?(?:\\s+on)?)[^\\n]{0,40}?(${DEADLINE_RE.source})`, "i"),
    );
    const deadline = deadlineMatch ? deadlineMatch[1].trim() : null;

    // Suppress opportunities whose application deadline (when it
    // carried an explicit year) has already passed relative to when the
    // email was sent. Yearless deadlines are never treated as passed.
    if (deadlineHasPassed(deadline, reference)) return;

    const amountMatch = block.match(AMOUNT_RE);
    const amount = amountMatch ? amountMatch[0].trim() : null;

    const urlMatch = block.match(URL_RE);
    const url = urlMatch
      ? urlMatch.find(
          (u) =>
            !/unsubscribe|preferences|view-?in-?browser|email|list-manage|click\.|tracking/i.test(
              u,
            ),
        ) ??
        urlMatch[0]
      : null;

    const snippet = block.replace(/\s+/g, " ").trim().slice(0, 320);
    const key = `${title.toLowerCase()}|${funderName?.toLowerCase() ?? ""}|${deadline ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ title, funderName, deadline, amount, url, snippet });
  };

  if (blocks.length <= 1) {
    // Probably a single-opportunity announcement email (e.g. a
    // funder directly emailing an RFP). Use subject as title.
    const onlyBlock = blocks[0] ?? "";
    consider(onlyBlock, subject?.trim() || undefined);
  } else {
    for (const b of blocks) consider(b);
    // If multi-block but nothing qualified yet, fall back to the
    // subject + first qualifying block. Common in newsletter intros.
    if (items.length === 0 && subject && GRANT_SUBJECT_RE.test(subject)) {
      const firstQualified = blocks.find(
        (b) =>
          GRANT_BODY_HINTS_RE.test(b) ||
          AMOUNT_RE.test(b) ||
          DEADLINE_RE.test(b),
      );
      if (firstQualified) consider(firstQualified, subject);
    }
  }

  // Best-effort sender annotation for callers' use; not stored on the
  // item itself (the orchestrator records it on the proposal payload).
  void fromEmail;
  return items;
}

// ──────────────────────────────────────────────────────────────────
// Bulk sender heuristic
// ──────────────────────────────────────────────────────────────────

const BULK_LOCAL_PARTS = [
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "newsletter",
  "news",
  "notifications",
  "notify",
  "alerts",
  "marketing",
  "promo",
  "info",
  "support",
  "team",
  "hello",
  "hi",
  "updates",
  "digest",
  "billing",
  "invoice",
  "receipts",
  "mailer",
  "automated",
  "system",
];

/**
 * Returns true if `from` looks like a transactional / marketing /
 * mailing-list sender that should NOT show up in the "people you've
 * been emailing" panel.
 *
 * We can't see the List-Unsubscribe header (sync layer doesn't store
 * raw headers), so we fall back to:
 *   - local-part keyword match
 *   - presence of "unsubscribe" in the body
 *   - sender on a free-mail domain — that's ambiguous, NOT bulk on its
 *     own (lots of real prospects use gmail), but combined with a bulk
 *     local-part it's a strong yes.
 */
export function isBulkSender(
  fromEmail: string | null | undefined,
  bodyText: string | null,
  bodyHtml: string | null,
): boolean {
  if (!fromEmail) return true;
  const local = fromEmail.split("@")[0]?.toLowerCase() ?? "";
  if (BULK_LOCAL_PARTS.includes(local)) return true;
  // Local parts that START with a bulk token + delimiter
  if (/^(noreply|no-reply|donotreply|newsletter|notify|notifications|alerts|marketing|promo|mailer|info|updates|digest|automated|bounces?)[._+-]/.test(local)) {
    return true;
  }
  const body = (bodyText && bodyText.length > 0
    ? bodyText
    : stripHtml(bodyHtml ?? "")) ?? "";
  if (body && /\bunsubscribe\b/i.test(body) && /\b(view in browser|update (?:your )?preferences|opt[- ]out)\b/i.test(body)) {
    return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

/**
 * Minimal HTML → text stripper good enough for parsing notification /
 * bounce / auto-reply bodies. Not safe for arbitrary HTML rendering;
 * we only use the output for regex matching.
 */
export function stripHtml(html: string): string {
  if (!html) return "";
  return html
    // Drop script/style blocks entirely
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    // Convert <br> and block boundaries to newlines
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    // Strip all remaining tags
    .replace(/<[^>]+>/g, " ")
    // Decode common HTML entities
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z]+;/gi, " ")
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}
