import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

// Internal "fund entities" — the named pools that opportunities/pledges/gifts
// can be attributed to (Wildflower Foundation, Black Wildflowers Fund, etc.).
// Modeled as a table (not an enum) so new entities can be added through the UI
// without a schema migration.
//
// Multi-entity attribution on opportunities lives in
// `opportunities_and_pledges.entity_ids` (text[] of entity slugs) rather than
// a junction table; gifts and pledge_allocations use a single entity_id FK.
export const entities = pgTable("entities", {
  id: text("id").primaryKey(), // slug-style key, e.g. "wildflower_foundation"
  name: text("name").notNull(),
  active: boolean("active").default(true).notNull(),
  // Visible flag indicating this fund entity is fiscally sponsored. Purely
  // informational on the entity record — it does NOT drive coding rules,
  // analytics, or reconciliation behavior.
  fiscallySponsored: boolean("fiscally_sponsored").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
