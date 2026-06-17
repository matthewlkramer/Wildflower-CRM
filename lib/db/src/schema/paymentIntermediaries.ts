import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { paymentIntermediaryTypeEnum } from "./_enums";

// Contact email lives in the `emails` table (FK `payment_intermediary_id`)
// rather than on the row itself.
export const paymentIntermediaries = pgTable(
  "payment_intermediaries",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: paymentIntermediaryTypeEnum("type"),
    // QuickBooks Online Customer Id this payment intermediary maps to. Used to
    // deterministically link incoming QuickBooks payments routed through it.
    quickbooksCustomerId: text("quickbooks_customer_id"),
    // Soft-delete: non-null = archived (hidden from non-admins). Replaces hard
    // delete; only admins can view/restore archived rows.
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("payment_intermediaries_archived_at_idx").on(t.archivedAt)],
);

export type PaymentIntermediary = typeof paymentIntermediaries.$inferSelect;
export type NewPaymentIntermediary = typeof paymentIntermediaries.$inferInsert;
