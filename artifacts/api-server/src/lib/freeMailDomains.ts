/**
 * Single source of truth for "free-mail" / consumer email domains.
 *
 * Pure and dependency-light on purpose: no DB, no network, no DOM / node /
 * URL globals. Both the email-intelligence detectors (intelDetectors.ts) and
 * the CRM matcher (emailMatcher.ts) import from here so the "kept in sync"
 * invariant can no longer drift — a domain on this list is never treated as a
 * whole-organization matching domain, and senders on these domains are filtered
 * out of the unrecognized-correspondent panel.
 */
export const FREE_MAIL_DOMAINS = new Set([
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
