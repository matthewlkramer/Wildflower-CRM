import type { GmailMessage } from "./gmail";
import { getHeader } from "./gmail";

/**
 * Detect whether a Gmail message is a calendar invitation / update /
 * cancellation that should be routed to the skip pile instead of
 * kept on the donor timeline. The Calendar sync already captures the
 * underlying Google Calendar event directly, so duplicating it as a
 * Gmail message would clutter timelines.
 *
 * Detection uses two tiers of signals available at metadata-fetch time
 * (no full body needed):
 *
 *   1. Subject prefix — the most reliable, language-agnostic signal.
 *      Google always prefixes calendar-invite subjects with one of these
 *      exact strings (followed by a colon + space):
 *        "Invitation:", "Updated invitation:", "Canceled:", "Accepted:",
 *        "Declined:", "Tentative:"
 *      Non-Google calendar apps (Outlook, Zoom, etc.) use the same
 *      conventions, so this catches cross-platform invites too.
 *
 *   2. Sender domain — Google's calendar notification domain sends both
 *      invite and organizer-notification emails. Catching this avoids
 *      edge cases where the invite subject is empty or mangled.
 *
 * Note: a `text/calendar` MIME part would be the definitive signal but
 * is not available from the metadata-only fetch. Subject + sender covers
 * the vast majority of real-world calendar mail.
 *
 * Returns true when the message should be skipped (it's a calendar item).
 */

const CALENDAR_SUBJECT_PREFIXES = [
  "invitation:",
  "updated invitation:",
  "canceled:",
  "accepted:",
  "declined:",
  "tentative:",
];

// Only specific calendar-infrastructure domains — NOT the broad google.com
// domain, which would false-positive on legitimate non-calendar mail from
// Google (e.g. Workspace admin notifications, Google Alerts, etc.).
const CALENDAR_SENDER_DOMAINS = new Set([
  "calendar.google.com",
  "calendar-notification.google.com",
]);

const CALENDAR_SENDER_LOCALS = new Set([
  "calendar-notification",
  "noreply-calendar",
]);

export function isCalendarInviteMessage(meta: GmailMessage): boolean {
  const subject = (getHeader(meta.payload, "Subject") ?? "").toLowerCase().trim();
  if (CALENDAR_SUBJECT_PREFIXES.some((prefix) => subject.startsWith(prefix))) {
    return true;
  }

  // Check sender. From header can be "Display Name <addr@domain.com>" or bare.
  const fromRaw = (getHeader(meta.payload, "From") ?? "").toLowerCase();
  const angleMatch = /<([^>]+)>/.exec(fromRaw);
  const fromAddr = angleMatch ? angleMatch[1].trim() : fromRaw.trim();
  const atIdx = fromAddr.lastIndexOf("@");
  if (atIdx >= 0) {
    const local = fromAddr.slice(0, atIdx);
    const domain = fromAddr.slice(atIdx + 1);
    if (
      CALENDAR_SENDER_LOCALS.has(local) ||
      CALENDAR_SENDER_DOMAINS.has(domain)
    ) {
      return true;
    }
  }

  return false;
}
