import {
  pgTable,
  text,
  numeric,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { stagedPayments } from "./stagedPayments";
import { giftsAndPayments } from "./giftsAndPayments";
import { giftAllocations } from "./giftAllocations";
import { stripeStagedCharges } from "./stripeStagedCharges";
import { donorboxDonations } from "./donorboxDonations";
import { paymentUnits } from "./paymentUnits";
import { users } from "./users";
import {
  paymentApplicationEvidenceSourceEnum,
  paymentApplicationMatchMethodEnum,
  paymentApplicationLinkRoleEnum,
  paymentApplicationLifecycleEnum,
} from "./_enums";

/**
 * The unified **unit↔gift cash-application ledger** (Plane 2 of the ratified
 * reconciliation redesign — docs/reconciliation-design.md §4.2). One row records
 * "this much of this UNIT of money was applied to this gift". A *unit* is one of
 * three anchors, selected by `evidence_source`:
 *   - `quickbooks` → the staged QB record (`payment_id`),
 *   - `stripe`     → the staged Stripe charge (`stripe_charge_id`),
 *   - `donorbox`   → the Donorbox donation (`donorbox_donation_id`).
 * Exactly one anchor is required per row (CHECK per source). `payment_id` is
 * therefore NULLABLE — only quickbooks rows carry it.
 *
 * Grain & scope (firm decisions — see the rollout plan):
 *   - HEADER grain, not allocations: `gift_id` points at `gifts_and_payments`,
 *     never `gift_allocations` (`gift_allocation_id` is a narrowing annotation).
 *   - A row exists ONLY once a unit is settled to a gift (matched or minted).
 *   - `link_role='counted'` rows are the money trail; `SUM(amount_applied)` per
 *     (source, gift) is the settled figure the derivations read. `corroborating`
 *     rows (a later phase) are audit-only and never enter the SUM.
 *
 * Rollout note (additive dual-write phase): the QB tie derivation and every
 * ledger READER still filter `evidence_source='quickbooks'` — the Stripe/Donorbox
 * rows added here are written alongside the legacy pointer columns but not yet
 * read. Read cutover is a later human-gated task (needs PROD parity first).
 *
 * All anchor FKs are ON DELETE RESTRICT / SET NULL (the unit is the anchor; the
 * gift is the settled record — neither may be hard-deleted out from under a
 * counted row). The hard-delete gift paths (gift merge, QuickBooks revert,
 * Stripe revert) clear / block on ledger rows first.
 *
 * Book-once is enforced in the SERVICE layer (see applyPaymentApplication),
 * NOT by a DB aggregate/fee-band constraint:
 *   - one partial UNIQUE per anchor ((payment_id,gift_id) / (stripe_charge_id,
 *     gift_id) / (donorbox_donation_id,gift_id)): a unit is booked to a gift
 *     exactly once (re-runs upsert the amount instead of duplicating). Postgres
 *     treats NULLs as distinct, so each partial unique only constrains its own
 *     anchor kind.
 *   - the helper's tx row-lock + live per-anchor SUM validation stops a single
 *     unit being applied to gifts for more than it is worth.
 */
export const paymentApplications = pgTable(
  "payment_applications",
  {
    id: text("id").primaryKey(),
    // The anchoring QB payment record — REQUIRED only for evidence_source =
    // 'quickbooks' (enforced by CHECK). Deposits already stage per-line, so the
    // staged row is the atomic cash grain. NULL for stripe / donorbox rows,
    // which anchor on stripe_charge_id / donorbox_donation_id instead.
    paymentId: text("payment_id").references(() => stagedPayments.id, {
      onDelete: "restrict",
    }),
    // The CRM gift this cash was applied to. The ledger SUM that the tie deriver
    // reads is per-GIFT, so this is always the header (the authoritative grain).
    giftId: text("gift_id")
      .notNull()
      .references(() => giftsAndPayments.id, { onDelete: "restrict" }),
    // Optional NARROWING pointer to the specific gift_allocation a reviewer chose
    // when linking (the CRM-only worklist's "Link allocation → payment" action).
    // NULL = the application is recorded against the whole gift header (the
    // historical/default behavior, and what a "Link gift → payment" produces).
    // This NEVER changes the tie math — that stays per-gift on amount_applied —
    // it only records WHICH allocation the human intended. ON DELETE SET NULL so
    // dropping an allocation degrades the row gracefully to header-level.
    giftAllocationId: text("gift_allocation_id").references(
      () => giftAllocations.id,
      { onDelete: "set null" },
    ),
    // The portion of the payment applied to this gift. REQUIRED and > 0 for
    // counted (money-trail) rows; NULLABLE for corroborating rows (audit-only —
    // gift_evidence_links.sub_amount is optional and the corrections flow never
    // sets it). Enforced by the role-aware amount_applied CHECK below.
    amountApplied: numeric("amount_applied", { precision: 14, scale: 2 }),
    evidenceSource: paymentApplicationEvidenceSourceEnum("evidence_source").notNull(),
    // Present (and required) when evidence_source = 'stripe'.
    stripeChargeId: text("stripe_charge_id").references(
      () => stripeStagedCharges.id,
      { onDelete: "set null" },
    ),
    // Present (and required) when evidence_source = 'donorbox'.
    donorboxDonationId: text("donorbox_donation_id").references(
      () => donorboxDonations.id,
      { onDelete: "set null" },
    ),
    // ── The successor anchor (docs/adr-bank-spine-money-model.md, Phase 5) ──
    // The canonical payment_units row this application's money is. Backfilled
    // from whichever of the three source anchors the row carries (0164) and
    // dual-written going forward; the three source anchors demote to
    // provenance at read cutover. Counted-UNIQUE since 0167 (Phase 9a): at
    // most one counted ledger row per canonical unit — legacy same-(unit,
    // gift) duplicates were consolidated by that migration. NULL = the anchor
    // has no unit yet (e.g. an undeposited QB payment).
    paymentUnitId: text("payment_unit_id").references(() => paymentUnits.id, {
      onDelete: "restrict",
    }),
    matchMethod: paymentApplicationMatchMethodEnum("match_method")
      .notNull()
      .default("system"),
    // Whether this row COUNTS toward donor credit (the money trail, in the SUM)
    // or merely corroborates it (audit-only). Every row written this phase is
    // `counted`; the corroborating fold (gift_evidence_links) is a later task.
    linkRole: paymentApplicationLinkRoleEnum("link_role")
      .notNull()
      .default("counted"),
    // Confirmation lifecycle. Every row written this phase is `confirmed` (a
    // ledger row is only booked on a settle / mint / link, never a proposal).
    lifecycle: paymentApplicationLifecycleEnum("lifecycle")
      .notNull()
      .default("confirmed"),
    confirmedByUserId: text("confirmed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamp("confirmed_at"),
    note: text("note"),
    // Preserves today's createdGiftId mint-ownership signal: true when this
    // application is the one that MINTED the gift (vs. matched a pre-existing one).
    createdTheGift: boolean("created_the_gift").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // Book-once key (quickbooks anchor): one COUNTED ledger row per payment↔gift
    // pair. Role-scoped to link_role='counted' so a Phase-5 corroborating QB link
    // to the same (payment, gift) lands in the separate corroborating unique below
    // instead of colliding with the counted money-trail row. payment_id is
    // nullable, but Postgres treats NULLs as distinct so this constrains only
    // quickbooks counted rows (the only counted rows that carry payment_id).
    uniqueIndex("payment_applications_payment_id_gift_id_uq")
      .on(t.paymentId, t.giftId)
      .where(sql`${t.linkRole} = 'counted'`),
    // Book-once key (stripe anchor): one COUNTED ledger row per charge↔gift pair.
    uniqueIndex("payment_applications_stripe_charge_id_gift_id_uq")
      .on(t.stripeChargeId, t.giftId)
      .where(sql`${t.stripeChargeId} IS NOT NULL AND ${t.linkRole} = 'counted'`),
    // Book-once key (donorbox anchor): one COUNTED ledger row per donation↔gift pair.
    uniqueIndex("payment_applications_donorbox_donation_id_gift_id_uq")
      .on(t.donorboxDonationId, t.giftId)
      .where(
        sql`${t.donorboxDonationId} IS NOT NULL AND ${t.linkRole} = 'counted'`,
      ),
    // Counted-uniqueness invariant (linear money model, docs/adr-linear-money-
    // model.md §7 step 5): at most ONE counted ledger row per evidence anchor,
    // full stop — one anchor's money settles one gift. Single-column partials,
    // so they subsume the pair uniques above for counted rows; the pair uniques
    // REMAIN because they are the ON CONFLICT arbiters applyPaymentApplication
    // upserts through (a same-gift re-apply conflicts on both indexes for the
    // same row, so DO UPDATE still fires; a different-gift insert hits only
    // these → 23505 backstop behind the service-layer
    // AnchorAlreadyCountedError guard).
    uniqueIndex("payment_applications_payment_id_counted_uq")
      .on(t.paymentId)
      .where(sql`${t.paymentId} IS NOT NULL AND ${t.linkRole} = 'counted'`),
    uniqueIndex("payment_applications_stripe_charge_id_counted_uq")
      .on(t.stripeChargeId)
      .where(sql`${t.stripeChargeId} IS NOT NULL AND ${t.linkRole} = 'counted'`),
    uniqueIndex("payment_applications_donorbox_donation_id_counted_uq")
      .on(t.donorboxDonationId)
      .where(
        sql`${t.donorboxDonationId} IS NOT NULL AND ${t.linkRole} = 'counted'`,
      ),
    // Corroborating dedupe (Phase 5) — mirrors gift_evidence_links'
    // (gift, evidence) unique: a given evidence row corroborates a given gift AT
    // MOST ONCE per anchor. Disjoint from the counted uniques above (partial on
    // link_role) so a counted row and a corroborating row for the same
    // (anchor, gift) can coexist without collision. Only the QB + Stripe anchors
    // exist as corroborating evidence (gel's two evidence kinds).
    uniqueIndex("payment_applications_payment_id_gift_id_corroborating_uq")
      .on(t.paymentId, t.giftId)
      .where(sql`${t.paymentId} IS NOT NULL AND ${t.linkRole} = 'corroborating'`),
    uniqueIndex("payment_applications_stripe_charge_id_gift_id_corroborating_uq")
      .on(t.stripeChargeId, t.giftId)
      .where(
        sql`${t.stripeChargeId} IS NOT NULL AND ${t.linkRole} = 'corroborating'`,
      ),
    // The END-STATE counted-uniqueness (bank-spine ADR, 0167): one counted
    // row per canonical payment unit — one real payment settles one gift.
    // Subsumes the three per-source counted uniques for unit-annotated rows;
    // those remain for rows whose unit is still NULL and as ON CONFLICT
    // arbiters until the source anchors retire.
    uniqueIndex("payment_applications_payment_unit_id_counted_uq")
      .on(t.paymentUnitId)
      .where(sql`${t.paymentUnitId} IS NOT NULL AND ${t.linkRole} = 'counted'`),
    index("payment_applications_payment_unit_id_idx").on(t.paymentUnitId),
    index("payment_applications_gift_id_idx").on(t.giftId),
    index("payment_applications_gift_allocation_id_idx").on(t.giftAllocationId),
    index("payment_applications_payment_id_idx").on(t.paymentId),
    index("payment_applications_stripe_charge_id_idx").on(t.stripeChargeId),
    index("payment_applications_donorbox_donation_id_idx").on(
      t.donorboxDonationId,
    ),
    // amount_applied is REQUIRED (> 0) for counted rows — the money trail — but
    // OPTIONAL for corroborating rows (gel.sub_amount is nullable and the
    // corrections flow never sets it). Counted SUMs filter link_role='counted',
    // so a null corroborating amount can never enter a total.
    check(
      "payment_applications_amount_applied_positive",
      sql`(${t.linkRole} = 'counted' AND ${t.amountApplied} > 0) OR (${t.linkRole} = 'corroborating' AND (${t.amountApplied} IS NULL OR ${t.amountApplied} > 0))`,
    ),
    // Each evidence source must carry its originating anchor id.
    check(
      "payment_applications_quickbooks_evidence_chk",
      sql`${t.evidenceSource} <> 'quickbooks' OR ${t.paymentId} IS NOT NULL`,
    ),
    check(
      "payment_applications_stripe_evidence_chk",
      sql`${t.evidenceSource} <> 'stripe' OR ${t.stripeChargeId} IS NOT NULL`,
    ),
    check(
      "payment_applications_donorbox_evidence_chk",
      sql`${t.evidenceSource} <> 'donorbox' OR ${t.donorboxDonationId} IS NOT NULL`,
    ),
  ],
);

export type PaymentApplication = typeof paymentApplications.$inferSelect;
export type NewPaymentApplication = typeof paymentApplications.$inferInsert;
