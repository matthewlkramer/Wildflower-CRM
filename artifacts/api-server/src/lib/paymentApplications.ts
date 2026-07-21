// `db` is used ONLY to derive the transaction type — keep it type-only so
// importing this helper (into the merge / revert routes) carries no runtime DB
// coupling. Every function takes the caller's `tx`; nothing here touches the
// `db` singleton at runtime.
import type { db } from "@workspace/db";
import {
  paymentApplications,
  stagedPayments,
  stripeStagedCharges,
  donorboxDonations,
} from "@workspace/db/schema";
import { and, eq, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { newId } from "./helpers";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PaymentApplicationEvidenceSource =
  | "quickbooks"
  | "stripe"
  | "donorbox";
export type PaymentApplicationMatchMethod =
  | "system"
  | "system_confirmed"
  | "human"
  // Row was MOVED onto a Stripe charge by charge-tie supersede — the
  // first-class discriminator (replaces the retired note-marker parse).
  | "charge_tie_supersede";

/** Default headroom above a payment's amount: just enough to absorb float
 * noise. Split callers (gross per-gift sub-amounts sum slightly above the net
 * deposit) pass a wider fee-band tolerance explicitly. */
const BOOK_ONCE_EPSILON = 0.005;

export interface BookOnceCheckArgs {
  /** The anchoring payment's own amount (the cap) as a numeric string. */
  paymentAmount: string | null;
  /** SUM(amount_applied) already booked against this payment for OTHER gifts. */
  otherAppliedSum: string | number | null;
  /** The amount about to be applied to THIS gift. */
  newAmount: string | number | null;
  /**
   * Absolute dollar headroom above the payment amount. A processor payout's
   * GROSS per-gift sub-amounts can sum slightly above the NET deposit, so split
   * callers pass a fee-band tolerance; the default only absorbs float noise.
   */
  tolerance?: number;
}

export interface BookOnceResult {
  ok: boolean;
  /** Total that would be booked against the payment (other + new). */
  total: number;
  /** Allowed cap (paymentAmount + tolerance); null when the amount is unknown. */
  cap: number | null;
  /** Amount over the cap (0 when ok or cap unknown). */
  overage: number;
}

const toNum = (v: string | number | null | undefined): number => {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
};

/**
 * PURE book-once guard: a single QB payment may never be applied to gifts for
 * more than the payment is worth (plus a caller-supplied fee-band tolerance).
 * DB-free, so it is exhaustively unit-testable; `applyPaymentApplication` wraps
 * it with the tx row lock + live SUM read.
 *
 * An unknown payment amount can't prove an over-application, so it passes
 * (mirrors the giftQbTie "can't prove a mismatch ⇒ tied" stance).
 */
export function checkBookOnce(args: BookOnceCheckArgs): BookOnceResult {
  const tolerance = args.tolerance ?? BOOK_ONCE_EPSILON;
  const total = toNum(args.otherAppliedSum) + toNum(args.newAmount);
  if (args.paymentAmount == null || args.paymentAmount === "") {
    return { ok: true, total, cap: null, overage: 0 };
  }
  const base = Number(args.paymentAmount);
  if (Number.isNaN(base)) return { ok: true, total, cap: null, overage: 0 };
  const cap = base + tolerance;
  const overage = total - cap;
  return { ok: overage <= 0, total, cap, overage: overage > 0 ? overage : 0 };
}

/** Thrown by applyPaymentApplication when the live SUM would over-apply a
 * payment beyond its value + tolerance. */
export class PaymentOverApplicationError extends Error {
  constructor(
    public readonly paymentId: string,
    public readonly result: BookOnceResult,
  ) {
    super(
      `payment ${paymentId} over-applied: total ${result.total.toFixed(
        2,
      )} exceeds cap ${result.cap?.toFixed(2) ?? "unknown"}`,
    );
    this.name = "PaymentOverApplicationError";
  }
}

export interface ApplyPaymentApplicationArgs {
  /**
   * The QuickBooks staged_payment anchor. Required when
   * `evidenceSource === "quickbooks"`; null/omitted for stripe/donorbox rows
   * (which anchor on `stripeChargeId` / `donorboxDonationId` instead).
   */
  paymentId?: string | null;
  giftId: string;
  /**
   * Optional NARROWING pointer to the specific gift_allocation a reviewer chose
   * when linking. NULL/undefined = the application is recorded against the whole
   * gift header (the default). Never affects the book-once / tie math (those stay
   * per-gift); it only records which allocation the human intended.
   */
  giftAllocationId?: string | null;
  /** Numeric string ( > 0 ). */
  amountApplied: string;
  evidenceSource: PaymentApplicationEvidenceSource;
  stripeChargeId?: string | null;
  donorboxDonationId?: string | null;
  matchMethod?: PaymentApplicationMatchMethod;
  confirmedByUserId?: string | null;
  confirmedAt?: Date | null;
  note?: string | null;
  createdTheGift?: boolean;
  /** Fee-band headroom for gross-vs-net splits; defaults to float epsilon. */
  tolerance?: number;
}

/**
 * The resolved anchor for a ledger row: which processor row it hangs off, its
 * cap amount (for the book-once guard), and the ledger column that stores the
 * anchor id (used for both the live per-anchor SUM and the ON CONFLICT target).
 */
interface ResolvedAnchor {
  id: string;
  cap: string | null;
  /** payment_applications column that carries this anchor's id. */
  ledgerColumn:
    | typeof paymentApplications.paymentId
    | typeof paymentApplications.stripeChargeId
    | typeof paymentApplications.donorboxDonationId;
  /** ON CONFLICT arbiter (matches the per-anchor partial/plain UNIQUE). */
  conflictTarget: [SQLColumn, typeof paymentApplications.giftId];
  /** Partial-index predicate; omitted for the plain quickbooks UNIQUE. */
  conflictTargetWhere?: SQL;
}

type SQLColumn =
  | typeof paymentApplications.paymentId
  | typeof paymentApplications.stripeChargeId
  | typeof paymentApplications.donorboxDonationId;

/**
 * Resolve + lock the anchor for `args`, reading its cap amount FOR UPDATE so
 * concurrent applications of the SAME anchor serialize. The anchor is chosen by
 * `evidenceSource`: quickbooks → staged_payments (cap = amount), stripe →
 * stripe_staged_charges (cap = gross_amount), donorbox → donorbox_donations
 * (cap = amount). Throws when the required anchor id is missing or the row does
 * not exist.
 */
async function resolveAndLockAnchor(
  tx: Tx,
  args: ApplyPaymentApplicationArgs,
): Promise<ResolvedAnchor> {
  switch (args.evidenceSource) {
    case "quickbooks": {
      if (!args.paymentId) {
        throw new Error(
          "applyPaymentApplication: quickbooks evidence requires paymentId",
        );
      }
      const row = await tx
        .select({ amount: stagedPayments.amount })
        .from(stagedPayments)
        .where(eq(stagedPayments.id, args.paymentId))
        .for("update")
        .then((r) => r[0]);
      if (!row) {
        throw new Error(
          `applyPaymentApplication: staged payment ${args.paymentId} not found`,
        );
      }
      return {
        id: args.paymentId,
        cap: row.amount,
        ledgerColumn: paymentApplications.paymentId,
        // Partial UNIQUE arbiter — must match the counted book-once index predicate.
        conflictTarget: [
          paymentApplications.paymentId,
          paymentApplications.giftId,
        ],
        conflictTargetWhere: sql`${paymentApplications.linkRole} = 'counted'`,
      };
    }
    case "stripe": {
      if (!args.stripeChargeId) {
        throw new Error(
          "applyPaymentApplication: stripe evidence requires stripeChargeId",
        );
      }
      const row = await tx
        .select({ amount: stripeStagedCharges.grossAmount })
        .from(stripeStagedCharges)
        .where(eq(stripeStagedCharges.id, args.stripeChargeId))
        .for("update")
        .then((r) => r[0]);
      if (!row) {
        throw new Error(
          `applyPaymentApplication: stripe charge ${args.stripeChargeId} not found`,
        );
      }
      return {
        id: args.stripeChargeId,
        cap: row.amount,
        ledgerColumn: paymentApplications.stripeChargeId,
        conflictTarget: [
          paymentApplications.stripeChargeId,
          paymentApplications.giftId,
        ],
        conflictTargetWhere: sql`${paymentApplications.stripeChargeId} IS NOT NULL AND ${paymentApplications.linkRole} = 'counted'`,
      };
    }
    case "donorbox": {
      if (!args.donorboxDonationId) {
        throw new Error(
          "applyPaymentApplication: donorbox evidence requires donorboxDonationId",
        );
      }
      const row = await tx
        .select({ amount: donorboxDonations.amount })
        .from(donorboxDonations)
        .where(eq(donorboxDonations.id, args.donorboxDonationId))
        .for("update")
        .then((r) => r[0]);
      if (!row) {
        throw new Error(
          `applyPaymentApplication: donorbox donation ${args.donorboxDonationId} not found`,
        );
      }
      return {
        id: args.donorboxDonationId,
        cap: row.amount,
        ledgerColumn: paymentApplications.donorboxDonationId,
        conflictTarget: [
          paymentApplications.donorboxDonationId,
          paymentApplications.giftId,
        ],
        conflictTargetWhere: sql`${paymentApplications.donorboxDonationId} IS NOT NULL AND ${paymentApplications.linkRole} = 'counted'`,
      };
    }
  }
}

/**
 * Idempotently book a unit↔gift cash-application ledger row (one per
 * anchor↔gift pair). Caller MUST hold an open transaction.
 *
 *  1. Resolves + locks the anchor FOR UPDATE (staged_payment for quickbooks,
 *     stripe_staged_charge for stripe, donorbox_donation for donorbox) so
 *     concurrent applications of the same anchor serialize.
 *  2. Reads the live SUM(amount_applied) already booked to OTHER gifts against
 *     THIS anchor (counted rows only).
 *  3. Runs the pure book-once guard; throws PaymentOverApplicationError on
 *     over-application.
 *  4. Upserts the (anchor_id, gift_id) row via the per-anchor UNIQUE key —
 *     re-runs replace the amount instead of duplicating.
 */
export async function applyPaymentApplication(
  tx: Tx,
  args: ApplyPaymentApplicationArgs,
): Promise<void> {
  // 1. Resolve + lock the anchor (serializes concurrent applications of it).
  const anchor = await resolveAndLockAnchor(tx, args);

  // 2. Live SUM already booked to OTHER gifts against THIS anchor (counted).
  const sumRows = await tx
    .select({
      sum: sql<string>`coalesce(sum(${paymentApplications.amountApplied}), 0)`,
    })
    .from(paymentApplications)
    .where(
      and(
        eq(anchor.ledgerColumn, anchor.id),
        ne(paymentApplications.giftId, args.giftId),
        eq(paymentApplications.linkRole, "counted"),
      ),
    );
  const otherSum = sumRows[0]?.sum ?? "0";

  // 3. Pure book-once guard.
  const result = checkBookOnce({
    paymentAmount: anchor.cap,
    otherAppliedSum: otherSum,
    newAmount: args.amountApplied,
    tolerance: args.tolerance,
  });
  if (!result.ok) throw new PaymentOverApplicationError(anchor.id, result);

  // 4. Idempotent upsert (the per-anchor UNIQUE pair is the book-once key).
  //    link_role / lifecycle keep their column defaults (counted / confirmed)
  //    for every current caller, so they are intentionally not written here.
  const now = new Date();
  const values = {
    paymentId: args.paymentId ?? null,
    giftId: args.giftId,
    giftAllocationId: args.giftAllocationId ?? null,
    amountApplied: args.amountApplied,
    evidenceSource: args.evidenceSource,
    stripeChargeId: args.stripeChargeId ?? null,
    donorboxDonationId: args.donorboxDonationId ?? null,
    matchMethod: args.matchMethod ?? ("system" as const),
    confirmedByUserId: args.confirmedByUserId ?? null,
    confirmedAt: args.confirmedAt ?? null,
    note: args.note ?? null,
    createdTheGift: args.createdTheGift ?? false,
    updatedAt: now,
  };
  await tx
    .insert(paymentApplications)
    .values({ id: newId(), ...values })
    .onConflictDoUpdate({
      target: anchor.conflictTarget,
      targetWhere: anchor.conflictTargetWhere,
      set: values,
    });
}

/**
 * Remove every ledger row for a gift about to be hard-deleted (gift_id is
 * RESTRICT, so the rows must go first). Returns the affected payment ids.
 * Caller holds the transaction.
 */
export async function removePaymentApplicationsForGift(
  tx: Tx,
  giftId: string,
): Promise<string[]> {
  const removed = await tx
    .delete(paymentApplications)
    .where(eq(paymentApplications.giftId, giftId))
    .returning({ paymentId: paymentApplications.paymentId });
  // payment_id is null for stripe/donorbox rows; callers use these ids only to
  // recompute the QB tie, so drop the non-QB anchors.
  return removed
    .map((r) => r.paymentId)
    .filter((p): p is string => p !== null);
}

/**
 * Remove every ledger row anchored to a staged payment being reverted to
 * pending. Returns the affected gift ids (recompute their tie). Caller holds
 * the transaction.
 */
export async function removePaymentApplicationsForPayment(
  tx: Tx,
  paymentId: string,
): Promise<string[]> {
  const removed = await tx
    .delete(paymentApplications)
    .where(eq(paymentApplications.paymentId, paymentId))
    .returning({ giftId: paymentApplications.giftId });
  return removed.map((r) => r.giftId);
}

/**
 * Remove every ledger row anchored to a Stripe charge (across ALL gifts).
 * Returns the affected gift ids (recompute their tie). Caller holds the
 * transaction. Used to make a charge→gift tie idempotent + re-tie-safe:
 * delete-by-anchor, then re-apply (a charge settles at most one gift, so a
 * stale row for a previously-tied gift must not linger and double-count).
 */
export async function removePaymentApplicationsForStripeCharge(
  tx: Tx,
  stripeChargeId: string,
): Promise<string[]> {
  const removed = await tx
    .delete(paymentApplications)
    .where(eq(paymentApplications.stripeChargeId, stripeChargeId))
    .returning({ giftId: paymentApplications.giftId });
  return removed.map((r) => r.giftId);
}

/**
 * Remove every ledger row anchored to a Donorbox donation (across ALL gifts).
 * Returns the affected gift ids. Caller holds the transaction. Same
 * delete-by-anchor-then-apply idempotency contract as the Stripe helper.
 */
export async function removePaymentApplicationsForDonorboxDonation(
  tx: Tx,
  donorboxDonationId: string,
): Promise<string[]> {
  const removed = await tx
    .delete(paymentApplications)
    .where(eq(paymentApplications.donorboxDonationId, donorboxDonationId))
    .returning({ giftId: paymentApplications.giftId });
  return removed.map((r) => r.giftId);
}

/**
 * Book a Stripe charge → gift cash-application ledger row (evidence_source =
 * 'stripe', amount = the charge GROSS). Delete-by-anchor first so a re-tie to a
 * different gift can't leave a stale, double-counting row (the workbench
 * charge-branch update has no status guard, so an auto-applied `system` row for
 * an old gift could otherwise collide with the fresh human tie). A non-positive
 * gross is a clean no-op (mirrors the QB `amount > 0` guard). Caller holds the
 * transaction.
 */
export async function bookStripeChargeApplication(
  tx: Tx,
  args: {
    stripeChargeId: string;
    grossAmount: string | null;
    giftId: string;
    matchMethod: PaymentApplicationMatchMethod;
    confirmedByUserId?: string | null;
    confirmedAt?: Date | null;
    createdTheGift: boolean;
  },
): Promise<void> {
  await removePaymentApplicationsForStripeCharge(tx, args.stripeChargeId);
  if (!args.grossAmount || Number(args.grossAmount) <= 0) return;
  await applyPaymentApplication(tx, {
    evidenceSource: "stripe",
    stripeChargeId: args.stripeChargeId,
    giftId: args.giftId,
    amountApplied: args.grossAmount,
    matchMethod: args.matchMethod,
    confirmedByUserId: args.confirmedByUserId ?? null,
    confirmedAt: args.confirmedAt ?? null,
    createdTheGift: args.createdTheGift,
  });
}

/**
 * Book a Donorbox donation → gift cash-application ledger row (evidence_source
 * = 'donorbox', amount = the donation amount). Same delete-by-anchor-then-apply
 * idempotency + non-positive-amount no-op as the Stripe helper. Donorbox never
 * auto-applies, so the caller always passes a human match method. Caller holds
 * the transaction.
 */
export async function bookDonorboxDonationApplication(
  tx: Tx,
  args: {
    donorboxDonationId: string;
    amount: string | null;
    giftId: string;
    confirmedByUserId?: string | null;
    confirmedAt?: Date | null;
    createdTheGift: boolean;
  },
): Promise<void> {
  await removePaymentApplicationsForDonorboxDonation(
    tx,
    args.donorboxDonationId,
  );
  if (!args.amount || Number(args.amount) <= 0) return;
  await applyPaymentApplication(tx, {
    evidenceSource: "donorbox",
    donorboxDonationId: args.donorboxDonationId,
    giftId: args.giftId,
    amountApplied: args.amount,
    matchMethod: "human",
    confirmedByUserId: args.confirmedByUserId ?? null,
    confirmedAt: args.confirmedAt ?? null,
    createdTheGift: args.createdTheGift,
  });
}

/**
 * Human confirmation of an auto-applied (`system`) match: promote every
 * `system` ledger row anchored to this payment to `system_confirmed` and stamp
 * who/when. No amount or link change, so no book-once re-check is needed. Rows
 * already `human` or `system_confirmed` are deliberately left untouched (a
 * confirm only graduates auto-applied rows). A payment with no `system` rows —
 * e.g. confirming a pending donor match that never minted a gift — is a clean
 * no-op. Returns the affected gift ids (recompute their tie). Caller holds the
 * transaction.
 */
export async function confirmPaymentApplicationsForPayment(
  tx: Tx,
  paymentId: string,
  confirmedByUserId: string | null,
  confirmedAt: Date,
): Promise<string[]> {
  const updated = await tx
    .update(paymentApplications)
    .set({
      matchMethod: "system_confirmed",
      confirmedByUserId: confirmedByUserId ?? null,
      confirmedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentApplications.paymentId, paymentId),
        eq(paymentApplications.matchMethod, "system"),
      ),
    )
    .returning({ giftId: paymentApplications.giftId });
  return updated.map((r) => r.giftId);
}

