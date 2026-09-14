import {
  boolean,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users";

// CRM-owned attendance survives refreshes of the Google invitation list.
export const calendarEventAttendance = pgTable(
  "calendar_event_attendance",
  {
    physicalEventKey: text("physical_event_key").notNull(),
    emailAddress: text("email_address").notNull(),
    absent: boolean("absent").notNull().default(false),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.physicalEventKey, t.emailAddress] })],
);
