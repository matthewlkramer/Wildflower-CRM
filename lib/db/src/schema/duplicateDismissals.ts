import { pgTable, text, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Pairs an admin has explicitly marked as "not a duplicate" in the
 * potential-duplicates review queue, so the detector never re-surfaces them.
 *
 * `entityType` is 'organization' | 'person'. `idA`/`idB` are the two record
 * ids stored in a canonical order (`idA < idB`, enforced by CHECK) so a pair is
 * recorded once regardless of which side the detector lists first; the unique
 * index then makes a dismissal idempotent.
 *
 * Intentionally NO foreign keys on `idA`/`idB`: they are polymorphic (org OR
 * person) and this is historical review state, not a live relationship — a row
 * left pointing at a since-merged/deleted entity is harmless because that
 * entity can no longer appear as a duplicate candidate. Keeping these as plain
 * text also keeps them out of the `mergeEntities` FK-inventory test, which only
 * tracks live FK references to organizations/people.
 */
export const duplicateDismissals = pgTable(
  "duplicate_dismissals",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    idA: text("id_a").notNull(),
    idB: text("id_b").notNull(),
    dismissedByUserId: text("dismissed_by_user_id"),
    dismissedAt: timestamp("dismissed_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("duplicate_dismissals_pair_unique").on(
      t.entityType,
      t.idA,
      t.idB,
    ),
    check(
      "duplicate_dismissals_entity_type",
      sql`${t.entityType} in ('organization', 'person')`,
    ),
    check("duplicate_dismissals_ordered_pair", sql`${t.idA} < ${t.idB}`),
  ],
);

export type DuplicateDismissalRow = typeof duplicateDismissals.$inferSelect;
export type NewDuplicateDismissalRow = typeof duplicateDismissals.$inferInsert;
