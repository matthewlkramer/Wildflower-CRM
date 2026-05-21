import { pgTable, text, timestamp, boolean, primaryKey } from "drizzle-orm/pg-core";

// Internal "fund entities" — the named pools that opportunities/pledges/gifts
// can be attributed to (Wildflower Foundation, Black Wildflowers Fund, etc.).
// Modeled as a table (not an enum) so new entities can be added through the UI
// without a schema migration.
export const entities = pgTable("entities", {
  id: text("id").primaryKey(), // slug-style key, e.g. "wildflower_foundation"
  name: text("name").notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Opportunities can be split across multiple entities (matches the source
// Airtable, where the field is multi-select). Gifts and pledge_allocations
// use a single entity_id FK instead.
export const opportunityEntities = pgTable(
  "opportunity_entities",
  {
    opportunityId: text("opportunity_id").notNull(),
    entityId: text("entity_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.opportunityId, t.entityId] })],
);

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
