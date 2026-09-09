import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * CRM-owned disposition for a synced physical Google Calendar event that does
 * not need meeting notes. It is keyed by gcalEventId rather than a local
 * calendarEvents row because one physical meeting can be synced once per team
 * attendee. Calendar sync never owns or overwrites this decision.
 */
export const meetingNoteDismissals = pgTable(
  "meeting_note_dismissals",
  {
    id: text("id").primaryKey(),
    gcalEventId: text("gcal_event_id").notNull(),
    dismissedByUserId: text("dismissed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("meeting_note_dismissals_gcal_event_uq").on(table.gcalEventId),
    index("meeting_note_dismissals_user_idx").on(table.dismissedByUserId),
  ],
);

export type MeetingNoteDismissal = typeof meetingNoteDismissals.$inferSelect;
export type NewMeetingNoteDismissal = typeof meetingNoteDismissals.$inferInsert;
