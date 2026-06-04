/**
 * Retroactive cleanup: re-applies all three suppression rules to existing
 * email_messages and calendar_events in the database.
 *
 *   Step 1 — Person suppression windows
 *     Remove suppressed person IDs from matched_person_ids arrays in
 *     email_messages and calendar_events that fall within the window date.
 *     Calendar events that become fully-unmatched have their arrays set to null
 *     (consistent with forward sync — events stay for audit but lose matches).
 *     Email messages that become fully-unmatched are moved to email_sync_skip
 *     and deleted from email_messages (cascade removes attachments), matching
 *     the live skip-table semantics for unmatched mail.
 *
 *   Step 2 — Calendar group-meeting suppression
 *     Uses the same `loadMeetingFilterConfig` as live sync (auto-provisions
 *     defaults when no row exists) and deletes calendar_events whose summary
 *     matches a title pattern or whose attendee count meets/exceeds the cutoff.
 *
 *   Step 3 — Gmail calendar-invite email cleanup
 *     Finds email_messages whose subject or stored sender matches the same
 *     signals used by `isCalendarInviteMessage` (subject prefixes + calendar
 *     sender domains/locals). Moves them to email_sync_skip then deletes.
 *
 * Idempotent — safe to re-run. Prints a row-count summary when done.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run backfill:sync-suppression
 */
import { db } from "@workspace/db";
import {
  personSuppressionWindows,
  emailMessages,
  emailSyncSkip,
  calendarEvents,
} from "@workspace/db/schema";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import {
  loadMeetingFilterConfig,
  shouldSuppressMeeting,
} from "../lib/calendarMeetingFilter";

// ─── shared helpers ───────────────────────────────────────────────────────────

interface SuppressionWindow {
  personId: string;
  startDate: Date | null;
  endDate: Date | null;
}

/**
 * Returns true when `date` falls within the suppression window.
 * Comparison is day-level (midnight UTC) so end-date is inclusive for the
 * full calendar day — mirrors the live sync fix in emailMatcher.ts.
 */
function windowCoversDate(w: SuppressionWindow, date: Date): boolean {
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  if (w.startDate) {
    const ws = new Date(w.startDate);
    ws.setUTCHours(0, 0, 0, 0);
    if (dayStart < ws) return false;
  }
  if (w.endDate) {
    const we = new Date(w.endDate);
    we.setUTCHours(0, 0, 0, 0);
    if (dayStart > we) return false;
  }
  return true;
}

/**
 * Insert into email_sync_skip (ON CONFLICT DO NOTHING) then delete the
 * email_messages row.  Cascades to email_attachments via FK.
 */
async function moveEmailToSkip(row: {
  id: string;
  mailboxUserId: string;
  gmailMessageId: string;
  subject: string | null;
  sentAt: Date;
  fromEmail: string | null;
}): Promise<void> {
  await db
    .insert(emailSyncSkip)
    .values({
      mailboxUserId: row.mailboxUserId,
      gmailMessageId: row.gmailMessageId,
      subject: row.subject ?? null,
      sentAt: row.sentAt,
      fromAddrs: row.fromEmail ? [row.fromEmail] : [],
      toAddrs: [],
      ccAddrs: [],
      bccAddrs: [],
    })
    .onConflictDoNothing();
  await db.delete(emailMessages).where(eq(emailMessages.id, row.id));
}

// ─── Step 1: person suppression windows ──────────────────────────────────────

