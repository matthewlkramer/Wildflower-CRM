/**
 * Minimal RFC 822 / MIME builder for sending a single HTML email through the
 * Gmail API (users.messages.send). We deliberately avoid nodemailer/mailcomposer
 * here — the same way googleOauth.ts avoids the googleapis SDK — because all we
 * need is a single-part `text/html` message with a handful of headers. Keeping
 * it to a few pure functions keeps the server bundle small and the output easy
 * to reason about.
 *
 * What it does NOT handle (by design, for the per-recipient tracking path):
 *   - attachments / multipart bodies — the extension only routes attachment-free
 *     sends through the server, falling back to Gmail's own send otherwise.
 *   - inline (cid:) images.
 */

const CRLF = "\r\n";

/** RFC 2047 "encoded-word" for header values containing non-ASCII. */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const b64 = Buffer.from(value, "utf-8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

/**
 * Format one address for a To/Cc/From header. Accepts either a bare address
 * ("a@b.com") or { email, name }. A display name is RFC 2047 encoded if needed
 * and quoted.
 */
export interface Address {
  email: string;
  name?: string | null;
}

function formatAddress(addr: Address | string): string {
  const a: Address = typeof addr === "string" ? { email: addr } : addr;
  const email = a.email.trim();
  if (!a.name) return email;
  return `${encodeHeaderValue(a.name)} <${email}>`;
}

function formatAddressList(list: ReadonlyArray<Address | string>): string {
  return list.map(formatAddress).join(", ");
}

/** Wrap a base64 payload at 76 chars per RFC 2045. */
function wrapBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join(CRLF);
}

export interface BuildMessageInput {
  from: Address | string;
  to: ReadonlyArray<Address | string>;
  cc?: ReadonlyArray<Address | string>;
  subject: string;
  html: string;
  /** Message-ID(s) for threading a reply. */
  inReplyTo?: string | null;
  references?: string | null;
}

/**
 * Build a complete RFC 822 message (headers + base64 HTML body) and return it
 * base64url-encoded, ready to drop into `{ raw }` for the Gmail send API.
 */
export function buildRawMessage(input: BuildMessageInput): string {
  const headers: string[] = [];
  headers.push(`From: ${formatAddress(input.from)}`);
  headers.push(`To: ${formatAddressList(input.to)}`);
  if (input.cc && input.cc.length > 0) {
    headers.push(`Cc: ${formatAddressList(input.cc)}`);
  }
  headers.push(`Subject: ${encodeHeaderValue(input.subject)}`);
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) headers.push(`References: ${input.references}`);
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/html; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: base64");

  const body = wrapBase64(Buffer.from(input.html, "utf-8").toString("base64"));
  const message = headers.join(CRLF) + CRLF + CRLF + body;

  // Gmail wants base64url (RFC 4648 §5), no padding required but allowed.
  return Buffer.from(message, "utf-8").toString("base64url");
}