// ─── Read helpers — the authoritative QuickBooks cash-application ledger ─────
//
// These build correlated-subquery SQL chunks that read a gift's QuickBooks ledger
// rows (evidence_source = 'quickbooks'). They are the single source the T003 read
// cutover flips every QB-link / QB-amount surface onto.
//
// LINK-ROLE FILTER: every reader also constrains `link_role = 'counted'`. Today
// this is a no-op — the applier and every backfill leave `link_role` at its
// 'counted' default, so all rows qualify. It is here to fence off the future
// Phase-5 corroborating fold: when non-counting evidence rows (e.g. a Stripe
// charge corroborating a QB-settled gift) start landing with `link_role =
// 'corroborating'`, these QB-tie/link readers must keep counting the settling
// row ONCE and never double-count the corroborating one.
//
// CRITICAL CORRELATION RULE: the gift-id correlation is passed in as a *literal*
// SQL expression, never as an interpolated drizzle Column. Interpolating a Column
// (`${giftsAndPayments.id}`) into a `sql` template renders the BARE, UNQUALIFIED
// name (`"id"`), which inside a correlated subquery silently binds to the INNER
// table's own `id` (inner scope wins, no ambiguity error) and returns wrong
// results. See `.agents/memory/drizzle-sql-template-bare-column.md`. By taking a
// pre-qualified expression we keep the correlation explicit and always correct.
//
// The default targets an UN-ALIASED `.from(giftsAndPayments)` query: drizzle names
// such a relation by its table name and qualifies columns as
// `"gifts_and_payments"."id"`, so the default correlates correctly there. Raw-SQL
// or aliased callers pass their own alias, e.g. `sql.raw("g.id")`.
export const DEFAULT_GIFT_ID_SQL: SQL = sql.raw('"gifts_and_payments"."id"');

