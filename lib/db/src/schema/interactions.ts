import {
  index,
  pgTable,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { interactionKindEnum } from "./_enums";
import { users } from "./users";

/**
 * Manually-logged touch-point with a donor: meeting, phone call, video
 * call, conference run-in, etc. Auto-synced Gmail messages and Google
 * Calendar events live in their own tables (coming in a later turn) so
 * we can hold them to different sync/privacy rules without polluting
 * this table.
 *
 * Participants are denormalized as text[] arrays of entity IDs — same
 * pattern the rest of the codebase uses for many-to-many slug links
 * (see e.g. `people.region_ids`). The arrays are GIN-indexed so detail
 * pages can do `WHERE person_ids @> ARRAY[$1]` cheaply. Integrity is
 * enforced at write time by the API layer (no native PG FK on arrays).
 */
export const interactions = pgTable(
  "interactions",
  {
    id: text("id").primaryKey(),
    kind: interactionKindEnum("kind").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes"),
    location: text("location"),
    // One-line title shown in lists. The longer write-up goes in `notes`.
    summary: text("summary").notNull(),
    notes: text("notes"),
    // Who logged the interaction. RESTRICT preserves history when a
    // staff user archives.
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    personIds: text("person_ids").array(),
    funderIds: text("funder_ids").array(),
    householdIds: text("household_ids").array(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("interactions_owner_user_id_idx").on(t.ownerUserId),
    index("interactions_occurred_at_idx").on(t.occurredAt),
    index("interactions_person_ids_gin_idx").using("gin", t.personIds),
    index("interactions_funder_ids_gin_idx").using("gin", t.funderIds),
    index("interactions_household_ids_gin_idx").using("gin", t.householdIds),
  ],
);

export type Interaction = typeof interactions.$inferSelect;
export type NewInteraction = typeof interactions.$inferInsert;
