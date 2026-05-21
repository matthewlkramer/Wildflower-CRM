import { pgTable, text, timestamp, boolean, numeric, date } from "drizzle-orm/pg-core";
import { intendedUsageEnum } from "./_enums";

export const giftAllocations = pgTable("gift_allocations", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  // FK to gifts_and_payments.id (the parent gift this allocation belongs to).
  giftId: text("gift_id"),
  subAmount: numeric("sub_amount", { precision: 14, scale: 2 }),
  grantYearToBookTo: text("grant_year_to_book_to"),
  // FK to entities.id — the fund entity this allocation lands in.
  // (Renamed from the original "recipient" text column.)
  entityId: text("entity_id"),
  // Was this allocation explicitly restricted to a specific region by the
  // funder? (Independent of fund-use restriction.)
  formalRegionalRestriction: boolean("formal_regional_restriction").default(false).notNull(),
  intendedUsage: intendedUsageEnum("intended_usage"),
  // FK to fundable_projects; populated when intendedUsage = 'project'.
  fundableProjectId: text("fundable_project_id"),
  // Was this allocation explicitly restricted to a particular use (e.g.
  // gen_ops vs a named project) by the funder? Orthogonal to the regional
  // restriction above.
  formalFundUseRestriction: boolean("formal_fund_use_restriction").default(false).notNull(),
  schoolRecipientId: text("school_recipient_id"),
  spendingStart: date("spending_start"),
  spendingEnd: date("spending_end"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type GiftAllocation = typeof giftAllocations.$inferSelect;
export type NewGiftAllocation = typeof giftAllocations.$inferInsert;
