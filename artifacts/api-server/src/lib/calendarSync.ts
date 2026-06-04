import { db } from "@workspace/db";
import {
  calendarEvents,
  calendarSyncState,
  type CalendarSyncState,
} from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { newId } from "./helpers";
import {
  listEvents,
  extractAttendeeEmails,
  eventTimes,
  CalendarSyncTokenGoneError,
  type GCalEvent,
} from "./gcal";
import { getValidGoogleAccessTokenForUser, type ActiveGoogleGrant } from "./googleTokenStore";
import { matchEmails, isMatchEmpty } from "./emailMatcher";
import { shouldSuppressMeeting, loadMeetingFilterConfig, type MeetingFilterConfig } from "./calendarMeetingFilter";

/**
 * Per-user Google Calendar sync orchestrator.
 *
 * Modes (gated on `state.bootstrap_completed_at`):
 *
 *   1. Bootstrap — `events.list` over the entire calendar history
 *      (no `timeMin`), paginated. We want every meeting the user has
 *      ever attended in the CRM interactions log, so the bootstrap
 *      sweep is intentionally unbounded. Capped at
 *      BOOTSTRAP_MAX_PAGES_PER_RUN per run; pending
 *      pageToken goes into `bootstrap_page_token`. When fully
 *      drained we write the final response's `nextSyncToken` into
 *      `sync_token` and flip `bootstrap_completed_at`.
 *
 *   2. Incremental — `events.list?syncToken=<saved>`, paginated.
 *      Capped at INCR_MAX_PAGES_PER_RUN; pending pageToken goes into
 *      `incremental_page_token`. Crucially, `sync_token` is only
 *      replaced when a full drain completes with zero per-event
 *      errors — same rationale as Gmail's `last_history_id`. On
 *      `CalendarSyncTokenGoneError` we clear the token + bootstrap
 *      marker and re-bootstrap next run.
 *
 * Per-event pipeline (`processOneEvent`):
 *   a. Resolve attendee emails (organizer + attendees, lowercased,
 *      deduped). Drop owner + @wildflowerschools.org via the
 *      shared `matchEmails` matcher.
 *   b. If unmatched → silently skip. Calendar doesn't need a skip
 *      table — `syncToken` only re-emits a given event when Google
 *      thinks it changed.
 *   c. If matched → upsert into `calendar_events` via ON CONFLICT
 *      DO UPDATE on the (calendar_user_id, gcal_calendar_id,
 *      gcal_event_id) unique index. Update touches mutable fields
 *      (summary/description/start/end/status/attendees/matches);
 *      privacy + audit columns are NOT overwritten so a manual
 *      privacy flip survives a sync.
 *
 * Failure semantics match Gmail's: a per-event error increments
 * `report.errors`, the failing page's token is stashed, and the
 * outer sync_token / sync cursor is NOT advanced. Next run replays
 * the same page — Calendar's `syncToken` semantics keep replaying
 * the failed deltas until the token is consumed cleanly.
 */

const BOOTSTRAP_PAGE_SIZE = 250;
const BOOTSTRAP_MAX_PAGES_PER_RUN = 4;
const INCR_MAX_PAGES_PER_RUN = 10;

export interface CalendarSyncReport {
  mode: "bootstrap" | "incremental" | "rebootstrap";
  candidates: number;
  matched: number;
  updated: number;
  skipped: number;
  errors: number;
  bootstrapCompleted: boolean;
  hasSyncToken: boolean;
}

export interface CalendarSyncOutcome {
  ok: boolean;
  notConnected?: boolean;
  error?: string;
  report?: CalendarSyncReport;
}