/** EXISTS a QuickBooks cash-application ledger row for the gift. */
export function qbLedgerExistsForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql} AND pa.evidence_source = 'quickbooks' AND pa.link_role = 'counted'
  )`;
}

/** SUM(amount_applied) of the gift's QuickBooks ledger rows, as text ('0' none). */
export function qbLedgerSumForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string> {
  return sql<string>`(
    SELECT COALESCE(SUM(pa.amount_applied), 0)::text
    FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql} AND pa.evidence_source = 'quickbooks' AND pa.link_role = 'counted'
  )`;
}

// ─── Per-source counted readers (source-agnostic gift-tie derivation) ────────
//
// Identical in shape to the QuickBooks readers above, one per non-QB evidence
// source, each constrained to `link_role = 'counted'`. `applyGiftQbTieMany`
// combines the three by PER-SOURCE PRECEDENCE (QB sum wins, else Stripe, else
// Donorbox) — deliberately NOT a cross-source SUM. A gift settled by BOTH a
// coarse QB deposit line AND its per-charge Stripe rows carries a counted row of
// EACH source (migration 0086 does not, and must not, dedupe across sources);
// summing them would double-count the gift (~2× ⇒ false amount_mismatch, §4.3).
// Precedence counts exactly one source. The pure all-source SUM is deferred to
// Phase 4, when settlement_links reclassifies the coarse QB row to
// link_role='corroborating'. Same bare-column footgun rule — pass a
// pre-qualified gift-id expression.

/** EXISTS a Stripe counted cash-application ledger row for the gift. */
export function stripeLedgerExistsForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql} AND pa.evidence_source = 'stripe' AND pa.link_role = 'counted'
  )`;
}

