import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const addresses = pgTable("addresses", {
  id: text("id").primaryKey(),
  street: text("street"),
  cityRegionId: text("city_region_id"),
  // Denormalized convenience copies, populated by the importer via lookup
  // against the regions table (region.name for city, region.state_abbreviation
  // for state code). Reads on addresses don't need a join for display.
  cityName: text("city_name"),
  stateRegionId: text("state_region_id"),
  stateCode: text("state_code"),
  postalCode: text("postal_code"),
  country: text("country"),
  // An address may belong to a person, a funder, an organization, a payment
  // intermediary, or a household. Exactly one of these should normally be set.
  personId: text("person_id"),
  funderId: text("funder_id"),
  organizationId: text("organization_id"),
  paymentIntermediaryId: text("payment_intermediary_id"),
  householdId: text("household_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;
