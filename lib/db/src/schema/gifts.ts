import {
  pgTable,
  text,
  timestamp,
  numeric,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";
import { fundEnum } from "./users";
import { individuals } from "./individuals";
import { households } from "./households";
import { fundingEntities } from "./fundingEntities";
import { pledges } from "./pledges";

export const paymentMethodEnum = pgEnum("payment_method", [
  "check",
  "wire",
  "ach",
  "credit_card",
  "stock",
  "daf_grant",
  "in_kind",
  "other",
]);

export const gifts = pgTable("gifts", {
  id: text("id").primaryKey(),
  fund: fundEnum("fund").notNull(),
  individualId: text("individual_id").references(() => individuals.id, {
    onDelete: "set null",
  }),
  householdId: text("household_id").references(() => households.id, {
    onDelete: "set null",
  }),
  fundingEntityId: text("funding_entity_id").references(
    () => fundingEntities.id,
    { onDelete: "set null" },
  ),
  pledgeId: text("pledge_id").references(() => pledges.id, {
    onDelete: "set null",
  }),
  amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
  cashReceivedDate: timestamp("cash_received_date").notNull(),
  paymentMethod: paymentMethodEnum("payment_method"),
  checkNumber: text("check_number"),
  reconciled: boolean("reconciled").default(false),
  directToSchoolPassthrough: boolean("direct_to_school_passthrough").default(
    false,
  ),
  softCreditIndividualId: text("soft_credit_individual_id").references(
    () => individuals.id,
    { onDelete: "set null" },
  ),
  softCreditNotes: text("soft_credit_notes"),
  fiscalYear: text("fiscal_year"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Gift = typeof gifts.$inferSelect;
export type NewGift = typeof gifts.$inferInsert;
