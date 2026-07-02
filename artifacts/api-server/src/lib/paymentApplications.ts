// `db` is used ONLY to derive the transaction type — keep it type-only so
// importing this helper (into the merge / revert routes) carries no runtime DB
// coupling. Every function takes the caller's `tx`; nothing here touches the
// `db` singleton at runtime.
import type { db } from "@workspace/db";
import { paymentApplications, stagedPayments } from "@workspace/db/schema";
import { and, eq, ne, sql, type SQL } from "drizzle-orm";
import { newId } from "./helpers";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PaymentApplicationEvidenceSource =
  | "quickbooks"
  | "stripe"
  | "donorbox";
export type PaymentApplicationMatchMethod =
  | "system"
  | "system_confirmed"
  | "human";

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
  paymentId: string;
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
 * Idempotently book a QB cash-application ledger row (one per payment↔gift
 * pair). Caller MUST hold an open transaction.
 *
 *  1. Locks the anchoring staged_payment row FOR UPDATE so concurrent
 *     applications of the same payment serialize.
 *  2. Reads the live SUM(amount_applied) already booked to OTHER gifts.
 *  3. Runs the pure book-once guard; throws PaymentOverApplicationError on
 *     over-application.
 *  4. Upserts the (payment_id, gift_id) row (the UNIQUE pair is the book-once
 *     key — re-runs replace the amount instead of duplicating).
 *
 * Zero callers in Phase 1 (additive rollout); the dual-write phase wires this
 * into every QB reconciliation write path.
 */
export async function applyPaymentApplication(
  tx: Tx,
  args: ApplyPaymentApplicationArgs,
): Promise<void> {
  // 1. Lock the anchor payment (serializes concurrent applications of it).
  const paymentRow = await tx
    .select({ amount: stagedPayments.amount })
    .from(stagedPayments)
    .where(eq(stagedPayments.id, args.paymentId))
    .for("update")
    .then((r) => r[0]);
  if (!paymentRow) {
    throw new Error(
      `applyPaymentApplication: staged payment ${args.paymentId} not found`,
    );
  }

  // 2. Live SUM already booked to OTHER gifts for this payment.
  const sumRows = await tx
    .select({
      sum: sql<string>`coalesce(sum(${paymentApplications.amountApplied}), 0)`,
    })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.paymentId, args.paymentId),
        ne(paymentApplications.giftId, args.giftId),
      ),
    );
  const otherSum = sumRows[0]?.sum ?? "0";

  // 3. Pure book-once guard.
  const result = checkBookOnce({
    paymentAmount: paymentRow.amount,
    otherAppliedSum: otherSum,
    newAmount: args.amountApplied,
    tolerance: args.tolerance,
  });
  if (!result.ok) throw new PaymentOverApplicationError(args.paymentId, result);

  // 4. Idempotent upsert (the UNIQUE pair is the book-once key).
  const now = new Date();
  const values = {
    paymentId: args.paymentId,
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
      target: [paymentApplications.paymentId, paymentApplications.giftId],
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
  return removed.map((r) => r.paymentId);
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
    WHERE pa.gift_id = ${giftIdSql} AND pa.evidence_source = 'quickbooks'
  )`;
}

/** SUM(amount_applied) of the gift's QuickBooks ledger rows, as text ('0' none). */
export function qbLedgerSumForGift(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<string> {
  return sql<string>`(
    SELECT COALESCE(SUM(pa.amount_applied), 0)::text
    FROM payment_applications pa
    WHERE pa.gift_id = ${giftIdSql} AND pa.evidence_source = 'quickbooks'
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
    WHERE pa.gift_id = ${giftIdSql} AND pa.evidence_source = 'quickbooks'
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
      AND pa.evidence_source = 'quickbooks'
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
      AND pa.evidence_source = 'quickbooks'
      AND pa.payment_id <> ${excludePaymentIdSql}
    LIMIT 1
  )`;
}

/**
 * One Stripe charge id (other than the excluded one) that already owns the gift
 * as permanent reconciled EVIDENCE — either it created the gift (auto-mint,
 * `created_gift_id`) or it is matched to it (`matched_gift_id`) — or null.
 *
 * The Stripe-charge-anchor analogue of `qbLedgerPaymentIdForGiftExcludingPayment`.
 * When a Stripe charge is the search anchor, a gift's QuickBooks cash-application
 * is EXPECTED (the same money reaches the ledger at the deposit/payout level —
 * QB and Stripe are parallel evidence for one gift) and must NOT disable the
 * match. Only ANOTHER charge already owning the gift is a genuine double-book,
 * so this looks at `stripe_staged_charges`, never the QB ledger. Mirrors the
 * settlement-bundle proposal's charge-links "linked elsewhere" guard. Same
 * bare-column footgun rule for the correlation — pass a pre-qualified gift id.
 */
export function chargeIdOwningGiftExcludingCharge(
  giftIdSql: SQL,
  excludeChargeIdSql: SQL,
): SQL<string | null> {
  return sql<string | null>`(
    SELECT c.id FROM stripe_staged_charges c
    WHERE (c.matched_gift_id = ${giftIdSql} OR c.created_gift_id = ${giftIdSql})
      AND c.id <> ${excludeChargeIdSql}
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

/** EXISTS a QuickBooks cash-application ledger row anchored to the staged payment. */
export function qbLedgerExistsForPayment(
  paymentIdSql: SQL = DEFAULT_PAYMENT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.payment_id = ${paymentIdSql} AND pa.evidence_source = 'quickbooks'
  )`;
}
