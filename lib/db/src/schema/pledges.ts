import {
  pgTable,
  text,
  timestamp,
  numeric,
  integer,
  pgEnum,
  boolean,
} from "drizzle-orm/pg-core";
import { fundEnum } from "./users";
import { individuals } from "./individuals";
import { households } from "./households";
import { fundingEntities } from "./fundingEntities";

export const pledgeStatusEnum = pgEnum("pledge_status", [
  "active",
  "completed",
  "revised",
  "defaulted",
]);

export const installmentStatusEnum = pgEnum("installment_status", [
  "scheduled",
  "paid",
  "overdue",
  "waived",
]);

export const pledges = pgTable("pledges", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
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
  totalCommittedAmount: numeric("total_committed_amount", {
    precision: 15,
    scale: 2,
  }).notNull(),
  currency: text("currency").default("USD").notNull(),
  pledgeDate: timestamp("pledge_date").notNull(),
  numberOfInstallments: integer("number_of_installments").default(1).notNull(),
  status: pledgeStatusEnum("status").default("active").notNull(),
  amountReceived: numeric("amount_received", {
    precision: 15,
    scale: 2,
  }).default("0"),
  legalDocumentOnFile: boolean("legal_document_on_file").default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const pledgeInstallments = pgTable("pledge_installments", {
  id: text("id").primaryKey(),
  pledgeId: text("pledge_id")
    .notNull()
    .references(() => pledges.id, { onDelete: "cascade" }),
  installmentNumber: integer("installment_number").notNull(),
  dueDate: timestamp("due_date").notNull(),
  amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
  status: installmentStatusEnum("status").default("scheduled").notNull(),
  paidDate: timestamp("paid_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Pledge = typeof pledges.$inferSelect;
export type NewPledge = typeof pledges.$inferInsert;
export type PledgeInstallment = typeof pledgeInstallments.$inferSelect;
