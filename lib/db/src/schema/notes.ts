import {
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Free-form note attached to one or more CRM entities. Mirrors the
 * `interactions` denormalized link pattern: each linkable entity type
 * gets its own `text[]` array column with a GIN index so detail pages
 * can filter cheaply via `WHERE person_ids @> ARRAY[$1]`.
 *
 * Attachment is explicit and durable — a note never moves automatically
 * if e.g. a person changes employer. Users decide at create-time which
 * entities the note is "about" by ticking them in the dialog.
 *
 * `mentionUserIds` is the set of teammates the author tagged so they
 * see the note in their personal feed. It's a denormalized array (no FK
 * enforcement) for the same reason as the entity link arrays.
 */
export const notes = pgTable(
  "notes",
  {
    id: text("id").primaryKey(),
    body: text("body").notNull(),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    personIds: text("person_ids").array(),
    funderIds: text("funder_ids").array(),
    householdIds: text("household_ids").array(),
    opportunityIds: text("opportunity_ids").array(),
    giftIds: text("gift_ids").array(),
    mentionUserIds: text("mention_user_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("notes_author_user_id_idx").on(t.authorUserId),
    index("notes_created_at_idx").on(t.createdAt),
    index("notes_person_ids_gin_idx").using("gin", t.personIds),
    index("notes_funder_ids_gin_idx").using("gin", t.funderIds),
    index("notes_household_ids_gin_idx").using("gin", t.householdIds),
    index("notes_opportunity_ids_gin_idx").using("gin", t.opportunityIds),
    index("notes_gift_ids_gin_idx").using("gin", t.giftIds),
    index("notes_mention_user_ids_gin_idx").using("gin", t.mentionUserIds),
  ],
);

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
