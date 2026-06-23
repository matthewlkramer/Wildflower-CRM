import {
  type AnyPgColumn,
  check,
  index,
  uniqueIndex,
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
  giftFinalAmountSourceEnum,
  giftQuickbooksTieEnum,
  loanOrGrantEnum,
} from "./_enums";
import { organizations } from "./organizations";
import { people } from "./people";
import { opportunitiesAndPledges } from "./opportunitiesAndPledges";
import { paymentIntermediaries } from "./paymentIntermediaries";
import { users } from "./users";
import { fiscalYears } from "./fiscalYears";
import { households } from "./households";
// NOTE: circular table refs (these tables also reference giftsAndPayments). The
// `(): AnyPgColumn =>` lazy callbacks below defer the access until after both
// modules are fully evaluated, so the ESM cycle is safe (same pattern as the
// self-reference on giftBeingMatchedId).
import { stripeStagedCharges } from "./stripeStagedCharges";
import { stagedPayments } from "./stagedPayments";

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
  // ── Final-amount provenance ─────────────────────────────────────────
  // `amount` above is the REAL, FINAL amount of this gift and remains the one
  // field every downstream rollup reads. These columns record WHERE that final
  // amount came from, so the CRM gift (the single source of truth) stays tied
  // forever to its reconciliation evidence (a Stripe charge / a QuickBooks
  // staged row) WITHOUT that evidence ever becoming a second gift.
  //
  // Snapshot of the human-entered amount BEFORE any processor reconciliation
  // overwrote `amount`. Backfilled = `amount` for every pre-existing gift; NULL
  // only for a future gift minted directly from a payment (no human amount ever
  // existed). Lets the UI show "you entered $X, Stripe says $Y".
  originalHumanCrmAmount: numeric("original_human_crm_amount", {
    precision: 14,
    scale: 2,
  }),
  // Where `amount` was last sourced from (see giftFinalAmountSourceEnum). XOR
  // with the two pointer columns below, enforced by the CHECK constraint.
  finalAmountSource: giftFinalAmountSourceEnum("final_amount_source")
    .notNull()
    .default("human"),
  // Provenance pointer: the Stripe charge this gift's amount was stamped from
  // (gross). RESTRICT — the evidence backing a gift's amount is permanent and
  // can't be deleted out from under the gift.
  finalAmountStripeChargeId: text("final_amount_stripe_charge_id").references(
    (): AnyPgColumn => stripeStagedCharges.id,
    { onDelete: "restrict" },
  ),
  // Provenance pointer: the QuickBooks staged row this gift's amount was stamped
  // from (only when there is no Stripe charge). RESTRICT — see above.
  finalAmountQbStagedPaymentId: text(
    "final_amount_qb_staged_payment_id",
  ).references((): AnyPgColumn => stagedPayments.id, { onDelete: "restrict" }),
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
  // Authoritative loan-vs-grant flag (see loanOrGrantEnum). Backfilled from
  // `type` (loan_fund_investment→loan, else grant) plus explicit data
  // corrections, and dual-written whenever `type` changes during the
  // transition. Becomes the single loan signal (replacing the
  // type='loan_fund_investment' read) once the parity-gated read cutover lands.
  // Default 'grant' (non-destructive); auto-minted QB/Stripe/Donorbox gifts are
  // never loans so the default is correct for them.
  loanOrGrant: loanOrGrantEnum("loan_or_grant").notNull().default("grant"),
  // RESTRICT: a payment must keep its link to the opportunity/pledge it pays.
  // Renamed from payment_on_pledge_id — the link is now generic (a gift may be
  // linked to any opportunity, not only a committed pledge); presence of this
  // link is what distinguishes a pledge payment from a direct one-off gift.
  opportunityId: text("opportunity_id").references(
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
  // Fiscal-sponsor-era off-books flag. When a gift was handled off our books
  // (e.g. during the fiscal-sponsor period), it never appears in QuickBooks.
  // Together with `designatedToSchool` (direct-to-school) it forms the
  // "exempt from QB tie" rule: such gifts still count toward revenue goals but
  // are not expected to reconcile to a QuickBooks record (and are excluded from
  // the audit-reconciliation view). User-settable.
  offBooksFiscalSponsor: boolean("off_books_fiscal_sponsor")
    .default(false)
    .notNull(),
  // When false, no QuickBooks/QBO record will ever arrive for this gift (e.g.
  // early gifts handled through the fiscal sponsor, or money paid directly to a
  // school/charter). Folds into the "exempt from QB tie" rule alongside
  // offBooksFiscalSponsor / designatedToSchool, so such gifts stop being flagged
  // as "missing" QuickBooks evidence. Defaults true (almost every gift expects a
  // payment). User-settable.
  paymentExpected: boolean("payment_expected").default(true).notNull(),
  // When false, this is real money that should NOT count against fundraising
  // goals (e.g. CMO replication grant reimbursements that don't cover core
  // expenses) — it is excluded from the goal/received analytics rollups.
  // Orthogonal to paymentExpected. Defaults true. User-settable.
  countsTowardGoal: boolean("counts_toward_goal").default(true).notNull(),
  // Plain human-set flag: a fundraiser/finance reviewer hasn't fully figured
  // this money record out yet (unknown donor, ambiguous coding, unclear
  // restriction, etc.) and wants to come back to it. Never auto-derived and has
  // NO side effects on status / derivation / QB tie — a pure annotation.
  needsResearch: boolean("needs_research").default(false).notNull(),
  // Derived, persisted signal of whether this gift reconciles to a QuickBooks
  // record (see giftQuickbooksTieEnum). Recomputed by applyGiftQbTieMany at
  // every gift link/amount mutation; never hand-set. Defaults to 'missing'
  // (an on-books gift with no QB evidence yet) and is corrected on first derive.
  quickbooksTieStatus: giftQuickbooksTieEnum("quickbooks_tie_status")
    .default("missing")
    .notNull(),
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
  index("gifts_and_payments_opportunity_id_idx").on(t.opportunityId),
  index("gifts_and_payments_advisor_person_id_idx").on(t.advisorPersonId),
  index("gifts_and_payments_gift_being_matched_id_idx").on(t.giftBeingMatchedId),
  index("gifts_and_payments_primary_contact_person_id_idx").on(t.primaryContactPersonId),
  index("gifts_and_payments_payment_intermediary_id_idx").on(t.paymentIntermediaryId),
  index("gifts_and_payments_owner_user_id_idx").on(t.ownerUserId),
  index("gifts_and_payments_grant_year_idx").on(t.grantYear),
  // Date-range / sort scans (gifts list defaults to date_received DESC, and the
  // analytics fiscal-year buckets filter on date_received). Mirrors the existing
  // index on staged_payments(date_received).
  index("gifts_and_payments_date_received_idx").on(t.dateReceived),
  index("gifts_and_payments_archived_at_idx").on(t.archivedAt),
  // Backs the missing-evidence list filter on the derived QB-tie signal.
  index("gifts_and_payments_quickbooks_tie_status_idx").on(t.quickbooksTieStatus),
  // Partial-UNIQUE: a Stripe charge / QB staged row is the FINAL-amount source
  // pointer for AT MOST ONE gift (the one-evidence↔one-gift invariant). WHERE
  // NOT NULL so the many unstamped `human` gifts (pointer NULL) are unconstrained.
  uniqueIndex("gifts_and_payments_final_amount_stripe_charge_id_idx")
    .on(t.finalAmountStripeChargeId)
    .where(sql`${t.finalAmountStripeChargeId} IS NOT NULL`),
  uniqueIndex("gifts_and_payments_final_amount_qb_staged_payment_id_idx")
    .on(t.finalAmountQbStagedPaymentId)
    .where(sql`${t.finalAmountQbStagedPaymentId} IS NOT NULL`),
  index("gifts_and_payments_thank_you_email_msg_idx").on(t.thankYouEmailMessageId),
  index("gifts_and_payments_thank_you_sent_at_idx").on(t.thankYouSentAt),
  // Donor exclusivity: exactly one of organization / individual-giver / household.
  check(
    "gifts_and_payments_donor_xor",
    sql`num_nonnulls(${t.organizationId}, ${t.individualGiverPersonId}, ${t.householdId}) = 1`,
  ),
  // Final-amount provenance XOR: human ⇒ no pointer; stripe ⇒ stripe pointer
  // only; quickbooks ⇒ qb pointer only.
  check(
    "gifts_and_payments_final_amount_source_ptr",
    sql`(
      (${t.finalAmountSource} = 'human' AND ${t.finalAmountStripeChargeId} IS NULL AND ${t.finalAmountQbStagedPaymentId} IS NULL)
      OR (${t.finalAmountSource} = 'stripe' AND ${t.finalAmountStripeChargeId} IS NOT NULL AND ${t.finalAmountQbStagedPaymentId} IS NULL)
      OR (${t.finalAmountSource} = 'quickbooks' AND ${t.finalAmountQbStagedPaymentId} IS NOT NULL AND ${t.finalAmountStripeChargeId} IS NULL)
    )`,
  ),
]);

export type GiftOrPayment = typeof giftsAndPayments.$inferSelect;
export type NewGiftOrPayment = typeof giftsAndPayments.$inferInsert;
