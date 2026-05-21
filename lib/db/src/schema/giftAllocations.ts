import { pgTable, text, timestamp, boolean, numeric, date } from "drizzle-orm/pg-core";

export const giftAllocations = pgTable("gift_allocations", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  giftId: text("gift_id"),
  subAmount: numeric("sub_amount", { precision: 14, scale: 2 }),
  grantYearToBookTo: text("grant_year_to_book_to"),
  recipient: text("recipient"),
  formalRegionalRestriction: boolean("formal_regional_restriction").default(false).notNull(),
  intendedUsage: text("intended_usage"),
  projectName: text("project_name"),
  formalFundUseRestriction: boolean("formal_fund_use_restriction").default(false).notNull(),
  schoolRecipientId: text("school_recipient_id"),
  spendingStart: date("spending_start"),
  spendingEnd: date("spending_end"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type GiftAllocation = typeof giftAllocations.$inferSelect;
export type NewGiftAllocation = typeof giftAllocations.$inferInsert;
