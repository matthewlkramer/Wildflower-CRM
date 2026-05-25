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
// Kept in sync with the funder-domain matcher's filter list.
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "ymail.com",
  "live.com",
  "msn.com",
  "comcast.net",
  "att.net",
  "verizon.net",
  "sbcglobal.net",
  "cox.net",
  "earthlink.net",
  "mail.com",
]);

export function domainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return d.length > 0 ? d : null;
}

export function isFreeMailDomain(domain: string | null | undefined): boolean {
  return !!domain && FREE_MAIL_DOMAINS.has(domain.toLowerCase());
}

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

  if (!leftCompany && !newCompany && !newEmail) return null;
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
export function parseEmailSignature(
  bodyText: string | null,
  bodyHtml: string | null,
): SignatureParse | null {
  const text = (bodyText && bodyText.trim().length > 0
    ? bodyText
    : stripHtml(bodyHtml ?? "")) ?? "";
  if (!text) return null;

  // Trim the quoted-reply tail.
  const beforeQuote = text
    .split(
      /\n\s*(?:On\s+.{1,80}\s+wrote:|From:\s|-----\s*Original Message\s*-----|________________________________)/i,
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
  const phoneRe = /(?:\+?\d[\d\s().-]{7,}\d)/;
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

  let title: string | null = null;
  let company: string | null = null;
  let phone: string | null = null;
  let email: string | null = null;

  for (const line of tail) {
    if (!email) {
      const m = line.match(emailRe);
      if (m) email = m[0].toLowerCase();
    }
    if (!phone) {
      const m = line.match(phoneRe);
      // Avoid grabbing dates / years
      if (m && /\d{3}.*\d{3}/.test(m[0])) phone = m[0].trim();
    }
    if (!title && line.length <= 90 && titleTokens.test(line)) {
      // Strip leading bullet / icon chars
      title = line.replace(/^[\W_]+/, "").trim();
    }
    if (!company && line.length <= 120 && orgTokens.test(line) && !titleTokens.test(line)) {
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