export async function syncUserCalendar(userId: string): Promise<CalendarSyncOutcome> {
  const grant = await getValidGoogleAccessTokenForUser(userId);
  if (!grant) {
    return { ok: false, notConnected: true };
  }

  // Race-safe state row provisioning.
  await db
    .insert(calendarSyncState)
    .values({ calendarUserId: userId })
    .onConflictDoNothing();
  const state = await db
    .select()
    .from(calendarSyncState)
    .where(eq(calendarSyncState.calendarUserId, userId))
    .then((r) => r[0]);
  if (!state) {
    return { ok: false, error: "Failed to provision calendar sync state row" };
  }

  try {
    const report: CalendarSyncReport = {
      mode: state.bootstrapCompletedAt ? "incremental" : "bootstrap",
      candidates: 0,
      matched: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      bootstrapCompleted: !!state.bootstrapCompletedAt,
      hasSyncToken: !!state.syncToken,
    };

    // Load the meeting-filter config once per sync run (not per event)
    // so every event in this run uses the same snapshot of the config.
    let meetingFilterConfig: MeetingFilterConfig;
    try {
      meetingFilterConfig = await loadMeetingFilterConfig();
    } catch (e) {
      logger.warn({ err: e, userId }, "Failed to load meeting filter config; using defaults");
      meetingFilterConfig = {
        titlePatterns: ["all hands", "governance mtg", "finance meeting", "tactical mtg", "partner training", "board meeting", "staff meeting", "all-staff", "all staff"],
        attendeeCountCutoff: 20,
      };
    }

    if (!state.bootstrapCompletedAt) {
      await runBootstrapPass(grant, state, report, meetingFilterConfig);
    } else if (state.syncToken) {
      try {
        await runIncrementalPass(grant, state, report, meetingFilterConfig);
      } catch (e) {
        if (e instanceof CalendarSyncTokenGoneError) {
          report.mode = "rebootstrap";
          await db
            .update(calendarSyncState)
            .set({
              syncToken: null,
              bootstrapCompletedAt: null,
              bootstrapPageToken: null,
              incrementalPageToken: null,
              lastError: "Calendar sync token expired; re-bootstrapping on next run",
              lastSyncedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(calendarSyncState.calendarUserId, userId));
          return { ok: true, report };
        }
        throw e;
      }
    } else {
      // bootstrap_completed but no syncToken — degenerate state.
      // Re-bootstrap rather than risk re-fetching all of history.
      report.mode = "rebootstrap";
      await db
        .update(calendarSyncState)
        .set({
          bootstrapCompletedAt: null,
          bootstrapPageToken: null,
          incrementalPageToken: null,
          updatedAt: new Date(),
        })
        .where(eq(calendarSyncState.calendarUserId, userId));
    }
    void meetingFilterConfig; // used above, referenced to avoid unused-var lint

    await db
      .update(calendarSyncState)
      .set({
        lastSyncedAt: new Date(),
        lastError: report.errors > 0
          ? `${report.errors} event(s) failed; will retry next run`
          : null,
        updatedAt: new Date(),
      })
      .where(eq(calendarSyncState.calendarUserId, userId));

    return { ok: true, report };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: e, userId }, "Calendar sync run failed");
    await db
      .update(calendarSyncState)
      .set({ lastError: msg, lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(calendarSyncState.calendarUserId, userId));
    return { ok: false, error: msg };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Pass implementations
// ──────────────────────────────────────────────────────────────────────────

async function runBootstrapPass(
  grant: ActiveGoogleGrant,
  state: CalendarSyncState,
  report: CalendarSyncReport,
  meetingFilterConfig: MeetingFilterConfig,
): Promise<void> {
  // Anchor at the Unix epoch so we fetch the entire calendar history.
  // We can't simply omit `timeMin` — with `singleEvents=true` (which
  // we need to flatten recurring masters into instances), Google
  // requires `timeMin` + `orderBy=startTime` for stable pagination;
  // without them the API rejects subsequent page tokens with
  // "Invalid page token value." Page caps + the in-process scheduler
  // drain large calendars over multiple runs without blowing Google
  // quota.
  const BOOTSTRAP_TIME_MIN = "1970-01-01T00:00:00Z";
  let pageToken: string | null = state.bootstrapPageToken ?? null;
  let pagesProcessed = 0;
  let drained = false;
  let finalSyncToken: string | null = null;

  while (pagesProcessed < BOOTSTRAP_MAX_PAGES_PER_RUN) {
    const currentPageToken: string | null = pageToken;
    const page = await listEvents(grant.accessToken, state.gcalCalendarId, {
      timeMin: BOOTSTRAP_TIME_MIN,
      pageToken: currentPageToken,
      maxResults: BOOTSTRAP_PAGE_SIZE,
    });
    pagesProcessed++;

    let pageErrors = 0;
    report.candidates += page.items.length;
    for (const ev of page.items) {
      const ok = await processOneEvent(grant, state.gcalCalendarId, ev, report, meetingFilterConfig);
      if (!ok) pageErrors++;
    }
    report.errors += pageErrors;

    if (pageErrors > 0) {
      // Hold cursor at the token that produced this failing page.
      await db
        .update(calendarSyncState)
        .set({
          bootstrapPageToken: currentPageToken,
          updatedAt: new Date(),
        })
        .where(eq(calendarSyncState.calendarUserId, grant.userId));
      return;
    }

    finalSyncToken = page.nextSyncToken ?? finalSyncToken;
    if (!page.nextPageToken) {
      drained = true;
      break;
    }
    pageToken = page.nextPageToken;
  }

  if (drained) {
    // Bootstrap fully exhausted with zero errors. Google only
    // supplies nextSyncToken on the FINAL page of a paginated
    // sweep, so finalSyncToken must be set here — but guard anyway,
    // since an empty calendar still returns one.
    await db
      .update(calendarSyncState)
      .set({
        bootstrapCompletedAt: new Date(),
        bootstrapPageToken: null,
        syncToken: finalSyncToken,
        updatedAt: new Date(),
      })
      .where(eq(calendarSyncState.calendarUserId, grant.userId));
    report.bootstrapCompleted = true;
    report.hasSyncToken = !!finalSyncToken;
  } else {
    await db
      .update(calendarSyncState)
      .set({
        bootstrapPageToken: pageToken,
        updatedAt: new Date(),
      })
      .where(eq(calendarSyncState.calendarUserId, grant.userId));
  }
}

async function runIncrementalPass(
  grant: ActiveGoogleGrant,
  state: CalendarSyncState,
  report: CalendarSyncReport,
  meetingFilterConfig: MeetingFilterConfig,
): Promise<void> {
  const startSyncToken = state.syncToken!;
  let pageToken: string | null = state.incrementalPageToken ?? null;
  let pagesProcessed = 0;
  let drained = false;
  let newSyncToken: string | null = null;

  while (pagesProcessed < INCR_MAX_PAGES_PER_RUN) {
    const currentPageToken: string | null = pageToken;
    // Per the Calendar API contract ("All other query parameters
    // provided to list MUST be identical to those in the initial
    // request"), every paginated request — including the resumed
    // one we make off a stored `incremental_page_token` — must
    // carry the same `syncToken` value the chain started with.
    // Stripping syncToken on subsequent pages would either 400 or
    // silently degrade into a full-fetch (depending on Google's
    // mood that day).
    const page = await listEvents(grant.accessToken, state.gcalCalendarId, {
      syncToken: startSyncToken,
      pageToken: currentPageToken,
      maxResults: BOOTSTRAP_PAGE_SIZE,
    });
    pagesProcessed++;

    let pageErrors = 0;
    report.candidates += page.items.length;
    for (const ev of page.items) {
      const ok = await processOneEvent(grant, state.gcalCalendarId, ev, report, meetingFilterConfig);
      if (!ok) pageErrors++;
    }
    report.errors += pageErrors;

    if (pageErrors > 0) {
      // Stash this page's token so we replay it; do NOT advance
      // syncToken — Google will keep re-emitting the same deltas
      // until our next attempt consumes them cleanly.
      await db
        .update(calendarSyncState)
        .set({
          incrementalPageToken: currentPageToken,
          updatedAt: new Date(),
        })
        .where(eq(calendarSyncState.calendarUserId, grant.userId));
      return;
    }

    newSyncToken = page.nextSyncToken ?? newSyncToken;
    if (!page.nextPageToken) {
      drained = true;
      break;
    }
    pageToken = page.nextPageToken;
  }

  if (drained) {
    if (newSyncToken) {
      await db
        .update(calendarSyncState)
        .set({
          syncToken: newSyncToken,
          incrementalPageToken: null,
          updatedAt: new Date(),
        })
        .where(eq(calendarSyncState.calendarUserId, grant.userId));
      report.hasSyncToken = true;
    } else {
      // Drained but no nextSyncToken means Google didn't tell us
      // we're caught up — shouldn't happen, but clear the page
      // token so we don't loop on it next run.
      await db
        .update(calendarSyncState)
        .set({ incrementalPageToken: null, updatedAt: new Date() })
        .where(eq(calendarSyncState.calendarUserId, grant.userId));
    }
  } else {
    await db
      .update(calendarSyncState)
      .set({
        incrementalPageToken: pageToken,
        updatedAt: new Date(),
      })
      .where(eq(calendarSyncState.calendarUserId, grant.userId));
  }
}

/**
 * Returns true on successful processing (matched + upserted, or
 * unmatched + silently skipped). Returns false on a per-event
 * error worth retrying — the pass-level loop uses this to gate
 * cursor advancement.
 */
async function processOneEvent(
  grant: ActiveGoogleGrant,
  calendarId: string,
  event: GCalEvent,
  report: CalendarSyncReport,
  meetingFilterConfig: MeetingFilterConfig,
): Promise<boolean> {
  const { startAt, endAt } = eventTimes(event);
  if (!startAt) {
    // Event with no resolvable start time — Google occasionally
    // sends these for deletions of recurring instances without a
    // start. Treat as skip; not a retryable error.
    report.skipped++;
    return true;
  }

  // Group-meeting suppression: skip large internal meetings
  // (by title keyword or attendee count) before any CRM matching.
  // Also delete any existing stored row — the filter config may have
  // been updated after the event was first synced.
  if (shouldSuppressMeeting(event, meetingFilterConfig)) {
    await db
      .delete(calendarEvents)
      .where(
        and(
          eq(calendarEvents.calendarUserId, grant.userId),
          eq(calendarEvents.gcalCalendarId, calendarId),
          eq(calendarEvents.gcalEventId, event.id),
        ),
      );
    report.skipped++;
    return true;
  }

  const attendeeEmails = extractAttendeeEmails(event);
  let match;
  try {
    match = await matchEmails(attendeeEmails, grant.googleEmail, startAt);
  } catch (e) {
    logger.warn(
      { err: e, userId: grant.userId, eventId: event.id },
      "Calendar matcher query failed",
    );
    return false;
  }

  if (isMatchEmpty(match)) {
    // Unmatched — silently skip. Calendar's syncToken won't replay
    // this unless Google decides it changed, so no skip table is
    // needed (unlike Gmail).
    report.skipped++;
    return true;
  }

  try {
    // ON CONFLICT DO UPDATE — calendars update events in place
    // (start moves, attendees join/leave). Privacy + audit
    // columns are explicitly NOT in the set list so a user's
    // manual privacy flip survives the next sync.
    const upserted = await db
      .insert(calendarEvents)
      .values({
        id: newId(),
        calendarUserId: grant.userId,
        gcalCalendarId: calendarId,
        gcalEventId: event.id,
        startAt,
        endAt,
        summary: event.summary ?? null,
        description: event.description ?? null,
        location: event.location ?? null,
        attendeeEmails,
        organizerEmail: event.organizer?.email?.toLowerCase() ?? null,
        status: event.status ?? null,
        htmlLink: event.htmlLink ?? null,
        matchedPersonIds: match.personIds,
        matchedOrganizationIds: match.organizationIds,
        matchedHouseholdIds: match.householdIds,
      })
      .onConflictDoUpdate({
        target: [
          calendarEvents.calendarUserId,
          calendarEvents.gcalCalendarId,
          calendarEvents.gcalEventId,
        ],
        set: {
          startAt,
          endAt,
          summary: event.summary ?? null,
          description: event.description ?? null,
          location: event.location ?? null,
          attendeeEmails,
          organizerEmail: event.organizer?.email?.toLowerCase() ?? null,
          status: event.status ?? null,
          htmlLink: event.htmlLink ?? null,
          matchedPersonIds: match.personIds,
          matchedOrganizationIds: match.organizationIds,
          matchedHouseholdIds: match.householdIds,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: calendarEvents.id,
        // Postgres internal: `xmax` on the visible tuple of a
        // RETURNING clause is 0 iff the row was just INSERTed and
        // non-zero iff it was UPDATEd (because UPDATE writes a
        // new heap tuple whose xmax records the locking xid).
        // Deterministic — no timestamp-skew sensitivity like the
        // first cut had.
        wasInsert: sql<boolean>`(xmax = 0)`.as("was_insert"),
      });

    const row = upserted[0];
    if (row) {
      if (row.wasInsert) report.matched++;
      else report.updated++;
    }
    return true;
  } catch (e) {
    logger.warn(
      { err: e, userId: grant.userId, eventId: event.id },
      "Failed to upsert calendar event; will retry next sync",
    );
    return false;
  }
}