/** SUM(amount_applied) of the gift's Stripe counted ledger rows, as text. */
export function stripeLedgerSumForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string> {
  return sql<string>`(
    SELECT COALESCE(SUM(pa.amount_applied), 0)::text
    FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql} AND pa.evidence_source = 'stripe' AND pa.link_role = 'counted'
  )`;
}

/** EXISTS a Donorbox counted cash-application ledger row for the gift. */
export function donorboxLedgerExistsForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql} AND pa.evidence_source = 'donorbox' AND pa.link_role = 'counted'
  )`;
}

/**
 * "Is this gift Donorbox-backed?" — the single authority for the DB badge and
 * the donorbox path of CRM record-completeness. TRUE when EITHER:
 *   1. a counted donorbox-sourced payment application exists (the direct
 *      ledger fact `donorboxLedgerExistsForGift` reads), OR
 *   2. a counted stripe-sourced payment application's charge has a Donorbox
 *      ledger counterpart (donorbox_donations.stripe_charge_id — the same 1:1
 *      join the gift-detail Donorbox enrichment panel uses). This is how ALL
 *      real Donorbox money links today: Stripe-settled Donorbox donations are
 *      counted through their stripe charge, and no donorbox-sourced PA is
 *      minted for them.
 *
 * Deliberately DISTINCT from `donorboxLedgerExistsForGift`, which answers the
 * narrower ledger question "does a donorbox counted PA exist" for per-source
 * precedence (gift QB-tie, gifts-missing-qb exemptions) — do not merge them.
 *
 * Returns a raw SQL string (not a bound `sql` fragment) because its consumer,
 * the workbench-clusters query, composes plain-SQL strings. Pass a
 * pre-qualified gift-id expression (e.g. "g.id").
 */
export function donorboxBackedExistsSql(giftRef: string): string {
  return `EXISTS (
    SELECT 1 FROM payment_applications pa_dbx
    WHERE pa_dbx.gift_id = ${giftRef} AND pa_dbx.link_role = 'counted'
      AND (
        pa_dbx.evidence_source = 'donorbox'
        OR (pa_dbx.evidence_source = 'stripe' AND pa_dbx.stripe_charge_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM donorbox_donations dd_dbx
              WHERE dd_dbx.stripe_charge_id = pa_dbx.stripe_charge_id
            ))
      )
  )`;
}

/** SUM(amount_applied) of the gift's Donorbox counted ledger rows, as text. */
export function donorboxLedgerSumForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string> {
  return sql<string>`(
    SELECT COALESCE(SUM(pa.amount_applied), 0)::text
    FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql} AND pa.evidence_source = 'donorbox' AND pa.link_role = 'counted'
  )`;
}

/**
 * One staged-payment id linked to the gift via the QuickBooks ledger (LIMIT 1),
 * or null. Preserves the meaning of the legacy `quickbooks_staged_payment_id`
 * surface (a staged_payments.id reconciled to / that created the gift), now
 * sourced from the ledger's anchoring `payment_id`.
 */
export function qbLedgerPaymentIdForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.payment_id FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql} AND pa.evidence_source = 'quickbooks' AND pa.link_role = 'counted'
    LIMIT 1
  )`;
}

