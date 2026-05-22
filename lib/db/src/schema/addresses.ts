import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { regions } from "./regions";
import { people } from "./people";
import { funders } from "./funders";
import { organizations } from "./organizations";
import { paymentIntermediaries } from "./paymentIntermediaries";
import { households } from "./households";

export const addresses = pgTable(
  "addresses",
  {
    id: text("id").primaryKey(),
    street: text("street"),
    // SET NULL: a region delete shouldn't kill the address; the address
    // still has a street + postal code, just loses the region link.
    cityRegionId: text("city_region_id").references(() => regions.id, {
      onDelete: "set null",
    }),
    // Denormalized convenience copies, populated by the importer via lookup
    // against the regions table (region.name for city, region.state_abbreviation
    // for state code). Reads on addresses don't need a join for display.
    cityName: text("city_name"),
    stateRegionId: text("state_region_id").references(() => regions.id, {
      onDelete: "set null",
    }),
    stateCode: text("state_code"),
    postalCode: text("postal_code"),
    country: text("country"),
    // Exactly one of the five owner FKs is set (enforced by CHECK below).
    // CASCADE: deleting the owning entity removes its address rows.
    personId: text("person_id").references(() => people.id, {
      onDelete: "cascade",
    }),
    funderId: text("funder_id").references(() => funders.id, {
      onDelete: "cascade",
    }),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    paymentIntermediaryId: text("payment_intermediary_id").references(
      () => paymentIntermediaries.id,
      { onDelete: "cascade" },
    ),
    householdId: text("household_id").references(() => households.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    check(
      "addresses_exactly_one_owner",
      sql`num_nonnulls(${t.personId}, ${t.funderId}, ${t.organizationId}, ${t.paymentIntermediaryId}, ${t.householdId}) = 1`,
    ),
  ],
);

export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;
