import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Singleton configuration table for calendar group-meeting suppression.
 *
 * Always exactly one row with id = 'singleton'. The API GET endpoint
 * auto-inserts the defaults if no row exists yet.
 *
 * Fields:
 *   title_patterns       — case-insensitive substring keywords; a calendar
 *                          event whose summary matches ANY of these is
 *                          suppressed regardless of attendee count.
 *                          Seeds: ["all hands", "governance mtg",
 *                          "finance meeting", "tactical mtg",
 *                          "partner training", "board meeting",
 *                          "staff meeting", "all-staff", "all staff"]
 *
 *   attendee_count_cutoff — suppress any event whose total attendee list
 *                           length meets or exceeds this number. null =
 *                           attendee-count suppression disabled.
 *                           Seed: 20
 */
export const calendarMeetingFilters = pgTable("calendar_meeting_filters", {
  id: text("id").primaryKey().default("singleton"),
  titlePatterns: text("title_patterns")
    .array()
    .notNull()
    .default(
      sql`ARRAY['all hands','governance mtg','finance meeting','tactical mtg','partner training','board meeting','staff meeting','all-staff','all staff']::text[]`,
    ),
  attendeeCountCutoff: integer("attendee_count_cutoff").default(20),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type CalendarMeetingFilters = typeof calendarMeetingFilters.$inferSelect;
export type NewCalendarMeetingFilters = typeof calendarMeetingFilters.$inferInsert;
