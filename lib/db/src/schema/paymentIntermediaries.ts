import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { paymentIntermediaryTypeEnum } from "./_enums";

// Contact email lives in the `emails` table (FK `payment_intermediary_id`)
// rather than on the row itself.
export const paymentIntermediaries = pgTable("payment_intermediaries", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: paymentIntermediaryTypeEnum("type"),
  // QuickBooks Online Customer Id this payment intermediary maps to. Used to
  // deterministically link incoming QuickBooks payments routed through it.
  quickbooksCustomerId: text("quickbooks_customer_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PaymentIntermediary = typeof paymentIntermediaries.$inferSelect;
export type NewPaymentIntermediary = typeof paymentIntermediaries.$inferInsert;
