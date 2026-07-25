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
import { giftsAndPayments } from "./giftsAndPayments";
import { giftAllocations } from "./giftAllocations";
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
 * "this much of this UNIT of money was applied to this gift". The canonical unit
 * is `payment_unit_id` (bank-spine ADR, docs/adr-bank-spine-money-model.md): a
 * `payment_units` row derived from whichever source anchor produced it
 * (QuickBooks staged payment, Stripe charge, or Donorbox donation). `payment_units`
 * itself carries the source pointers; the three legacy source-anchor columns
 * (`payment_id` / `stripe_charge_id` / `donorbox_donation_id`) were dropped once
 * every reader, writer, and uniqueness key moved onto the unit.
 *
 * Grain & scope (firm decisions — see the rollout plan):
 *   - HEADER grain, not allocations: `gift_id` points at `gifts_and_payments`,
 *     never `gift_allocations` (`gift_allocation_id` is a narrowing annotation).
 *   - A row exists ONLY once a unit is settled to a gift (matched or minted).
 *   - `link_role='counted'` rows are the money trail; `SUM(amount_applied)` per
 *     (unit, gift) is the settled figure the derivations read. `corroborating`
 *     rows are audit-only and never enter the SUM.
 *
 * FKs are ON DELETE RESTRICT / SET NULL (the unit is the anchor; the gift is the
 * settled record — neither may be hard-deleted out from under a counted row).
 * The hard-delete gift paths (gift merge, QuickBooks revert, Stripe revert)
 * clear / block on ledger rows first.
 *
 * Book-once is enforced in the SERVICE layer (see applyPaymentApplication),
 * NOT by a DB aggregate/fee-band constraint:
 *   - `payment_unit_id_counted_uq`: at most one COUNTED ledger row per canonical
 *     unit — one real payment settles one gift.
 *   - `payment_unit_id_gift_id_corroborating_uq`: a unit corroborates a given
 *     gift at most once (the corrections flow upserts corroborating rows through
 *     it; disjoint from the counted invariant so counted + corroborating for one
 *     (unit, gift) may coexist until a supersede demote collapses them).
 *   - the helper's tx row-lock + live per-unit validation stops a single unit
 *     being applied to gifts for more than it is worth.
 */
export const paymentApplications = pgTable(
  "payment_applications",
  {
    id: text("id").primaryKey(),
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
    // ── The canonical anchor (docs/adr-bank-spine-money-model.md) ──
    // The `payment_units` row this application's money is. It is the sole anchor
    // of the ledger: every reader, writer, and uniqueness key resolves through
    // it, and `payment_units` carries the source pointers (staged payment /
    // Stripe charge / Donorbox donation). NOT NULL — a ledger row only exists
    // for settled money, which always has a unit (minted eagerly at booking).
    paymentUnitId: text("payment_unit_id")
      .notNull()
      .references(() => paymentUnits.id, {
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
    // Counted-uniqueness invariant (bank-spine ADR): one COUNTED ledger row per
    // canonical payment unit — one real payment settles one gift. This is the
    // book-once arbiter applyPaymentApplication's counted upsert conflicts on
    // (same gift → DO UPDATE; different gift → the service-layer
    // AnchorAlreadyCountedError guard fires first, with this index as the 23505
    // backstop).
    uniqueIndex("payment_applications_payment_unit_id_counted_uq")
      .on(t.paymentUnitId)
      .where(sql`${t.linkRole} = 'counted'`),
    // Corroborating dedupe — a unit corroborates a given gift AT MOST ONCE.
    // Disjoint (partial on link_role) from the counted-per-unit invariant above,
    // so a counted row and a corroborating row for the same (unit, gift) can
    // coexist (a settlement-supersede demote later collapses them). Subsumes the
    // two retired per-anchor corroborating uniques and is the ON CONFLICT arbiter
    // the corrections flow upserts corroborating rows through.
    uniqueIndex("payment_applications_payment_unit_id_gift_id_corroborating_uq")
      .on(t.paymentUnitId, t.giftId)
      .where(sql`${t.linkRole} = 'corroborating'`),
    index("payment_applications_payment_unit_id_idx").on(t.paymentUnitId),
    index("payment_applications_gift_id_idx").on(t.giftId),
    index("payment_applications_gift_allocation_id_idx").on(t.giftAllocationId),
    // amount_applied is REQUIRED (> 0) for counted rows — the money trail — but
    // OPTIONAL for corroborating rows (gel.sub_amount is nullable and the
    // corrections flow never sets it). Counted SUMs filter link_role='counted',
    // so a null corroborating amount can never enter a total.
    check(
      "payment_applications_amount_applied_positive",
      sql`(${t.linkRole} = 'counted' AND ${t.amountApplied} > 0) OR (${t.linkRole} = 'corroborating' AND (${t.amountApplied} IS NULL OR ${t.amountApplied} > 0))`,
    ),
  ],
);

export type PaymentApplication = typeof paymentApplications.$inferSelect;
export type NewPaymentApplication = typeof paymentApplications.$inferInsert;
