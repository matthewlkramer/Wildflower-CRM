import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

export const calendarEventArchives = pgTable("calendar_event_archives", {
  physicalEventKey: text("physical_event_key").primaryKey(),
  archivedByUserId: text("archived_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  archivedAt: timestamp("archived_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
