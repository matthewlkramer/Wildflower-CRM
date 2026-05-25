import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

/**
 * A Google Calendar event that the sync worker decided was worth
 * keeping — i.e. at least one non-internal attendee matched a
 * person / funder / household in the CRM.
 *
 * Parallels `email_messages`:
 *
 *   - PK is a synthetic nanoid, not the Gmail/GCal event id, because
 *     two staff members on the same meeting would otherwise collide.
 *     `(calendar_user_id, gcal_calendar_id, gcal_event_id)` is the
 *     real upsert target — unique index below.
 *   - `is_private` mirrors the email privacy model: defaults false;
 *     only the calendar owner can flip it.
 *   - GIN-indexed match arrays support the `WHERE @> ARRAY[$1]`
 *     timeline query pattern used elsewhere in the schema.
 *
 * Calendar-specific notes:
 *
 *   - `status` is Google's raw value ("confirmed" / "tentative" /
 *     "cancelled"). We keep cancelled rows so the timeline can
 *     show "this meeting was cancelled".
 *   - Recurring events: we store each materialised instance the
 *     Calendar API returns. Master events without instances are
 *     skipped at fetch time (singleEvents=true).
 *   - `html_link` is Google's deep-link back into Calendar — the UI
 *     surfaces an "Open in Google Calendar" button using this.
 */
export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: text("id").primaryKey(),
    calendarUserId: text("calendar_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gcalCalendarId: text("gcal_calendar_id").notNull(),
    gcalEventId: text("gcal_event_id").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }),
    summary: text("summary"),
    description: text("description"),
    location: text("location"),
    attendeeEmails: text("attendee_emails").array(),
    organizerEmail: text("organizer_email"),
    status: text("status"),
    htmlLink: text("html_link"),
    isPrivate: boolean("is_private").default(false).notNull(),
    privateSetByUserId: text("private_set_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    matchedPersonIds: text("matched_person_ids").array(),
    matchedFunderIds: text("matched_funder_ids").array(),
    matchedHouseholdIds: text("matched_household_ids").array(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("calendar_events_user_cal_event_uq").on(
      t.calendarUserId,
      t.gcalCalendarId,
      t.gcalEventId,
    ),
    index("calendar_events_user_start_idx").on(t.calendarUserId, t.startAt),
    index("calendar_events_matched_person_ids_idx")
      .using("gin", t.matchedPersonIds)
      .where(sql`${t.matchedPersonIds} is not null`),
    index("calendar_events_matched_funder_ids_idx")
      .using("gin", t.matchedFunderIds)
      .where(sql`${t.matchedFunderIds} is not null`),
    index("calendar_events_matched_household_ids_idx")
      .using("gin", t.matchedHouseholdIds)
      .where(sql`${t.matchedHouseholdIds} is not null`),
  ],
);

export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type NewCalendarEvent = typeof calendarEvents.$inferInsert;