// ─── Payment-excluding variants (reconciliation "linked-elsewhere" guards) ───
//
// The candidate/proposal queries ask a subtly different question than the
// gift-detail surfaces above: "is this gift QB-linked to some staged payment
// OTHER than the one I am currently resolving?" These model that by excluding the
// current payment id. Both correlations are passed as PRE-QUALIFIED SQL exprs —
// the same bare-column footgun rule as the helpers above
// (`.agents/memory/drizzle-sql-template-bare-column.md`). The excluded payment id
// is whatever the caller already uses for the outer staged row (a qualified
// column like `"staged_payments"."id"`, or a bound string param).
//
// NOTE the deliberate behavior change vs. the legacy guards: the ledger row set
// INCLUDES group-reconciled applications, which the legacy direct+split guards
// omitted. A group-reconciled gift is already QB-applied, so it correctly stops
// being offered as a free/unlinked candidate. The reconciliation-guards parity
// gate proves the ledger never DROPS a payment the legacy guard counted and that
// every added linker is a group-reconciled one.

/**
 * EXISTS a QuickBooks ledger row tying the gift to a staged payment OTHER than
 * the excluded one. Ledger replacement for the legacy "linked to another staged
 * payment (matched/created/split)" guard.
 */
export function qbLedgerExistsForGiftExcludingPayment(
  giftIdSql: SQL,
  excludePaymentIdSql: SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql}
      AND pa.evidence_source = 'quickbooks' AND pa.link_role = 'counted'
      AND pa.payment_id <> ${excludePaymentIdSql}
  )`;
}

/**
 * One staged-payment id (other than the excluded one) tied to the gift via the
 * QuickBooks ledger, or null. Ledger replacement for the legacy
 * `alreadyLinkedStagedPaymentId` candidate-gift surface.
 */
export function qbLedgerPaymentIdForGiftExcludingPayment(
  giftIdSql: SQL,
  excludePaymentIdSql: SQL,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.payment_id FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql}
      AND pa.evidence_source = 'quickbooks' AND pa.link_role = 'counted'
      AND pa.payment_id <> ${excludePaymentIdSql}
    LIMIT 1
  )`;
}

