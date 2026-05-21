import { pgTable, text, timestamp, boolean, numeric, date } from "drizzle-orm/pg-core";

export const giftsAndPayments = pgTable("gifts_and_payments", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  legacyGiftId: text("legacy_gift_id"),
  name: text("name"),
  details: text("details"),
  dateReceived: date("date_received"),
  paymentMethod: text("payment_method"),
  amount: numeric("amount", { precision: 14, scale: 2 }),
  funderId: text("funder_id"),
  individualGiverPersonId: text("individual_giver_person_id"),
  type: text("type"),
  paymentOnPledgeId: text("payment_on_pledge_id"),
  advisorPersonId: text("advisor_person_id"),
  grantYear: text("grant_year"),
  giftBeingMatchedId: text("gift_being_matched_id"),
  primaryContactPersonId: text("primary_contact_person_id"),
  paymentIntermediaryId: text("payment_intermediary_id"),
  owner: text("owner"),
  closeDate: date("close_date"),
  completedDate: date("completed_date"),
  allocationType: text("allocation_type"),
  entity: text("entity"),
  intendedUsage: text("intended_usage"),
  designatedToSchool: boolean("designated_to_school").default(false).notNull(),
  schoolRecipientId: text("school_recipient_id"),
  spendingStartDate: date("spending_start_date"),
  spendingEndDate: date("spending_end_date"),
  tags: text("tags"),
  createdAtFromAirtable: timestamp("created_at_from_airtable"),
  updatedAtFromAirtable: timestamp("updated_at_from_airtable"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type GiftOrPayment = typeof giftsAndPayments.$inferSelect;
export type NewGiftOrPayment = typeof giftsAndPayments.$inferInsert;
