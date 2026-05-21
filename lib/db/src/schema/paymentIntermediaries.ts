import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { paymentIntermediaryTypeEnum } from "./_enums";

export const paymentIntermediaries = pgTable("payment_intermediaries", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  name: text("name").notNull(),
  type: paymentIntermediaryTypeEnum("type"),
  orgEmail: text("org_email"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PaymentIntermediary = typeof paymentIntermediaries.$inferSelect;
export type NewPaymentIntermediary = typeof paymentIntermediaries.$inferInsert;
