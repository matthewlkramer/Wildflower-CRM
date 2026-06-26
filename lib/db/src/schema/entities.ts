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
  // Whether money allocated to this entity is ever expected to settle through a
  // payment processor / QuickBooks. FALSE for "pass-through" entities where the
  // CRM never sees a payment record: "Direct to School" (money paid straight to
  // a school/charter without passing through us) and "Wildflower Foundation
  // TSNE" (the fiscal-sponsor / off-books era). A gift expects payment unless
  // ALL of its allocations land on entities with expectsPayment = false; such
  // gifts are excluded from the settled-vs-entered reconciliation queue (the way
  // the old off-books / designated-to-school "exempt" rule worked). Defaults
  // true — almost every entity expects a payment.
  expectsPayment: boolean("expects_payment").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
