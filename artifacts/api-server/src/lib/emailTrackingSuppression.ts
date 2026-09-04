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

function currentHtmlText(html: string | null): string {
  if (!html) return "";
  const withoutQuotedThread = html
    .replace(
      /<div[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>[\s\S]*$/i,
      "",
    )
    .replace(/<blockquote\b[^>]*>[\s\S]*$/i, "");
  return stripQuotedText(stripHtml(withoutQuotedThread));
}

/**
 * Whether an otherwise CRM-matched inbound message belongs in the human
 * follow-up queue. This intentionally does not decide whether the message is
 * worth retaining on a CRM timeline; ingestion has a broader relevance bar.
 */
export function shouldSuppressInboundTrackingMessage(
  message: InboundTrackingMessage,
): boolean {
  const readableBody =
    stripQuotedText(message.bodyText ?? "") ||
    currentHtmlText(message.bodyHtml) ||
    stripQuotedText(message.snippet ?? "") ||
    message.aiSummary?.trim() ||
    "";
  const bodyText = readableBody || null;

  if (isAutoResponder(message.subject, bodyText)) return true;
  if (isBulkSender(message.fromEmail, bodyText, message.bodyHtml)) return true;
  if (message.subject && MACHINE_SUBJECT_RE.test(message.subject)) return true;

  if (readableBody && MACHINE_BODY_RE.test(readableBody)) return true;

  // Requiring two footer signals avoids hiding a real person whose short
  // reply happens to contain a word such as "unsubscribe".
  const massSignalCount = MASS_MAIL_SIGNALS.reduce(
    (count, pattern) => count + (pattern.test(readableBody) ? 1 : 0),
    0,
  );
  return massSignalCount >= 2;
}
