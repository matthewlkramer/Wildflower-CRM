import {
  type AnyPgColumn,
  check,
  index,
  pgTable,
  text,
  timestamp,
  boolean,
  numeric,
  date,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  giftTypeEnum,
  giftPaymentMethodEnum,
} from "./_enums";
import { organizations } from "./organizations";
import { people } from "./people";
import { opportunitiesAndPledges } from "./opportunitiesAndPledges";
import { paymentIntermediaries } from "./paymentIntermediaries";
import { users } from "./users";
import { fiscalYears } from "./fiscalYears";
import { households } from "./households";

// Header-only row for an actual gift / payment. Like opportunities, all
// scope (which fund entity, which fiscal year, which regions, which
// intended usage / fundable project, and per-line sub-amounts) lives one
// level down in `gift_allocations`. Every gift should have at least one
// gift_allocations row; a one-line gift carries a single row whose
// sub_amount equals the gift's amount.
export const giftsAndPayments = pgTable("gifts_and_payments", {
  id: text("id").primaryKey(),
  legacyGiftId: text("legacy_gift_id"),
  name: text("name"),
  details: text("details"),
  dateReceived: date("date_received"),
  paymentMethod: giftPaymentMethodEnum("payment_method"),
  amount: numeric("amount", { precision: 14, scale: 2 }),
  // Processor fee withheld from this gift (e.g. Stripe's per-charge fee). The
  // donor is ALWAYS credited the GROSS `amount`; this column records the fee so
  // net (= amount − processor_fee) can be DERIVED for payout / bank-deposit
  // reconciliation. Never stored as a separate net column to avoid drift. NULL
  // for gifts with no processor fee (checks, wires, manual entries, and
  // QuickBooks-sourced gifts).
  processorFee: numeric("processor_fee", { precision: 14, scale: 2 }),
  // RESTRICT: the organization is the giver of record.
  organizationId: text("organization_id").references(() => organizations.id, {
    onDelete: "restrict",
  }),
  // RESTRICT: the individual giver is part of the money-trail record.
  individualGiverPersonId: text("individual_giver_person_id").references(
    () => people.id,
    { onDelete: "restrict" },
  ),
  // RESTRICT: a household giver (joint checking / joint card) is part of the
  // money-trail record. Convention: exactly one of {organizationId,
  // individualGiverPersonId, householdId} is set per row.
  householdId: text("household_id").references(() => households.id, {
    onDelete: "restrict",
  }),
  type: giftTypeEnum("type"),
  // RESTRICT: a payment must keep its link to the pledge it pays.
  paymentOnPledgeId: text("payment_on_pledge_id").references(
    () => opportunitiesAndPledges.id,
    { onDelete: "restrict" },
  ),
  // SET NULL: advisor is a soft pointer.
  advisorPersonId: text("advisor_person_id").references(() => people.id, {
    onDelete: "set null",
  }),
  // FK to fiscal_years.id (slug, e.g. 'fy2024'). Single fiscal year per
  // gift/payment; if a single org check legitimately covers multiple FY
  // bookings, split it across multiple gift_allocations rows.
  grantYear: text("grant_year").references(() => fiscalYears.id, {
    onDelete: "restrict",
  }),
  // Self-ref to the gift this one matches. SET NULL: deleting the original
  // shouldn't cascade-delete the matching gift; just clear the pointer.
  giftBeingMatchedId: text("gift_being_matched_id").references(
    (): AnyPgColumn => giftsAndPayments.id,
    { onDelete: "set null" },
  ),
  // SET NULL: primary contact is a soft pointer.
  primaryContactPersonId: text("primary_contact_person_id").references(
    () => people.id,
    { onDelete: "set null" },
  ),
  // RESTRICT: the intermediary (DAF/giving platform) is part of the
  // financial record.
  paymentIntermediaryId: text("payment_intermediary_id").references(
    () => paymentIntermediaries.id,
    { onDelete: "restrict" },
  ),
  // RESTRICT + archive workflow on users.
  ownerUserId: text("owner_user_id").references(() => users.id, {
    onDelete: "restrict",
  }),
  designatedToSchool: boolean("designated_to_school").default(false).notNull(),
  tags: text("tags"),
  // Set when an outbound staff email is linked as the thank-you note for
  // this gift — either via the email-intelligence proposal accept flow
  // or via the manual "Link thank-you email" button on the gift detail
  // page. `thankYouSentAt` is denormalised from emailMessages.sentAt at
  // link time so the gifts list can sort/filter by acknowledgment date
  // without joining email_messages. Both go back to null on unlink.
  thankYouSentAt: date("thank_you_sent_at"),
  // SET NULL: if the source email message is ever purged from the sync
  // store, keep the thankYouSentAt date but drop the now-stale pointer.
  // The link is updateable from the gift page so a wrong auto-link
  // can be relinked to the correct message.
  thankYouEmailMessageId: text("thank_you_email_message_id"),
  createdAtFromAirtable: timestamp("created_at_from_airtable"),
  updatedAtFromAirtable: timestamp("updated_at_from_airtable"),
  // Soft-delete: non-null = archived (hidden from non-admins). Financial
  // records aren't hard-deleted; archiving hides them from default views.
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("gifts_and_payments_organization_id_idx").on(t.organizationId),
  index("gifts_and_payments_individual_giver_person_id_idx").on(t.individualGiverPersonId),
  index("gifts_and_payments_household_id_idx").on(t.householdId),
  index("gifts_and_payments_payment_on_pledge_id_idx").on(t.paymentOnPledgeId),
  index("gifts_and_payments_advisor_person_id_idx").on(t.advisorPersonId),
  index("gifts_and_payments_gift_being_matched_id_idx").on(t.giftBeingMatchedId),
  index("gifts_and_payments_primary_contact_person_id_idx").on(t.primaryContactPersonId),
  index("gifts_and_payments_payment_intermediary_id_idx").on(t.paymentIntermediaryId),
  index("gifts_and_payments_owner_user_id_idx").on(t.ownerUserId),
  index("gifts_and_payments_grant_year_idx").on(t.grantYear),
  index("gifts_and_payments_archived_at_idx").on(t.archivedAt),
  index("gifts_and_payments_thank_you_email_msg_idx").on(t.thankYouEmailMessageId),
  index("gifts_and_payments_thank_you_sent_at_idx").on(t.thankYouSentAt),
  // Donor exclusivity: exactly one of organization / individual-giver / household.
  check(
    "gifts_and_payments_donor_xor",
    sql`num_nonnulls(${t.organizationId}, ${t.individualGiverPersonId}, ${t.householdId}) = 1`,
  ),
]);

export type GiftOrPayment = typeof giftsAndPayments.$inferSelect;
export type NewGiftOrPayment = typeof giftsAndPayments.$inferInsert;
