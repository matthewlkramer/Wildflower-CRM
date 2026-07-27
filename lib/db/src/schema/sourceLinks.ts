import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { stripeStagedCharges } from "./stripeStagedCharges";
import { stagedPayments } from "./stagedPayments";
import { donorboxDonations } from "./donorboxDonations";
import { bankTransactions } from "./bankTransactions";
import { bankDeposits } from "./bankDeposits";
import { paymentUnits } from "./paymentUnits";
import { stripePayouts } from "./stripePayouts";
import { giftsAndPayments } from "./giftsAndPayments";
import { users } from "./users";
import {
  sourceLinkTypeEnum,
  sourceLinkLifecycleEnum,
  sourceLinkProvenanceEnum,
  sourceLinkMatchBasisEnum,
} from "./_enums";

/**
 * The unit-grain **evidence ↔ evidence claim ledger**
 * (docs/adr-source-link-ledger.md). One row records "these two rows in two
 * money systems are the SAME money" — with NO gift involved. This is the third
 * relationship kind alongside the two ratified planes:
 *
 *   • Plane 1 (batch↔batch): the settled payout pairing — the
 *     `payout_qb_settlement` link type here (payout ↔ QB deposit lump;
 *     successor of `staged_payments.settled_stripe_payout_id`).
 *   • Plane 2 (unit↔gift):   `payment_applications` — the cash-application ledger.
 *   • THIS table:            unit↔unit claims across evidence sources.
 *
 * It REPLACED the five scattered pointer columns (DROPPED in migration 0149):
 *   stripe_staged_charges.linked_qb_staged_payment_id     → charge_qb_tie (confirmed)
 *   stripe_staged_charges.proposed_qb_staged_payment_id   → charge_qb_tie (proposed)
 *   stripe_staged_charges.linked_fee_qb_staged_payment_id → charge_fee_row
 *   donorbox_donations.linked_qb_staged_payment_id        → donorbox_qb
 *   donorbox_donations.linked_stripe_charge_id            → donorbox_charge
 * This ledger is the SOLE authority — do not reintroduce pointer columns.
 *
 * CLAIM ≠ STATUS stays law (derivedStatus.ts): a source_links row is a CLAIM —
 * it blocks re-picking and feeds eligibility filters — but `match_confirmed`
 * status evidence for a QB row remains the tied charge's own counted
 * payment_applications row. Never derive status from raw linkage.
 *
 * Deterministic ids so backfill + runtime dual-write converge idempotently
 * (a deterministic type-prefixed id convention):
 *   charge_qb_tie   → `srcl_ct_<charge_id>`   (one live tie per charge; the
 *                     proposed→confirmed transition is ONE row's lifecycle)
 *   charge_fee_row  → `srcl_fee_<charge_id>`
 *   donorbox_qb     → `srcl_dbq_<donation_id>`
 *   donorbox_charge → `srcl_dbc_<donation_id>`
 *   qbo_register_deposit → `srcl_qrd_<bank_transaction_id>`
 *   qbo_register_unit    → `srcl_qru_<bank_transaction_id>`
 *   qbo_line_deposit     → `srcl_qld_<staged_payment_id>`
 *   payout_qb_settlement → `srcl_pqs_<payout_id>`
 *   unit_gift_corroboration → `srcl_ugc_<payment_unit_id>_<gift_id>`
 *
 * QBO-grain claims (docs/adr-qbo-evidence-grain.md): QBO records exist at
 * several grains; each ties to the spine node it evidences through THIS
 * ledger — never a bespoke per-grain table. One QBO row may carry claims at
 * several grains (clues at many grains); reconciliation arithmetic counts its
 * amount at exactly one — the finest grain tied (dollars at one).
 */
