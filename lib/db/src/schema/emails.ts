import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { contactValidityEnum, emailTypeEnum } from "./_enums";

export const emails = pgTable("emails", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  type: emailTypeEnum("type"),
  // An email may belong to a person, a funder, an organization, a payment
  // intermediary, or a household. Exactly one of these should normally be set.
  personId: text("person_id"),
  funderId: text("funder_id"),
  organizationId: text("organization_id"),
  paymentIntermediaryId: text("payment_intermediary_id"),
  householdId: text("household_id"),
  validity: contactValidityEnum("validity").default("unknown").notNull(),
  isPreferred: boolean("is_preferred").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Email = typeof emails.$inferSelect;
export type NewEmail = typeof emails.$inferInsert;
