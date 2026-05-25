import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Per-user suppression list for the "new people you've been emailing"
 * dashboard panel. When the user clicks "Ignore" on an unrecognized
 * correspondent, we insert (mailbox_user_id, email_lower) here so the
 * address never reappears in the panel for that user.
 *
 * Email is stored lowercased — the panel query lowercases the live
 * address before comparing.
 *
 * Scoped per-user rather than globally because what's noise to one
 * fundraiser (an admin assistant they auto-cc) may be a real prospect
 * to another.
 */
export const correspondentIgnore = pgTable(
  "correspondent_ignore",
  {
    mailboxUserId: text("mailbox_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emailLower: text("email_lower").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({
      name: "correspondent_ignore_pk",
      columns: [t.mailboxUserId, t.emailLower],
    }),
  ],
);

export type CorrespondentIgnore = typeof correspondentIgnore.$inferSelect;
export type NewCorrespondentIgnore = typeof correspondentIgnore.$inferInsert;
