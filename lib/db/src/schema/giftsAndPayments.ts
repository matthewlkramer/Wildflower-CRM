import { pgTable, text, timestamp, boolean, numeric, date } from "drizzle-orm/pg-core";
import {
  giftTypeEnum,
  giftPaymentMethodEnum,
  giftAllocationTypeEnum,
  intendedUsageEnum,
} from "./_enums";

export const giftsAndPayments = pgTable("gifts_and_payments", {
  id: text("id").primaryKey(),
  legacyGiftId: text("legacy_gift_id"),
  name: text("name"),
  details: text("details"),
  dateReceived: date("date_received"),
  paymentMethod: giftPaymentMethodEnum("payment_method"),
  amount: numeric("amount", { precision: 14, scale: 2 }),
  funderId: text("funder_id"),
  individualGiverPersonId: text("individual_giver_person_id"),
  type: giftTypeEnum("type"),
  paymentOnPledgeId: text("payment_on_pledge_id"),
  advisorPersonId: text("advisor_person_id"),
  grantYear: text("grant_year"),
  giftBeingMatchedId: text("gift_being_matched_id"),
  primaryContactPersonId: text("primary_contact_person_id"),
  paymentIntermediaryId: text("payment_intermediary_id"),
  // FK to users.id — team member who owns this gift/payment.
  ownerUserId: text("owner_user_id"),
  closeDate: date("close_date"), // RENAME THIS TO BE PROJECTED CLOSE DATE AND THE NEXT FIELD TO ACTUAL COMPLETION DATE
  completedDate: date("completed_date"),
  allocationType: giftAllocationTypeEnum("allocation_type"),
  entityId: text("entity_id"),
  intendedUsage: intendedUsageEnum("intended_usage"),
  // FK to fundable_projects; populated when intendedUsage = 'project'.
  fundableProjectId: text("fundable_project_id"),
  designatedToSchool: boolean("designated_to_school").default(false).notNull(),
  schoolRecipientId: text("school_recipient_id"),
  spendingStartDate: date("spending_start_date"),
  spendingEndDate: date("spending_end_date"),
  // Array of regions.id values the gift is designated to (was the
  // gift_regional_designation junction table).
  regionIds: text("region_ids").array(),
  tags: text("tags"),
  createdAtFromAirtable: timestamp("created_at_from_airtable"),
  updatedAtFromAirtable: timestamp("updated_at_from_airtable"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type GiftOrPayment = typeof giftsAndPayments.$inferSelect;
export type NewGiftOrPayment = typeof giftsAndPayments.$inferInsert;
