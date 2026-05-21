import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import {
  entityRoleTypeEnum,
  peopleRoleCurrentEnum,
  peopleEntityRoleConnectionEnum,
} from "./_enums";

export const peopleEntityRoles = pgTable("people_entity_roles", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  personId: text("person_id").notNull(),
  entityType: entityRoleTypeEnum("entity_type").notNull(),
  funderId: text("funder_id"),
  organizationId: text("organization_id"),
  paymentIntermediaryId: text("payment_intermediary_id"),
  householdId: text("household_id"),
  connection: peopleEntityRoleConnectionEnum("connection"),
  notes: text("notes"),
  externalTitleOrRole: text("external_title_or_role"),
  current: peopleRoleCurrentEnum("current").default("current").notNull(),
  primaryContact: boolean("primary_contact").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PeopleEntityRole = typeof peopleEntityRoles.$inferSelect;
export type NewPeopleEntityRole = typeof peopleEntityRoles.$inferInsert;
