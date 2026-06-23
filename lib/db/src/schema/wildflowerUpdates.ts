import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Singleton "Wildflower updates" note.
 *
 * Always exactly one row with id = 'singleton'. This is a single shared,
 * admin-editable free-text note capturing the team's current Wildflower
 * talking points / themes / news. It is fed into the AI prompts that
 * generate donor next-step task suggestions (proposeTask) and
 * email-intelligence action proposals (proposeActions), so suggestions
 * can weave in what the team currently wants to communicate to donors.
 *
 * Out of scope by design: per-region splits, auto-applying edits, and
 * version/diff history. There is only ever one current note; the email
 * `wildflower_update` proposal (note_revision flavor) proposes an edit
 * that a human reviews and accepts to overwrite `content`.
 *
 * Fields:
 *   content          — the current note text (may be empty).
 *   updatedByUserId  — who last saved it (null when never saved / user
 *                      removed).
 */
export const wildflowerUpdates = pgTable("wildflower_updates", {
  id: text("id").primaryKey().default("singleton"),
  content: text("content").notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
});

export type WildflowerUpdates = typeof wildflowerUpdates.$inferSelect;
export type NewWildflowerUpdates = typeof wildflowerUpdates.$inferInsert;