async function backfillPersonWindows(): Promise<void> {
  const windows = await db
    .select({
      personId: personSuppressionWindows.personId,
      startDate: personSuppressionWindows.startDate,
      endDate: personSuppressionWindows.endDate,
    })
    .from(personSuppressionWindows);

  if (windows.length === 0) {
    console.log("[Step 1] No suppression windows found — skipping.");
    return;
  }
  console.log(`[Step 1] Found ${windows.length} suppression window(s).`);

  const suppressedPersonIds = [...new Set(windows.map((w) => w.personId))];

  // ── email_messages ──
  const emailRows = await db
    .select({
      id: emailMessages.id,
      mailboxUserId: emailMessages.mailboxUserId,
      gmailMessageId: emailMessages.gmailMessageId,
      subject: emailMessages.subject,
      sentAt: emailMessages.sentAt,
      fromEmail: emailMessages.fromEmail,
      matchedPersonIds: emailMessages.matchedPersonIds,
      matchedOrganizationIds: emailMessages.matchedOrganizationIds,
      matchedHouseholdIds: emailMessages.matchedHouseholdIds,
    })
    .from(emailMessages)
    .where(
      and(
        isNotNull(emailMessages.matchedPersonIds),
        sql`${emailMessages.matchedPersonIds} && ARRAY[${sql.join(
          suppressedPersonIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[]`,
      ),
    );

  let emailMoved = 0;
  let emailUpdated = 0;
  for (const row of emailRows) {
    const original = row.matchedPersonIds ?? [];
    const cleaned = original.filter(
      (pid) => !windows.some((w) => w.personId === pid && windowCoversDate(w, row.sentAt)),
    );
    if (cleaned.length === original.length) continue;

    // Only move to skip when ALL three match dimensions are empty — an email
    // matched to a funder or household that also happens to include a suppressed
    // person must stay in email_messages with its person array trimmed.
    const hasFunderMatch = (row.matchedOrganizationIds ?? []).length > 0;
    const hasHouseholdMatch = (row.matchedHouseholdIds ?? []).length > 0;
    const fullyUnmatched = cleaned.length === 0 && !hasFunderMatch && !hasHouseholdMatch;

    if (fullyUnmatched) {
      // No remaining matches — move to skip table, delete from email_messages.
      await moveEmailToSkip(row);
      emailMoved++;
    } else {
      await db
        .update(emailMessages)
        .set({ matchedPersonIds: cleaned.length > 0 ? cleaned : null })
        .where(eq(emailMessages.id, row.id));
      emailUpdated++;
    }
  }
  console.log(
    `[Step 1] Email messages: checked ${emailRows.length}, ` +
      `moved to skip ${emailMoved}, partial-updated ${emailUpdated}.`,
  );

  // ── calendar_events ──
  const calRows = await db
    .select({
      id: calendarEvents.id,
      startAt: calendarEvents.startAt,
      matchedPersonIds: calendarEvents.matchedPersonIds,
    })
    .from(calendarEvents)
    .where(
      and(
        isNotNull(calendarEvents.matchedPersonIds),
        sql`${calendarEvents.matchedPersonIds} && ARRAY[${sql.join(
          suppressedPersonIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[]`,
      ),
    );

  let calUpdated = 0;
  for (const row of calRows) {
    const original = row.matchedPersonIds ?? [];
    const cleaned = original.filter(
      (pid) => !windows.some((w) => w.personId === pid && windowCoversDate(w, row.startAt)),
    );
    if (cleaned.length !== original.length) {
      // Calendar events stay in the table even when fully unmatched — no skip
      // table for calendar (consistent with forward sync behaviour).
      await db
        .update(calendarEvents)
        .set({ matchedPersonIds: cleaned.length > 0 ? cleaned : null })
        .where(eq(calendarEvents.id, row.id));
      calUpdated++;
    }
  }
  console.log(
    `[Step 1] Calendar events: checked ${calRows.length}, updated ${calUpdated}.`,
  );
}

// ─── Step 2: calendar group-meeting suppression ───────────────────────────────

async function backfillCalendarMeetingFilter(): Promise<void> {
  // Uses the same auto-provisioning loader as live sync — if the singleton row
  // doesn't exist yet it creates it and returns the built-in defaults, so this
  // step never silently skips because of a missing config row.
  const config = await loadMeetingFilterConfig();

  if (config.titlePatterns.length === 0 && config.attendeeCountCutoff === null) {
    console.log("[Step 2] Calendar meeting filter has no rules — skipping.");
    return;
  }

  console.log(
    `[Step 2] Calendar meeting filter: ${config.titlePatterns.length} title pattern(s), ` +
      `attendee cutoff=${config.attendeeCountCutoff ?? "none"}.`,
  );

  const allEvents = await db
    .select({
      id: calendarEvents.id,
      gcalEventId: calendarEvents.gcalEventId,
      summary: calendarEvents.summary,
      attendeeEmails: calendarEvents.attendeeEmails,
    })
    .from(calendarEvents);

  const toDelete: string[] = [];
  for (const row of allEvents) {
    const fakeEvent = {
      id: row.gcalEventId,
      summary: row.summary ?? undefined,
      attendees: (row.attendeeEmails ?? []).map((email: string) => ({ email })),
    };
    if (shouldSuppressMeeting(fakeEvent, config)) {
      toDelete.push(row.id);
    }
  }

  if (toDelete.length === 0) {
    console.log(
      `[Step 2] Checked ${allEvents.length} calendar event(s) — none matched suppression rules.`,
    );
    return;
  }

  // Delete in batches of 500 to avoid huge IN lists.
  const BATCH = 500;
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const batch = toDelete.slice(i, i + BATCH);
    await db
      .delete(calendarEvents)
      .where(
        sql`${calendarEvents.id} = ANY(ARRAY[${sql.join(
          batch.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[])`,
      );
    deleted += batch.length;
  }
  console.log(
    `[Step 2] Checked ${allEvents.length} calendar event(s), deleted ${deleted} suppressed.`,
  );
}

