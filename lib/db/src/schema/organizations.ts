import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { organizationTypeEnum } from "./_enums";

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  name: text("name").notNull(),
  switchToFunder: boolean("switch_to_funder"), // REMOVE THIS FIELD
  type: organizationTypeEnum("type"),
  emailDomain: text("email_domain"),
  orgEmail: text("org_email"), // THIS SHOULD BE A LINK TO THE EMAILS TABLE
  street: text("street"), // THE ADDRESS FIELDS SHOULD BE A LINK TO THE ADDRESSES TABLE
  cityRegionId: text("city_region_id"),
  stateRegionId: text("state_region_id"),
  postalCode: text("postal_code"),
  country: text("country"),
  owner: text("owner"), // SHOULD BE A LINK TO USERS OR SOMETHING LIKE THAT
  tags: text("tags"),
  website: text("website"),
  activeOrDefunct: text("active_or_defunct"),
  otherNames: text("other_names"),
  parentOrgId: text("parent_org_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
