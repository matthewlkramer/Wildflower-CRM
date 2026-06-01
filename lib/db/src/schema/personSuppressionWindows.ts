import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { people } from "./people";

/**
 * Per-person email/calendar sync suppression windows.
 *
 * When a window row covers a given message/event date, all email
 * addresses belonging to that person are excluded from matching — they
 * won't appear in matched_person_ids, so the message/event only reaches
 * the donor timeline if another participant (funder domain, household, etc.)
 * still matches.
 *
 * Window semantics:
 *   - start_date = null  → window has no lower bound (always applies from
 *                          the beginning of time up to end_date)
 *   - end_date   = null  → window has no upper bound (open-ended, always
 *                          applies from start_date onward)
 *   - Both null          → suppress this person's addresses at all times
 *
 * A date D is covered by a window when:
 *   (start_date IS NULL OR start_date <= D)
 *   AND (end_date IS NULL OR end_date >= D)
 *
 * Typical use-case: a person who is or was a Wildflower staff member. Set
 * start_date = their first day, end_date = their last day. Their personal
 * email (which would otherwise match as a donor) is suppressed during their
 * employment but kept outside that window.
 *
 * A person can have more than one window (e.g. two separate stints).
 */
export const personSuppressionWindows = pgTable(
  "person_suppression_windows",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    startDate: timestamp("start_date", { withTimezone: true, mode: "date" }),
    endDate: timestamp("end_date", { withTimezone: true, mode: "date" }),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("person_suppression_windows_person_id_idx").on(t.personId),
  ],
);

export type PersonSuppressionWindow = typeof personSuppressionWindows.$inferSelect;
export type NewPersonSuppressionWindow = typeof personSuppressionWindows.$inferInsert;