// ─── Step 3: Gmail calendar-invite email cleanup ──────────────────────────────

// Keep in sync with calendarInviteDetector.ts.
const INVITE_SUBJECT_PREFIXES = [
  "invitation:",
  "updated invitation:",
  "canceled:",
  "accepted:",
  "declined:",
  "tentative:",
];
// Sender domain signals (only specific calendar infrastructure subdomains).
const CALENDAR_SENDER_DOMAINS = new Set([
  "calendar.google.com",
  "calendar-notification.google.com",
]);
// Sender local-part signals (before the @).
const CALENDAR_SENDER_LOCALS = new Set([
  "calendar-notification",
  "noreply-calendar",
]);

/** Returns true when the stored fromEmail matches a calendar sender signal. */
function isCalendarSender(fromEmail: string | null): boolean {
  if (!fromEmail) return false;
  const lower = fromEmail.toLowerCase();
  // Strip RFC 5322 display-name wrapping, e.g. "Google Calendar <addr@domain>"
  const match = lower.match(/<([^>]+)>$/);
  const addr = match ? match[1]! : lower;
  const atIdx = addr.lastIndexOf("@");
  if (atIdx === -1) return false;
  const local = addr.slice(0, atIdx);
  const domain = addr.slice(atIdx + 1);
  return CALENDAR_SENDER_DOMAINS.has(domain) || CALENDAR_SENDER_LOCALS.has(local);
}

/** Returns true when the email looks like a calendar invite by subject or sender. */
function isInviteRow(subject: string | null, fromEmail: string | null): boolean {
  const subjectLower = (subject ?? "").toLowerCase().trim();
  if (INVITE_SUBJECT_PREFIXES.some((p) => subjectLower.startsWith(p))) return true;
  return isCalendarSender(fromEmail);
}

async function backfillCalendarInviteEmails(): Promise<void> {
  // Pre-filter with a broad SQL condition combining all signals; the JS
  // `isInviteRow` predicate then re-checks each row precisely.
  const prefixConditions = INVITE_SUBJECT_PREFIXES.map(
    (p) => sql`lower(${emailMessages.subject}) like ${p + "%"}`,
  );
  const domainConditions = [...CALENDAR_SENDER_DOMAINS].map(
    (d) => sql`lower(${emailMessages.fromEmail}) like ${"%" + "@" + d}`,
  );
  const localConditions = [...CALENDAR_SENDER_LOCALS].map(
    (l) => sql`lower(${emailMessages.fromEmail}) like ${l + "@%"}`,
  );
  const whereClause = sql`(${sql.join(
    [...prefixConditions, ...domainConditions, ...localConditions],
    sql` OR `,
  )})`;

  const candidates = await db
    .select({
      id: emailMessages.id,
      mailboxUserId: emailMessages.mailboxUserId,
      gmailMessageId: emailMessages.gmailMessageId,
      subject: emailMessages.subject,
      sentAt: emailMessages.sentAt,
      fromEmail: emailMessages.fromEmail,
    })
    .from(emailMessages)
    .where(whereClause);

  // Final JS predicate mirrors the live isCalendarInviteMessage logic exactly.
  const inviteRows = candidates.filter((r) => isInviteRow(r.subject, r.fromEmail));

  if (inviteRows.length === 0) {
    console.log("[Step 3] No calendar-invite email messages found — skipping.");
    return;
  }

  console.log(`[Step 3] Found ${inviteRows.length} calendar-invite email message(s) to clean up.`);

  let moved = 0;
  for (const row of inviteRows) {
    await moveEmailToSkip(row);
    moved++;
  }

  console.log(
    `[Step 3] Moved ${moved} calendar-invite email(s) to skip table and deleted from email_messages.`,
  );
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Backfill sync suppression rules ===");

  await backfillPersonWindows();
  await backfillCalendarMeetingFilter();
  await backfillCalendarInviteEmails();

  console.log("=== Backfill complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
