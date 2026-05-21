import { pgTable, text, timestamp, boolean, numeric, date } from "drizzle-orm/pg-core";
import { intendedUsageEnum } from "./_enums";

export const giftAllocations = pgTable("gift_allocations", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  giftId: text("gift_id"), // THIS IS THE FK TO THE GIFT TABLE
  subAmount: numeric("sub_amount", { precision: 14, scale: 2 }),
  grantYearToBookTo: text("grant_year_to_book_to"),
  recipient: text("recipient"),
  formalRegionalRestriction: boolean("formal_regional_restriction").default(false).notNull(),
  intendedUsage: intendedUsageEnum("intended_usage"),
  // FK to fundable_projects; populated when intendedUsage = 'project'.
  fundableProjectId: text("fundable_project_id"),
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