/**
 * One Stripe charge id (other than the excluded one) that already owns the gift
 * as permanent reconciled EVIDENCE — a counted `evidence_source='stripe'` ledger
 * row (matched or minted; the legacy pointer columns are retired) — or null.
 *
 * The Stripe-charge-anchor analogue of `qbLedgerPaymentIdForGiftExcludingPayment`.
 * When a Stripe charge is the search anchor, a gift's QuickBooks cash-application
 * is EXPECTED (the same money reaches the ledger at the deposit/payout level —
 * QB and Stripe are parallel evidence for one gift) and must NOT disable the
 * match. Only ANOTHER charge already owning the gift is a genuine double-book,
 * so this filters `evidence_source='stripe'`, never the QB rows. Mirrors the
 * settlement-bundle proposal's charge-links "linked elsewhere" guard. Same
 * bare-column footgun rule for the correlation — pass a pre-qualified gift id.
 */
export function chargeIdOwningGiftExcludingCharge(
  giftIdSql: SQL,
  excludeChargeIdSql: SQL,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.stripe_charge_id FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql}
      AND pa.evidence_source = 'stripe' AND pa.link_role = 'counted'
      AND pa.stripe_charge_id IS NOT NULL
      AND pa.stripe_charge_id <> ${excludeChargeIdSql}
    LIMIT 1
  )`;
}

// ─── Payment-side helper — "is this staged payment already applied?" ─────────
//
// The inverse of the gift-side helpers: given a staged QuickBooks payment, is it
// already applied to a CRM gift? Used by the unlinked-staged worklists (e.g.
// financialCorrections.loadUnlinkedQbStaged) that previously asked it as
// "matched/created/group all null AND no split". Same bare-column footgun rule —
// the default targets an UN-ALIASED `.from(stagedPayments)` query (drizzle
// qualifies as `"staged_payments"."id"`); aliased/raw callers pass their own
// qualified expression. See `.agents/memory/drizzle-sql-template-bare-column.md`.
export const DEFAULT_PAYMENT_ID_SQL: SQL = sql.raw('"staged_payments"."id"');

/**
 * One gift id (other than the excluded one) the staged payment is already
 * applied to via the QuickBooks ledger, or null. The payment-side inverse of
 * `qbLedgerPaymentIdForGiftExcludingPayment`: given the ANCHOR payment of a
 * re-target, find the gift its money is presently counted against — the very
 * row that would trip `applyPaymentApplication`'s book-once guard. Both args
 * are bound params at every call site (no bare-column footgun).
 */
export function qbLedgerGiftIdForPaymentExcludingGift(
  paymentIdSql: SQL,
  excludeGiftIdSql: SQL,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.gift_id FROM payment_applications pa
    WHERE pa.payment_id = ${paymentIdSql}
      AND pa.evidence_source = 'quickbooks' AND pa.link_role = 'counted'
      AND pa.gift_id <> ${excludeGiftIdSql}
    LIMIT 1
  )`;
}

