import { db } from "@workspace/db";
import { calendarMeetingFilters } from "@workspace/db/schema";
import type { GCalEvent } from "./gcal";

/**
 * Group-meeting suppression helpers.
 *
 * `shouldSuppressMeeting` is a pure function so it can be unit-tested
 * without a DB connection. `loadMeetingFilterConfig` fetches (and
 * auto-provisions, if missing) the singleton config row.
 */

export interface MeetingFilterConfig {
  titlePatterns: string[];
  attendeeCountCutoff: number | null;
}

/**
 * Default config used when the singleton row hasn't been written yet.
 * Matches the DB column defaults so the two stay in sync.
 */
export const DEFAULT_MEETING_FILTER_CONFIG: MeetingFilterConfig = {
  titlePatterns: [
    "all hands",
    "governance mtg",
    "finance meeting",
    "tactical mtg",
    "partner training",
    "board meeting",
    "staff meeting",
    "all-staff",
    "all staff",
  ],
  attendeeCountCutoff: 20,
};

/**
 * Returns true when the calendar event should be suppressed before matching.
 *
 * Suppression triggers when:
 *   1. The event's summary (title) contains any configured keyword
 *      (case-insensitive, substring match), OR
 *   2. The total attendee list length meets or exceeds the configured cutoff.
 */
export function shouldSuppressMeeting(
  event: GCalEvent,
  config: MeetingFilterConfig,
): boolean {
  const summary = (event.summary ?? "").toLowerCase();
  for (const pattern of config.titlePatterns) {
    if (pattern.length > 0 && summary.includes(pattern.toLowerCase())) {
      return true;
    }
  }

  if (config.attendeeCountCutoff !== null && config.attendeeCountCutoff > 0) {
    const count = (event.attendees?.length ?? 0);
    if (count >= config.attendeeCountCutoff) return true;
  }

  return false;
}

/**
 * Fetch the meeting-filter config from the DB. Auto-provisions the
 * singleton row on first call (idempotent ON CONFLICT DO NOTHING).
 */
export async function loadMeetingFilterConfig(): Promise<MeetingFilterConfig> {
  await db
    .insert(calendarMeetingFilters)
    .values({ id: "singleton" })
    .onConflictDoNothing();
  const row = await db
    .select()
    .from(calendarMeetingFilters)
    .where(undefined)
    .then((r) => r[0]);
  if (!row) return DEFAULT_MEETING_FILTER_CONFIG;
  return {
    titlePatterns: row.titlePatterns ?? DEFAULT_MEETING_FILTER_CONFIG.titlePatterns,
    attendeeCountCutoff:
      row.attendeeCountCutoff !== null && row.attendeeCountCutoff !== undefined
        ? row.attendeeCountCutoff
        : DEFAULT_MEETING_FILTER_CONFIG.attendeeCountCutoff,
  };
}