export const sourceLinks = pgTable(
  "source_links",
  {
    id: text("id").primaryKey(),
    linkType: sourceLinkTypeEnum("link_type").notNull(),
    // Exactly two of the three evidence FKs are non-NULL, pinned per link_type
    // by the CHECKs below.
    stripeChargeId: text("stripe_charge_id").references(
      () => stripeStagedCharges.id,
      { onDelete: "cascade" },
    ),
    qbStagedPaymentId: text("qb_staged_payment_id").references(
      () => stagedPayments.id,
      { onDelete: "cascade" },
    ),
    donorboxDonationId: text("donorbox_donation_id").references(
      () => donorboxDonations.id,
      { onDelete: "cascade" },
    ),
    // QBO-grain anchors (docs/adr-qbo-evidence-grain.md).
    bankTransactionId: text("bank_transaction_id").references(
      () => bankTransactions.id,
      { onDelete: "cascade" },
    ),
    bankDepositId: text("bank_deposit_id").references(() => bankDeposits.id, {
      onDelete: "cascade",
    }),
    paymentUnitId: text("payment_unit_id").references(() => paymentUnits.id, {
      onDelete: "cascade",
    }),
    stripePayoutId: text("stripe_payout_id").references(
      () => stripePayouts.id,
      { onDelete: "cascade" },
    ),
    // Gift anchor for unit_gift_corroboration (successor of the ledger's
    // link_role='corroborating' rows): non-counting "this money relates to
    // that gift" evidence. Counted money is the payment_units.gift_id pointer.
    giftId: text("gift_id").references(() => giftsAndPayments.id, {
      onDelete: "cascade",
    }),
    // HOW a machine claim was matched; NULL for legacy pre-basis rows.
    matchBasis: sourceLinkMatchBasisEnum("match_basis"),
    lifecycle: sourceLinkLifecycleEnum("lifecycle").notNull(),
    provenance: sourceLinkProvenanceEnum("provenance")
      .notNull()
      .default("system"),
    // Who/when confirmed (populated only for a human-confirmed claim).
    confirmedByUserId: text("confirmed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    // Optional HUMAN text — never machine-parsed (the retired
    // `charge_tie_supersede:<qbId>` marker lives on as the
    // payment_applications.match_method enum value instead).
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // Per-type FK shape: exactly which two evidence FKs a row carries.
    check(
      "source_links_fk_shape_chk",
      sql`(
        (${t.linkType} = 'charge_qb_tie'   AND ${t.stripeChargeId} IS NOT NULL AND ${t.qbStagedPaymentId} IS NOT NULL AND ${t.donorboxDonationId} IS NULL AND ${t.bankTransactionId} IS NULL AND ${t.bankDepositId} IS NULL AND ${t.paymentUnitId} IS NULL AND ${t.stripePayoutId} IS NULL AND ${t.giftId} IS NULL) OR
        (${t.linkType} = 'charge_fee_row'  AND ${t.stripeChargeId} IS NOT NULL AND ${t.qbStagedPaymentId} IS NOT NULL AND ${t.donorboxDonationId} IS NULL AND ${t.bankTransactionId} IS NULL AND ${t.bankDepositId} IS NULL AND ${t.paymentUnitId} IS NULL AND ${t.stripePayoutId} IS NULL AND ${t.giftId} IS NULL) OR
        (${t.linkType} = 'donorbox_qb'     AND ${t.donorboxDonationId} IS NOT NULL AND ${t.qbStagedPaymentId} IS NOT NULL AND ${t.stripeChargeId} IS NULL AND ${t.bankTransactionId} IS NULL AND ${t.bankDepositId} IS NULL AND ${t.paymentUnitId} IS NULL AND ${t.stripePayoutId} IS NULL AND ${t.giftId} IS NULL) OR
        (${t.linkType} = 'donorbox_charge' AND ${t.donorboxDonationId} IS NOT NULL AND ${t.stripeChargeId} IS NOT NULL AND ${t.qbStagedPaymentId} IS NULL AND ${t.bankTransactionId} IS NULL AND ${t.bankDepositId} IS NULL AND ${t.paymentUnitId} IS NULL AND ${t.stripePayoutId} IS NULL AND ${t.giftId} IS NULL) OR
        (${t.linkType} = 'qbo_register_deposit' AND ${t.bankTransactionId} IS NOT NULL AND ${t.bankDepositId} IS NOT NULL AND ${t.stripeChargeId} IS NULL AND ${t.qbStagedPaymentId} IS NULL AND ${t.donorboxDonationId} IS NULL AND ${t.paymentUnitId} IS NULL AND ${t.stripePayoutId} IS NULL AND ${t.giftId} IS NULL) OR
        (${t.linkType} = 'qbo_register_unit'    AND ${t.bankTransactionId} IS NOT NULL AND ${t.paymentUnitId} IS NOT NULL AND ${t.stripeChargeId} IS NULL AND ${t.qbStagedPaymentId} IS NULL AND ${t.donorboxDonationId} IS NULL AND ${t.bankDepositId} IS NULL AND ${t.stripePayoutId} IS NULL AND ${t.giftId} IS NULL) OR
        (${t.linkType} = 'qbo_line_deposit'     AND ${t.qbStagedPaymentId} IS NOT NULL AND ${t.bankDepositId} IS NOT NULL AND ${t.stripeChargeId} IS NULL AND ${t.donorboxDonationId} IS NULL AND ${t.bankTransactionId} IS NULL AND ${t.paymentUnitId} IS NULL AND ${t.stripePayoutId} IS NULL AND ${t.giftId} IS NULL) OR
        (${t.linkType} = 'payout_qb_settlement' AND ${t.qbStagedPaymentId} IS NOT NULL AND ${t.stripePayoutId} IS NOT NULL AND ${t.stripeChargeId} IS NULL AND ${t.donorboxDonationId} IS NULL AND ${t.bankTransactionId} IS NULL AND ${t.bankDepositId} IS NULL AND ${t.paymentUnitId} IS NULL AND ${t.giftId} IS NULL) OR
        (${t.linkType} = 'unit_gift_corroboration' AND ${t.paymentUnitId} IS NOT NULL AND ${t.giftId} IS NOT NULL AND ${t.stripeChargeId} IS NULL AND ${t.qbStagedPaymentId} IS NULL AND ${t.donorboxDonationId} IS NULL AND ${t.bankTransactionId} IS NULL AND ${t.bankDepositId} IS NULL AND ${t.stripePayoutId} IS NULL)
      )`,
    ),
    // Charge↔QB ties and QBO-register claims may be system-proposed (awaiting
    // a human confirm); every other claim kind is written already-confirmed.
    check(
      "source_links_proposed_tie_only_chk",
      sql`${t.lifecycle} = 'confirmed' OR ${t.linkType} IN ('charge_qb_tie', 'qbo_register_deposit', 'qbo_register_unit')`,
    ),
    // ── DB-enforced cardinality (the app 409s stay as the friendly error) ──
    // A charge has at most one LIVE tie row (proposed or confirmed) — the
    // deterministic id already guarantees this, the index documents/enforces
    // it independently of id discipline.
    uniqueIndex("source_links_charge_tie_charge_uq")
      .on(t.stripeChargeId)
      .where(sql`${t.linkType} = 'charge_qb_tie'`),
    // A QB row is claimed by at most one CONFIRMED tie (NEW protection — no
    // index guarded this before; proposals may still compete).
    uniqueIndex("source_links_charge_tie_qb_confirmed_uq")
      .on(t.qbStagedPaymentId)
      .where(sql`${t.linkType} = 'charge_qb_tie' AND ${t.lifecycle} = 'confirmed'`),
    // One fee-row link per charge; many charges MAY share one QB fee lump row
    // (no uniqueness on the QB side — matches today's semantics).
    uniqueIndex("source_links_fee_row_charge_uq")
      .on(t.stripeChargeId)
      .where(sql`${t.linkType} = 'charge_fee_row'`),
    // One counterpart of each kind per donation.
    uniqueIndex("source_links_donorbox_qb_uq")
      .on(t.donorboxDonationId)
      .where(sql`${t.linkType} = 'donorbox_qb'`),
    uniqueIndex("source_links_donorbox_charge_uq")
      .on(t.donorboxDonationId)
      .where(sql`${t.linkType} = 'donorbox_charge'`),
    // One deposit claim / one unit claim per register posting row. A deposit
    // may be claimed by MANY register rows (the same-day/same-donor multi-row
    // pattern) — no uniqueness on the deposit side.
    uniqueIndex("source_links_register_deposit_bt_uq")
      .on(t.bankTransactionId)
      .where(sql`${t.linkType} = 'qbo_register_deposit'`),
    uniqueIndex("source_links_register_unit_bt_uq")
      .on(t.bankTransactionId)
      .where(sql`${t.linkType} = 'qbo_register_unit'`),
    // One deposit claim per QBO Deposit line.
    uniqueIndex("source_links_qbo_line_deposit_sp_uq")
      .on(t.qbStagedPaymentId)
      .where(sql`${t.linkType} = 'qbo_line_deposit'`),
    // Payout settlement is 1:1 on both sides.
    uniqueIndex("source_links_payout_settlement_payout_uq")
      .on(t.stripePayoutId)
      .where(sql`${t.linkType} = 'payout_qb_settlement'`),
    uniqueIndex("source_links_payout_settlement_qb_uq")
      .on(t.qbStagedPaymentId)
      .where(sql`${t.linkType} = 'payout_qb_settlement'`),
    // One corroboration claim per unit↔gift pair (a unit may corroborate
    // several gifts and vice versa).
    uniqueIndex("source_links_unit_gift_corrob_uq")
      .on(t.paymentUnitId, t.giftId)
      .where(sql`${t.linkType} = 'unit_gift_corroboration'`),
    // Symmetric "what claims this row?" lookups.
    index("source_links_qb_staged_payment_id_idx").on(t.qbStagedPaymentId),
    index("source_links_stripe_charge_id_idx").on(t.stripeChargeId),
    index("source_links_donorbox_donation_id_idx").on(t.donorboxDonationId),
    index("source_links_link_type_lifecycle_idx").on(t.linkType, t.lifecycle),
    index("source_links_bank_transaction_id_idx").on(t.bankTransactionId),
    index("source_links_bank_deposit_id_idx").on(t.bankDepositId),
    index("source_links_payment_unit_id_idx").on(t.paymentUnitId),
    index("source_links_stripe_payout_id_idx").on(t.stripePayoutId),
    index("source_links_gift_id_idx").on(t.giftId),
  ],
);

export type SourceLink = typeof sourceLinks.$inferSelect;
export type NewSourceLink = typeof sourceLinks.$inferInsert;

/** Deterministic source_links ids (backfill and dual-write must converge). */
export function sourceLinkId(
  linkType: SourceLink["linkType"],
  anchorId: string,
): string {
  switch (linkType) {
    case "charge_qb_tie":
      return `srcl_ct_${anchorId}`;
    case "charge_fee_row":
      return `srcl_fee_${anchorId}`;
    case "donorbox_qb":
      return `srcl_dbq_${anchorId}`;
    case "donorbox_charge":
      return `srcl_dbc_${anchorId}`;
    case "qbo_register_deposit":
      return `srcl_qrd_${anchorId}`;
    case "qbo_register_unit":
      return `srcl_qru_${anchorId}`;
    case "qbo_line_deposit":
      return `srcl_qld_${anchorId}`;
    case "payout_qb_settlement":
      return `srcl_pqs_${anchorId}`;
    case "unit_gift_corroboration":
      // anchorId is `<payment_unit_id>_<gift_id>` (two-sided identity).
      return `srcl_ugc_${anchorId}`;
  }
}