/** EXISTS a QuickBooks cash-application ledger row anchored to the staged payment. */
export function qbLedgerExistsForPayment(
  paymentIdSql: SQL = DEFAULT_PAYMENT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.payment_id = ${paymentIdSql} AND pa.evidence_source = 'quickbooks' AND pa.link_role = 'counted'
  )`;
}

// ─── Read-cutover helpers (drop tail of the legacy gift-link columns) ─────────
//
// Ledger replacements for the retired staged_payments gift-link columns
// (matched_gift_id / created_gift_id / group_reconciled_gift_id) and the gift's
// final_amount_qb_staged_payment_id pointer. Same bare-column footgun rule —
// the DEFAULT targets an un-aliased `.from(stagedPayments)` query; aliased/raw
// callers pass their own pre-qualified payment-id expression.

/**
 * THE single gift the staged payment resolves to via the QuickBooks ledger, or
 * null. Ledger replacement for the legacy
 * `COALESCE(matched_gift_id, created_gift_id, group_reconciled_gift_id)`
 * "resolved gift" surface. NULL when the payment has no counted rows (pending /
 * excluded / settlement-only deposit) AND when it has more than one (a split) —
 * a split deliberately carried none of the three legacy columns, so the legacy
 * surface was null for it too; exactly-one preserves that behavior.
 */
export function qbLedgerSoleGiftIdForPayment(
  paymentIdSql: SQL = DEFAULT_PAYMENT_ID_SQL,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT CASE WHEN COUNT(*) = 1 THEN MIN(pa.gift_id) END
    FROM payment_applications pa
    WHERE pa.payment_id = ${paymentIdSql}
      AND pa.evidence_source = 'quickbooks' AND pa.link_role = 'counted'
  )`;
}

/**
 * The gift this staged payment MINTED (auto-create rule / approve-create /
 * split remainder), or null. Ledger replacement for the legacy
 * `created_gift_id` column: the counted QB row with created_the_gift = true.
 */
export function qbLedgerMintedGiftIdForPayment(
  paymentIdSql: SQL = DEFAULT_PAYMENT_ID_SQL,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.gift_id FROM payment_applications pa
    WHERE pa.payment_id = ${paymentIdSql}
      AND pa.evidence_source = 'quickbooks' AND pa.link_role = 'counted'
      AND pa.created_the_gift = true
    LIMIT 1
  )`;
}

/**
 * EXISTS a DIRECT (non-mint, non-group) counted QB application from the staged
 * payment to THIS gift. Ledger replacement for the legacy
 * `matched_gift_id = gift AND created_gift_id IS NULL AND
 * group_reconciled_gift_id IS NULL` shape guard (displacement / relink /
 * cascade-reset paths): the pair must be counted, must not be a mint, and the
 * payment must not be reconciled as a member of a QB deposit group (the legacy
 * group REPRESENTATIVE carried matched_gift_id too, and those guards
 * deliberately refused it). Both args are pre-qualified SQL exprs.
 */
export function qbLedgerDirectMatchExists(
  paymentIdSql: SQL,
  giftIdSql: SQL,
): SQL<boolean> {
  return sql<boolean>`(
    EXISTS (
      SELECT 1 FROM payment_applications pa
      WHERE pa.payment_id = ${paymentIdSql} AND pa.gift_id = ${giftIdSql}
        AND pa.evidence_source = 'quickbooks' AND pa.link_role = 'counted'
        AND pa.created_the_gift = false
    )
    AND NOT EXISTS (
      SELECT 1 FROM unit_group_members ugm
      WHERE ugm.evidence_source = 'quickbooks' AND ugm.source_id = ${paymentIdSql}
    )
  )`;
}

// ─── Anchor-side read-cutover helpers (Stripe charges / Donorbox donations) ──
//
// Ledger replacements for the retired stripe_staged_charges and
// donorbox_donations gift-pointer columns (matched_gift_id / created_gift_id —
// @deprecated, never read, never set). Given the ANCHOR row, resolve its
// linked/minted gift from the counted cash-application rows instead. Same
// bare-column footgun rule — the DEFAULTs target un-aliased
// `.from(stripeStagedCharges)` / `.from(donorboxDonations)` queries; aliased or
// raw-SQL callers pass their own pre-qualified id expression.
export const DEFAULT_CHARGE_ID_SQL: SQL = sql.raw('"stripe_staged_charges"."id"');
export const DEFAULT_DONATION_ID_SQL: SQL = sql.raw('"donorbox_donations"."id"');

/**
 * The gift this Stripe charge is counted against (matched OR minted), or null.
 * Ledger replacement for `COALESCE(matched_gift_id, created_gift_id)`. The
 * partial unique on (stripe_charge_id, gift_id) plus the one-gift-per-charge
 * booking paths keep this at most one row in practice; LIMIT 1 guards the
 * scalar shape regardless.
 */
export function stripeLedgerGiftIdForCharge(
  chargeIdSql: SQL = DEFAULT_CHARGE_ID_SQL,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.gift_id FROM payment_applications pa
    WHERE pa.stripe_charge_id = ${chargeIdSql}
      AND pa.evidence_source = 'stripe' AND pa.link_role = 'counted'
    LIMIT 1
  )`;
}

