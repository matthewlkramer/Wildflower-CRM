import { isAutoResponder, isBulkSender, stripHtml } from "./intelDetectors";

export interface InboundTrackingMessage {
  fromEmail: string | null;
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  aiSummary: string | null;
}

const MACHINE_SUBJECT_RE =
  /^\s*(?:(?:re|fw|fwd):\s*)*(?:automatic(?:ally generated)? (?:reply|response|message)|auto(?:matic)?[- ]?(?:reply|response)|out of (?:the )?office|ooo\b|away message|on leave\b|vacation reply|delivery status notification|undeliverable|mail delivery failed|(?:your )?(?:order|payment|transaction|donation) (?:confirmation|receipt)|receipt for\b|(?:daily|weekly|monthly) (?:digest|newsletter|roundup)\b)/i;

const MACHINE_BODY_RE =
  /\b(?:this (?:is an? )?automatically generated (?:email|message)|please do not reply|do not reply to this (?:email|message)|this (?:email address|mailbox|inbox) is not monitored|replies to this (?:email|message) (?:are not monitored|will not be read))\b/i;

const MASS_MAIL_SIGNALS = [
  /\bunsubscribe\b/i,
  /\bmanage (?:your )?(?:email )?(?:preferences|subscriptions)\b/i,
  /\bview (?:this )?(?:email|message) in (?:your )?browser\b/i,
  /\byou (?:are|were|have been) receiving this (?:email|message) because\b/i,
  /\bemail preferences\b/i,
];

const UNSUBSCRIBE_CONTROL_RE =
  /(?:<a\b[^>]*href=["'][^"']*(?:unsubscrib|opt[-_]?out|email[-_]?preferences)[^"']*["'][^>]*>|<(?:a|button)\b[^>]*>[\s\S]{0,240}\b(?:unsubscribe|opt[- ]out|manage (?:email )?preferences)\b[\s\S]{0,80}<\/(?:a|button)>)/i;

const UNSUBSCRIBE_URL_RE =
  /\bhttps?:\/\/\S*(?:unsubscrib|opt[-_]?out|email[-_]?preferences)\S*/i;

const MEETING_INVITE_SUBJECT_RE =
  /^\s*(?:updated\s+)?(?:meeting|event|calendar)?\s*(?:invitation|invite):|^\s*(?:cancell?ed|accepted|declined|tentative):|\binvited you to (?:a |an )?(?:meeting|event)\b/i;

const MEETING_INVITE_BODY_RE =
  /\b(?:join (?:the )?(?:zoom|microsoft teams|google meet|webex) meeting|respond to this invitation|yes\s*[-–—]\s*maybe\s*[-–—]\s*no)\b/i;

function stripQuotedText(text: string): string {
  const unquoted = text.split(
    /\n(?:on .{0,240} wrote:|from:\s.*\n|[-_]{2,}\s*original message\s*[-_]{2,})/i,
  )[0];
  return unquoted
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
}

function stripQuotedHtml(html: string | null): string {
  if (!html) return "";
  return html
    .replace(
      /<div[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>[\s\S]*$/i,
      "",
    )
    .replace(/<blockquote\b[^>]*>[\s\S]*$/i, "");
}

/**
 * Whether an otherwise CRM-matched inbound message belongs in the human
 * follow-up queue. This intentionally does not decide whether the message is
 * worth retaining on a CRM timeline; ingestion has a broader relevance bar.
 */
export function shouldSuppressInboundTrackingMessage(
  message: InboundTrackingMessage,
): boolean {
  const currentHtml = stripQuotedHtml(message.bodyHtml);
  const readableBody =
    stripQuotedText(message.bodyText ?? "") ||
    stripQuotedText(stripHtml(currentHtml)) ||
    stripQuotedText(message.snippet ?? "") ||
    message.aiSummary?.trim() ||
    "";
  const bodyText = readableBody || null;

  if (isAutoResponder(message.subject, bodyText)) return true;
  if (isBulkSender(message.fromEmail, bodyText, message.bodyHtml)) return true;
  if (message.subject && MACHINE_SUBJECT_RE.test(message.subject)) return true;

  if (readableBody && MACHINE_BODY_RE.test(readableBody)) return true;
  if (currentHtml && UNSUBSCRIBE_CONTROL_RE.test(currentHtml)) return true;
  if (readableBody && UNSUBSCRIBE_URL_RE.test(readableBody)) return true;
  if (
    (message.subject && MEETING_INVITE_SUBJECT_RE.test(message.subject)) ||
    (readableBody && MEETING_INVITE_BODY_RE.test(readableBody))
  ) {
    return true;
  }

  // Requiring two footer signals avoids hiding a real person whose short
  // reply happens to contain a word such as "unsubscribe".
  const massSignalCount = MASS_MAIL_SIGNALS.reduce(
    (count, pattern) => count + (pattern.test(readableBody) ? 1 : 0),
    0,
  );
  return massSignalCount >= 2;
}
