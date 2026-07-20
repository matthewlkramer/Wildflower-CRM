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
import { households } from "./households";
// NOTE: circular table refs (these tables also reference giftsAndPayments). The
// `(): AnyPgColumn =>` lazy callbacks below defer the access until after both
// modules are fully evaluated, so the ESM cycle is safe (same pattern as the
// self-reference on giftBeingMatchedId).
import { stripeStagedCharges } from "./stripeStagedCharges";
import { fundraisingCampaigns } from "./fundraisingCampaigns";

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
  // The campaign this gift came in through (e.g. a Donorbox campaign name,
  // stored WITHOUT the "donorbox campaign: " prefix). Plain text provenance
  // column — retained as-is; the structured FK is campaignSlug below.
  fundraisingCampaign: text("fundraising_campaign"),
  // FK to fundraising_campaigns.slug — the structured campaign record for
  // this gift. Nullable: only populated for gifts linked to a known campaign.
  // SET NULL on delete (deleting a campaign row doesn't delete the gift).
  // ON UPDATE CASCADE so slug renames propagate automatically.
  campaignSlug: text("campaign_slug").references(
    () => fundraisingCampaigns.slug,
    { onDelete: "set null", onUpdate: "cascade" },
  ),
  // ── Revenue Extractor capture (Task #607) ────────────────────────────────
  // Fundraiser-captured inputs that finance keys into QuickBooks. Both are
  // additive/nullable free text with NO effect on derivation / analytics /
  // QuickBooks-tie logic — they are carried through to the Revenue Extractor
  // report so finance has the grant/reference identifier and a memo/description
  // line straight from the gift record.
  //   titleReference — the grant title or reference number ("Title / Reference #").
  //   memoDescription — the memo / description line for the QuickBooks entry.
  titleReference: text("title_reference"),
  memoDescription: text("memo_description"),
  dateReceived: date("date_received"),
  paymentMethod: giftPaymentMethodEnum("payment_method"),
  amount: numeric("amount", { precision: 14, scale: 2 }),
  // TRANSITIONAL (intended for eventual retirement, but STILL LIVE — do NOT
  // drop). The design goal: the human-entered `amount` stays the authoritative
  // donor credit and what actually settled is DERIVED at read time from the
  // gift's linked payments (Stripe / QuickBooks payment_applications / Donorbox)
  // via giftPaymentSummary.ts (`derivedSettledAmount`). That derivation exists,
  // but these provenance columns have NOT been retired yet: QuickBooks matching
  // (routes/quickbooks/matching.ts + actions.ts) still WRITES them when it sets a
  // gift's amount from a staged payment; `finalAmountSource` is still READ by the
  // gifts list filter ("still funding" = final_amount_source = 'human'); and
  // `finalAmountStripeChargeId` is still READ by financialCorrections.ts. Retained
  // so dev push stays additive and prod Publish never auto-drops them; a physical
  // DROP must wait until those readers/writers are removed and ships as a reviewed
  // SQL file.
  originalHumanCrmAmount: numeric("original_human_crm_amount", {
    precision: 14,
    scale: 2,
  }),
  // TRANSITIONAL — still READ by the gifts list filter and still WRITTEN
  // ('quickbooks') by QB matching/actions. See originalHumanCrmAmount above.
  finalAmountSource: giftFinalAmountSourceEnum("final_amount_source")
    .notNull()
    .default("human"),
  /**
   * @deprecated NEVER READ, NEVER WRITTEN. Stripe linkage lives on the counted
   * `payment_applications` ledger (`evidenceSource='stripe'`, `linkRole='counted'`).
   * Backfilled by migration 0130. FK + column kept physical until the reviewed
   * DROP migration ships. Never return this from the API.
   */
  finalAmountStripeChargeId: text("final_amount_stripe_charge_id").references(
    (): AnyPgColumn => stripeStagedCharges.id,
    { onDelete: "restrict" },
  ),
  // NOTE: gifts_and_payments.final_amount_qb_staged_payment_id was DROPPED
  // (migration 0130). QB amount provenance is derived from the counted
  // `payment_applications` ledger (the minting/stamping payment's
  // `created_the_gift` row). Do not reintroduce a gift-pointer column here.

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
  // TRANSITIONAL (intended for eventual retirement, but STILL LIVE — do NOT
  // drop). The design goal is that a gift's classification is DERIVED (pledge
  // payment ⇐ opportunity_id, directed ⇐ advisor_person_id, matching ⇐
  // gift_being_matched_id, loan ⇐ loan_or_grant='loan', else standard — see
  // deriveGiftType in @workspace/api-zod), but the physical column has NOT been
  // retired: it is still READ by the gifts list `type` filter, analytics
  // (routes/analytics.ts), revenueCoding.ts and gatherTaskSignals.ts, and still
  // WRITTEN — copied onto each new row when a gift is split. Retained so dev push
  // stays additive and prod Publish never auto-drops it; a physical DROP must wait
  // until those readers/writers are removed and ships as a reviewed SQL file.
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
  // RETIRED (Task #598): the header `grant_year` column is GONE from the schema.
  // Grant year lives ONLY on gift_allocations.grant_year now — gift create seeds
  // it on the allocation and the split-gift path copies each allocation's own
  // grant year (no header copy remains). Physically dropped from both DBs by
  // migration 0105 AFTER this schema-removal build is Published (the deployed
  // build still SELECTs it via getTableColumns until the new build ships — see
  // the 0105 runbook for the Publish-first ordering).
  // Self-ref to the gift this one matches. SET NULL: deleting the original
  // shouldn't cascade-delete the matching gift; just clear the pointer.
  giftBeingMatchedId: text("gift_being_matched_id").references(
    (): AnyPgColumn => giftsAndPayments.id,
    { onDelete: "set null" },
  ),
  // Audit-close OVER-payment resolution (see gift-booking-lifecycle / audit-close
  // model). When an audited (frozen) gift is over-paid, the original is NEVER
  // touched — a NEW surplus gift is booked in the current OPEN fiscal year and
  // this self-FK points it back at the audited original. The original stays
  // quickbooks_tie_status='amount_mismatch' forever, so the worklist "resolved"
  // test keys off the PRESENCE of an active (non-archived) linked overpay gift.
  // RESTRICT: the audited original must not be deletable out from under its
  // surplus gift. A partial UNIQUE index (WHERE non-null AND archived_at IS NULL)
  // enforces at most one active overpay gift per original.
  overpayOfGiftId: text("overpay_of_gift_id").references(
    (): AnyPgColumn => giftsAndPayments.id,
    { onDelete: "restrict" },
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
  // RETIRED (Task #594): the three legacy header booleans `designated_to_school`,
  // `off_books_fiscal_sponsor`, and `payment_expected` are GONE from the schema.
  // Off-books / payment-exempt is now derived ONLY from the allocation entities
  // (a gift is off-books when it has at least one allocation and EVERY allocation
  // sits on a no-payment entity, entities.expects_payment = false — "Direct to
  // School" / "Wildflower Foundation TSNE"), via giftIsOffBooksExpr()
  // (giftPaymentSummary.ts). The columns are physically dropped from both DBs by
  // migration 0104 AFTER this schema-removal build is Published (the currently-
  // deployed build still SELECTs them via getTableColumns until the new build
  // ships — see the 0104 runbook for the Publish-first deploy ordering).
  // RETIRED (Task #598): the deprecated header `needs_research` boolean is GONE
  // from the schema — superseded by the Cleanup Queue (the derived, read-only
  // `flaggedForResearch` badge from an OPEN cleanup_queue row). It was already
  // stripped from every response projection, so no deployed build selects it.
  // Physically dropped from both DBs by migration 0105 (bundled with grant_year).
  // "Won gift awaiting imminent payment" (bookable-gift SOP). Set when a gift is
  // minted from an opportunity that is expected to settle in cash shortly — the
  // gift briefly has no QuickBooks/Stripe cash tie but that is EXPECTED, not a
  // reconciliation error. While true the gift is excluded from the
  // gifts-missing-qb data-quality worklist so it isn't flagged prematurely.
  // Additive/nullable-defaulted; no side effects on status / QB-tie derivation.
  // It naturally becomes moot once real payment evidence ties the gift.
  awaitingSettlement: boolean("awaiting_settlement").default(false).notNull(),
  // TRANSITIONAL (intended for eventual retirement, but STILL LIVE — do NOT
  // drop). The design goal is to express reconciliation state through the
  // settled-vs-entered queue + the lane model instead of this "tie" signal, but
  // that has NOT happened yet: `applyGiftQbTieMany` (lib/giftQbTie.ts) still
  // RECOMPUTES this column on every gift link/amount/merge/reconcile mutation, and
  // `deriveGiftLanes` (lib/reconciliationLanes.ts) + the gifts list filter still
  // READ it. Retained so dev push stays additive and prod Publish never auto-drops
  // it; a physical DROP must wait until the lane model no longer reads it and ships
  // as a reviewed SQL file.
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
  // ── Grant-letter file (mirrors opportunities_and_pledges.grant_letter_*) ──
  // A grant/award letter uploaded directly onto this gift via object storage
  // (presigned GCS URL → /api/storage/objects/<id>). Distinct from the linked
  // pledge's own grant letter, which the gift page also surfaces read-only.
  // Additive/nullable; NO side effects on status / derivation / QB tie.
  grantLetterUrl: text("grant_letter_url"),
  grantLetterFilename: text("grant_letter_filename"),
  grantLetterUploadedAt: timestamp("grant_letter_uploaded_at", { mode: "string" }),
  // ── Online-source record link (bookable-gift SOP, restriction evidence) ──
  // A link to the external online record this money came from (e.g. a Donorbox
  // donation page, a giving-platform receipt). For a donor_restricted gift the
  // bookable-gift standard requires restriction evidence: EITHER a grant letter
  // (grantLetterUrl) OR this online-source link. Additive/nullable; no side
  // effects on status / derivation / QB tie.
  sourceRecordUrl: text("source_record_url"),
  // ── Thank-you acknowledgement FILE ──
  // A durable copy of the thank-you acknowledgement document, either uploaded
  // directly or copied off the linked thank-you email's attachment when it is
  // marked as the acknowledgement. Independent of thankYouEmailMessageId (which
  // is only a pointer to the source email) so the file survives email purge.
  thankYouLetterUrl: text("thank_you_letter_url"),
  thankYouLetterFilename: text("thank_you_letter_filename"),
  thankYouLetterUploadedAt: timestamp("thank_you_letter_uploaded_at", { mode: "string" }),
  createdAtFromAirtable: timestamp("created_at_from_airtable"),
  updatedAtFromAirtable: timestamp("updated_at_from_airtable"),
  // ── @deprecated coding-form reference columns (RETIRED 2026-07) ──────────
  // The coding-form apply step now appends these values to `tags` as prefixed
  // entries ("Circle: …" / "Series: …" / "Notes: …" / "Memo: …"); existing
  // values were folded into tags by migration 0131. Physical-only: never
  // written, read, or returned. Kept so drizzle push doesn't propose a drop
  // (see post-merge push-abort precedent); do not revive.
  /** @deprecated folded into gifts.tags (0131); physical-only. */
  codingFormCircle: text("coding_form_circle"),
  /** @deprecated folded into gifts.tags (0131); physical-only. */
  codingFormSeries: text("coding_form_series"),
  /** @deprecated folded into gifts.tags (0131); physical-only. */
  codingFormAdditionalNotes: text("coding_form_additional_notes"),
  /** @deprecated folded into gifts.tags (0131); physical-only. */
  codingFormMemo: text("coding_form_memo"),
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
  // At most one ACTIVE (non-archived) surplus gift per audited original.
  uniqueIndex("gifts_and_payments_active_overpay_uq")
    .on(t.overpayOfGiftId)
    .where(sql`${t.overpayOfGiftId} IS NOT NULL AND ${t.archivedAt} IS NULL`),
  index("gifts_and_payments_overpay_of_gift_id_idx").on(t.overpayOfGiftId),
  index("gifts_and_payments_advisor_person_id_idx").on(t.advisorPersonId),
  index("gifts_and_payments_gift_being_matched_id_idx").on(t.giftBeingMatchedId),
  index("gifts_and_payments_primary_contact_person_id_idx").on(t.primaryContactPersonId),
  index("gifts_and_payments_payment_intermediary_id_idx").on(t.paymentIntermediaryId),
  index("gifts_and_payments_owner_user_id_idx").on(t.ownerUserId),
  // Date-range / sort scans (gifts list defaults to date_received DESC, and the
  // analytics fiscal-year buckets filter on date_received). Mirrors the existing
  // index on staged_payments(date_received).
  index("gifts_and_payments_date_received_idx").on(t.dateReceived),
  index("gifts_and_payments_archived_at_idx").on(t.archivedAt),
  // @deprecated index on the retired quickbooks_tie_status column. Kept while the
  // column lingers (deprecate-then-drop); dropped with the column's reviewed SQL.
  index("gifts_and_payments_quickbooks_tie_status_idx").on(t.quickbooksTieStatus),
  index("gifts_and_payments_thank_you_email_msg_idx").on(t.thankYouEmailMessageId),
  index("gifts_and_payments_thank_you_sent_at_idx").on(t.thankYouSentAt),
  index("gifts_and_payments_campaign_slug_idx").on(t.campaignSlug),
  // Donor exclusivity: exactly one of organization / individual-giver / household.
  check(
    "gifts_and_payments_donor_xor",
    sql`num_nonnulls(${t.organizationId}, ${t.individualGiverPersonId}, ${t.householdId}) = 1`,
  ),
  // NOTE: the final-amount provenance XOR CHECK
  // (gifts_and_payments_final_amount_source_ptr) and the two partial-unique
  // provenance indexes were removed here as part of retiring the final-amount
  // model (settled amount is now derived from linked payments). Publish drops
  // them from prod (non-destructive — no data loss).
]);

export type GiftOrPayment = typeof giftsAndPayments.$inferSelect;
export type NewGiftOrPayment = typeof giftsAndPayments.$inferInsert;
