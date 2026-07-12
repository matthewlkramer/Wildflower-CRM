import { db } from "@workspace/db";
import {
  stripePayouts,
  stagedPayments,
  settlementLinks,
  stripeStagedCharges,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { withSyncLock } from "./syncLock";
import { getUncachableStripeClient } from "./stripeClient";

/**
 * Charge-grain Stripe ↔ QuickBooks tie proposals ("individually-booked
 * payouts").
 *
 * The payout↔deposit proposer (stripeReconcile.ts) only finds a match when the
 * bookkeeper recorded the payout as ONE net deposit lump. For many payouts —
 * especially single-donation ones — each donation was instead booked as its own
 * QB row under the donor's name, so there is no lump to tie and the payout sits
 * in "Missing deposit" forever. This module PROPOSES per-charge ties: for each
 * Stripe charge inside a no-settlement-link payout, the QB staged_payments row
 * that records the SAME money (exact gross amount, close date, and — when
 * several same-amount candidates compete — payer-name similarity).
 *
 * PURELY a proposer: it only ever writes
 * `stripe_staged_charges.proposed_qb_staged_payment_id`. It NEVER stamps the
 * confirmed `linked_qb_staged_payment_id` (a human approve does that), never
 * touches settlement_links, gifts, or any QB row, and never overwrites a
 * confirmed tie. Idempotent: re-running recomputes the same proposals and
 * clears stale ones.
 */

// ── Pure matching (unit-testable, no DB) ──────────────────────────────────

/** How far the QB row's date may sit from the charge date. Deliberately
 * tighter than the payout-lump window (45d): a per-donation QB row is usually
 * booked near the donation date, and exact-amount matching over a wide window
 * would drag in unrelated same-amount donations. */
export const CHARGE_TIE_WINDOW_DAYS = 20;

/** Minimum payer-name similarity required to disambiguate when MULTIPLE
 * same-amount candidates compete (never assign on amount alone in that case). */
export const NAME_SIM_THRESHOLD = 0.5;

/** Normalize a payer name into a token set: lowercase, strip punctuation, drop
 * empty tokens. "Beard, Hilary" → {beard, hilary}. */
export function nameTokens(name: string | null | undefined): Set<string> {
  if (!name) return new Set();
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

/** Token-set Jaccard similarity between two payer names (0..1). Word-order and
 * punctuation insensitive so "Beard, Hilary" ≈ "Hilary Beard". */
export function nameSimilarity(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

export interface ChargeForTie {
  id: string;
  /** Charge gross amount, major units (donors are credited GROSS). */
  grossAmount: string | null;
  /** "YYYY-MM-DD" */
  dateReceived: string | null;
  payerName: string | null;
  /** charge.description — often carries the real donor name. */
  description: string | null;
}

export interface QbRowForTie {
  id: string;
  amount: string | null;
  /** "YYYY-MM-DD" */
  dateReceived: string | null;
  payerName: string | null;
}

function toCents(s: string | null | undefined): number | null {
  if (s == null) return null;
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

function dayDiff(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const dbb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(dbb)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(da - dbb) / 86_400_000);
}

function chargeName(c: ChargeForTie): string | null {
  return c.payerName ?? c.description ?? null;
}

/**
 * Assign QB rows to charges (both from ONE payout's scope). Pure and
 * deterministic:
 *   • a pair is eligible when amounts match EXACTLY (to the cent) and the
 *     dates sit within {@link CHARGE_TIE_WINDOW_DAYS};
 *   • when an amount group is unambiguous (exactly one charge and one
 *     candidate), amount + window alone assigns it;
 *   • when SEVERAL same-amount charges/candidates compete, payer-name
 *     similarity ≥ {@link NAME_SIM_THRESHOLD} is REQUIRED and pairs are taken
 *     greedily best-similarity-first (ties broken by smaller date gap, then
 *     candidate id) — never on amount alone;
 *   • one QB row is assigned to at most one charge.
 * Returns chargeId → qbRowId for every assignment made.
 */
export function assignChargeQbTies(
  charges: ChargeForTie[],
  candidates: QbRowForTie[],
): Map<string, string> {
  interface Pair {
    chargeId: string;
    qbId: string;
    sim: number;
    dd: number;
  }
  // amountCents → member ids on each side (for the ambiguity test).
  const chargesByAmount = new Map<number, ChargeForTie[]>();
  for (const c of charges) {
    const cents = toCents(c.grossAmount);
    if (cents == null || !c.dateReceived) continue;
    const list = chargesByAmount.get(cents) ?? [];
    list.push(c);
    chargesByAmount.set(cents, list);
  }
  const candsByAmount = new Map<number, QbRowForTie[]>();
  for (const q of candidates) {
    const cents = toCents(q.amount);
    if (cents == null || !q.dateReceived) continue;
    const list = candsByAmount.get(cents) ?? [];
    list.push(q);
    candsByAmount.set(cents, list);
  }

  const assigned = new Map<string, string>();
  const usedQb = new Set<string>();

  for (const [cents, groupCharges] of chargesByAmount) {
    const groupCands = candsByAmount.get(cents) ?? [];
    // Eligible pairs within the date window.
    const pairs: Pair[] = [];
    const eligibleChargeIds = new Set<string>();
    const eligibleQbIds = new Set<string>();
    for (const c of groupCharges) {
      for (const q of groupCands) {
        const dd = dayDiff(c.dateReceived!, q.dateReceived!);
        if (dd > CHARGE_TIE_WINDOW_DAYS) continue;
        pairs.push({
          chargeId: c.id,
          qbId: q.id,
          sim: nameSimilarity(chargeName(c), q.payerName),
          dd,
        });
        eligibleChargeIds.add(c.id);
        eligibleQbIds.add(q.id);
      }
    }
    if (pairs.length === 0) continue;

    // Unambiguous 1×1 group: amount + window is enough evidence on its own.
    const unambiguous =
      eligibleChargeIds.size === 1 && eligibleQbIds.size === 1;

    pairs.sort(
      (a, b) =>
        b.sim - a.sim ||
        a.dd - b.dd ||
        (a.qbId < b.qbId ? -1 : a.qbId > b.qbId ? 1 : 0) ||
        (a.chargeId < b.chargeId ? -1 : a.chargeId > b.chargeId ? 1 : 0),
    );
    for (const p of pairs) {
      if (assigned.has(p.chargeId) || usedQb.has(p.qbId)) continue;
      if (!unambiguous && p.sim < NAME_SIM_THRESHOLD) continue;
      assigned.set(p.chargeId, p.qbId);
      usedQb.add(p.qbId);
    }
  }
  return assigned;
}

export interface ManualTieResult {
  /** chargeId → qbRowId for every provided row that was placed. */
  assigned: Map<string, string>;
  /** Per-row problems (row could not be placed). Empty = full success. */
  issues: { qbStagedPaymentId: string; reason: string }[];
}

/**
 * Manual "Tie selected": place EVERY provided QB row onto a distinct untied
 * charge of one payout. The human asserted these rows ARE this payout's money,
 * so the only hard requirement is an exact-amount fit (a bijection within each
 * amount group); name similarity and date proximity merely ORDER the
 * assignment when several same-amount charges compete — they never block it.
 * Rows that cannot be placed (no untied charge of that amount left) come back
 * as issues; the caller treats any issue as all-or-nothing.
 */
export function assignManualChargeQbTies(
  charges: ChargeForTie[],
  rows: QbRowForTie[],
): ManualTieResult {
  const assigned = new Map<string, string>();
  const issues: ManualTieResult["issues"] = [];
  const freeCharges = new Map<number, ChargeForTie[]>();
  for (const c of charges) {
    const cents = toCents(c.grossAmount);
    if (cents == null) continue;
    const list = freeCharges.get(cents) ?? [];
    list.push(c);
    freeCharges.set(cents, list);
  }

  // Best-evidence-first: order every (row, charge) pair by name similarity,
  // then date gap, so when the amounts are ambiguous the most plausible pairing
  // wins — but any amount-fitting placement is acceptable.
  interface Pair {
    rowId: string;
    chargeId: string;
    cents: number;
    sim: number;
    dd: number;
  }
  const pairs: Pair[] = [];
  const rowCents = new Map<string, number | null>();
  for (const q of rows) {
    const cents = toCents(q.amount);
    rowCents.set(q.id, cents);
    if (cents == null) continue;
    for (const c of freeCharges.get(cents) ?? []) {
      pairs.push({
        rowId: q.id,
        chargeId: c.id,
        cents,
        sim: nameSimilarity(chargeName(c), q.payerName),
        dd:
          c.dateReceived && q.dateReceived
            ? dayDiff(c.dateReceived, q.dateReceived)
            : Number.POSITIVE_INFINITY,
      });
    }
  }
  pairs.sort(
    (a, b) =>
      b.sim - a.sim ||
      a.dd - b.dd ||
      (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0) ||
      (a.chargeId < b.chargeId ? -1 : a.chargeId > b.chargeId ? 1 : 0),
  );
  const usedRows = new Set<string>();
  const usedCharges = new Set<string>();
  for (const p of pairs) {
    if (usedRows.has(p.rowId) || usedCharges.has(p.chargeId)) continue;
    assigned.set(p.chargeId, p.rowId);
    usedRows.add(p.rowId);
    usedCharges.add(p.chargeId);
  }
  for (const q of rows) {
    if (usedRows.has(q.id)) continue;
    const cents = rowCents.get(q.id);
    issues.push({
      qbStagedPaymentId: q.id,
      reason:
        cents == null
          ? "QB row has no amount to match on."
          : "No untied charge of this payout matches this row's exact amount.",
    });
  }
  return { assigned, issues };
}

// ── DB proposal pass ──────────────────────────────────────────────────────

export interface ChargeTieSummary {
  /** No-settlement-link payouts examined. */
  payoutsEvaluated: number;
  /** Charges that ended the pass with a proposed QB tie. */
  proposed: number;
  /** Stale proposals cleared (candidate gone / payout left scope). */
  cleared: number;
}

const DAY_MS = 86_400_000;
function shiftDate(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Recompute charge↔QB tie proposals over every payout with NO settlement link
 * (optionally restricted to `payoutIds`). Idempotent. Writes ONLY
 * `proposed_qb_staged_payment_id`, always guarded on the confirmed tie still
 * being NULL, so a concurrent human approve is never clobbered.
 *
 * Lock-free like runProposalPass: callers already holding the per-account
 * "stripe" advisory lock call this directly; {@link proposeChargeQbTies} takes
 * the lock for standalone (route-triggered) runs.
 */
export async function runChargeTiePass(
  payoutIds?: string[],
): Promise<ChargeTieSummary> {
  let cleared = 0;

  // Scope exit: a charge whose payout HAS a settlement link (the lump path owns
  // it) must not keep a stale charge-grain proposal around. Confirmed ties are
  // untouched — only the proposal column clears.
  const scopeExit = await db
    .update(stripeStagedCharges)
    .set({ proposedQbStagedPaymentId: null, updatedAt: new Date() })
    .where(
      and(
        sql`${stripeStagedCharges.proposedQbStagedPaymentId} IS NOT NULL`,
        sql`EXISTS (
          SELECT 1 FROM settlement_links sl
          WHERE sl.payout_id = ${stripeStagedCharges.stripePayoutId}
        )`,
      ),
    )
    .returning({ id: stripeStagedCharges.id });
  cleared += scopeExit.length;

  // Payouts with NO settlement link at all (the "Missing deposit" pool).
  const noLink = sql`NOT EXISTS (
    SELECT 1 FROM settlement_links sl WHERE sl.payout_id = ${stripePayouts.id}
  )`;
  const payouts = await db
    .select({ id: stripePayouts.id })
    .from(stripePayouts)
    .where(
      payoutIds && payoutIds.length
        ? and(noLink, inArray(stripePayouts.id, payoutIds))
        : noLink,
    );

  let proposed = 0;

  for (const p of payouts) {
    // The payout's open charges: no confirmed tie, not terminal. Terminal
    // (excluded/rejected) charges never get a QB tie — they are already
    // "settled" for this report's purposes.
    const charges = await db
      .select({
        id: stripeStagedCharges.id,
        grossAmount: stripeStagedCharges.grossAmount,
        dateReceived: stripeStagedCharges.dateReceived,
        payerName: stripeStagedCharges.payerName,
        description: stripeStagedCharges.description,
        proposedQbStagedPaymentId:
          stripeStagedCharges.proposedQbStagedPaymentId,
      })
      .from(stripeStagedCharges)
      .where(
        and(
          eq(stripeStagedCharges.stripePayoutId, p.id),
          isNull(stripeStagedCharges.linkedQbStagedPaymentId),
          sql`${stripeStagedCharges.status} NOT IN ('excluded','rejected')`,
        ),
      );
    if (charges.length === 0) continue;

    const matchable = charges.filter(
      (c) => c.grossAmount != null && c.dateReceived != null,
    );

    let assignment = new Map<string, string>();
    if (matchable.length > 0) {
      const amounts = [
        ...new Set(matchable.map((c) => c.grossAmount as string)),
      ];
      const dates = matchable
        .map((c) => c.dateReceived as string)
        .sort();
      const fromStr = shiftDate(dates[0]!, -CHARGE_TIE_WINDOW_DAYS);
      const toStr = shiftDate(
        dates[dates.length - 1]!,
        CHARGE_TIE_WINDOW_DAYS,
      );

      // Candidate QB rows: exact one-of-the-charge-amounts, inside the widest
      // per-payout window (the pure assigner re-checks per charge), an active
      // status, and NOT already spoken for — not a settlement-link deposit
      // (any lifecycle), not confirmed-tied to any charge, and not proposed to
      // a charge of ANOTHER payout (this pass re-derives its own payout's
      // proposals).
      const cands = await db
        .select({
          id: stagedPayments.id,
          amount: stagedPayments.amount,
          dateReceived: stagedPayments.dateReceived,
          payerName: stagedPayments.payerName,
        })
        .from(stagedPayments)
        .where(
          and(
            inArray(stagedPayments.amount, amounts),
            inArray(stagedPayments.status, [
              "pending",
              "approved",
              "reconciled",
            ]),
            sql`${stagedPayments.dateReceived} >= ${fromStr}`,
            sql`${stagedPayments.dateReceived} <= ${toStr}`,
            sql`NOT EXISTS (
              SELECT 1 FROM settlement_links sl
              WHERE sl.deposit_staged_payment_id = ${stagedPayments.id}
            )`,
            sql`NOT EXISTS (
              SELECT 1 FROM stripe_staged_charges cc
              WHERE cc.linked_qb_staged_payment_id = ${stagedPayments.id}
            )`,
            sql`NOT EXISTS (
              SELECT 1 FROM stripe_staged_charges cc
              WHERE cc.proposed_qb_staged_payment_id = ${stagedPayments.id}
                AND cc.stripe_payout_id IS DISTINCT FROM ${p.id}
            )`,
          ),
        );

      assignment = assignChargeQbTies(matchable, cands);
    }

    // Persist this payout's proposals in ONE transaction: clear stale ones,
    // then stamp the fresh assignment. Every write is guarded on the confirmed
    // tie still being NULL so a racing human approve wins.
    await db.transaction(async (tx) => {
      for (const c of charges) {
        const want = assignment.get(c.id) ?? null;
        if (c.proposedQbStagedPaymentId === want) continue;
        const upd = await tx
          .update(stripeStagedCharges)
          .set({ proposedQbStagedPaymentId: want, updatedAt: new Date() })
          .where(
            and(
              eq(stripeStagedCharges.id, c.id),
              isNull(stripeStagedCharges.linkedQbStagedPaymentId),
            ),
          )
          .returning({ id: stripeStagedCharges.id });
        if (upd.length && want == null) cleared += 1;
      }
    });
    proposed += assignment.size;
  }

  return { payoutsEvaluated: payouts.length, proposed, cleared };
}

export interface ProposeChargeTiesResult extends ChargeTieSummary {
  ran: boolean;
}

/**
 * Standalone (route-triggered) charge-tie proposal pass. Takes the per-account
 * "stripe" advisory lock so it serializes against the sync / backfill workers,
 * then runs {@link runChargeTiePass}. A no-op (ran:false) when the Stripe
 * connector is unavailable.
 */
export async function proposeChargeQbTies(
  opts: { payoutIds?: string[] } = {},
): Promise<ProposeChargeTiesResult> {
  let accountId: string | null;
  try {
    ({ accountId } = await getUncachableStripeClient());
  } catch (e) {
    logger.debug(
      { err: e },
      "Charge-tie pass: Stripe connector unavailable, skipping",
    );
    return { ran: false, payoutsEvaluated: 0, proposed: 0, cleared: 0 };
  }
  if (!accountId) {
    return { ran: false, payoutsEvaluated: 0, proposed: 0, cleared: 0 };
  }

  const outcome = await withSyncLock(accountId, "stripe", () =>
    runChargeTiePass(opts.payoutIds),
  );
  if (!outcome.ran) {
    return { ran: false, payoutsEvaluated: 0, proposed: 0, cleared: 0 };
  }
  return { ran: true, ...outcome.result! };
}
