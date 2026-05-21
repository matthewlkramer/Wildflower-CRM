import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const addresses = pgTable("addresses", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  street: text("street"),
  cityRegionId: text("city_region_id"),
  stateRegionId: text("state_region_id"),
  postalCode: text("postal_code"),
  country: text("country"),
  personId: text("person_id"),
  funderId: text("funder_id"),
  organizationId: text("organization_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;