/**
 * The gift this Stripe charge MINTED (create-gift / bundle mint), or null.
 * Ledger replacement for the legacy `created_gift_id` column: the counted
 * stripe row with created_the_gift = true.
 */
export function stripeLedgerMintedGiftIdForCharge(
  chargeIdSql: SQL = DEFAULT_CHARGE_ID_SQL,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.gift_id FROM payment_applications pa
    WHERE pa.stripe_charge_id = ${chargeIdSql}
      AND pa.evidence_source = 'stripe' AND pa.link_role = 'counted'
      AND pa.created_the_gift = true
    LIMIT 1
  )`;
}

/**
 * The counted Stripe cash-application ledger row anchored on a charge, or
 * null. Read cutover: this — not the retired matched_gift_id /
 * created_gift_id pointer columns — is what links a charge to its gift.
 * `createdTheGift` distinguishes a mint (revert deletes the gift) from a
 * match to an existing gift (revert keeps it). Accepts `db` or a `tx`.
 */
export async function chargeCountedLedgerRow(
  q: Pick<Tx, "select">,
  chargeId: string,
): Promise<{ giftId: string; createdTheGift: boolean } | null> {
  const row = await q
    .select({
      giftId: paymentApplications.giftId,
      createdTheGift: paymentApplications.createdTheGift,
    })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.stripeChargeId, chargeId),
        eq(paymentApplications.evidenceSource, "stripe"),
        eq(paymentApplications.linkRole, "counted"),
      ),
    )
    .limit(1)
    .then((r) => r[0]);
  return row ?? null;
}

/**
 * The Stripe charge currently counted against this gift, or null.
 * Inverse of chargeCountedLedgerRow / stripeLedgerGiftIdForCharge — goes
 * gift → charge. Replaces the retired
 * gifts_and_payments.final_amount_stripe_charge_id pointer column as the
 * authoritative source for "which charge backs this gift?".
 */
export async function giftCountedStripeChargeId(
  q: Pick<Tx, "select">,
  giftId: string,
): Promise<string | null> {
  const row = await q
    .select({ stripeChargeId: paymentApplications.stripeChargeId })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.giftId, giftId),
        eq(paymentApplications.evidenceSource, "stripe"),
        eq(paymentApplications.linkRole, "counted"),
        isNotNull(paymentApplications.stripeChargeId),
      ),
    )
    .limit(1)
    .then((r) => r[0]);
  return row?.stripeChargeId ?? null;
}

/** EXISTS a counted Stripe cash-application ledger row anchored on the charge. */
export function stripeLedgerCountedExistsForCharge(
  chargeIdSql: SQL = DEFAULT_CHARGE_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.stripe_charge_id = ${chargeIdSql}
      AND pa.evidence_source = 'stripe' AND pa.link_role = 'counted'
  )`;
}

/**
 * The gift this Donorbox donation is counted against (matched OR minted), or
 * null. Ledger replacement for `COALESCE(matched_gift_id, created_gift_id)`.
 */
export function donorboxLedgerGiftIdForDonation(
  donationIdSql: SQL = DEFAULT_DONATION_ID_SQL,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.gift_id FROM payment_applications pa
    WHERE pa.donorbox_donation_id = ${donationIdSql}
      AND pa.evidence_source = 'donorbox' AND pa.link_role = 'counted'
    LIMIT 1
  )`;
}

/** EXISTS a counted Donorbox cash-application ledger row anchored on the donation. */
export function donorboxLedgerCountedExistsForDonation(
  donationIdSql: SQL = DEFAULT_DONATION_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.donorbox_donation_id = ${donationIdSql}
      AND pa.evidence_source = 'donorbox' AND pa.link_role = 'counted'
  )`;
}
