import { db } from "@workspace/db";
import {
  stripePayouts,
  stagedPayments,
  settlementLinks,
} from "@workspace/db/schema";
import {
  and,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { logger } from "./logger";
import { withSyncLock } from "./syncLock";
import { getUncachableStripeClient } from "./stripeClient";
import { upsertSettlementLink, deleteSettlementLink } from "./settlementLink";
import { proposeSettlementLink } from "./settlementWriter";

/**
 * Stripe payout ↔ QuickBooks deposit-lump reconciliation (the audit join).
 *
 * A Stripe payout is the NET bank transfer for a batch of charges
 * (Σ gross − Σ fees − Σ refunds). When the org also books that same transfer in
 * QuickBooks, it lands as a single net DEPOSIT (one staged_payments row, payer
 * "Stripe"). This module PROPOSES which QB deposit lump a payout corresponds to
 * so a human can confirm the match in the reconciliation queue.
 *
 * It is PURELY a proposer: it only ever writes a PROPOSED payout↔deposit
 * settlement_links row (via settlementWriter / settlementLink). It NEVER mutates
 * a staged_payments / QuickBooks row — the QB side is only touched on explicit
 * human confirm (see routes/stripe.ts). It also never overwrites a CONFIRMED
 * settlement link (legacy confirmed_excluded / confirmed_keep / confirmed_replace
 * all map to a confirmed link); those are out of scope on every pass.
 */

// ── Pure scoring (unit-testable, no DB) ───────────────────────────────────

/** A Stripe payout reduced to the facts the scorer needs. */
export interface PayoutForScore {
  /** Net amount that hit the bank (major units, string). */
  amount: string | null;
  /** Rollup net (gross − fees − refunds); fallback when `amount` is null. */
  netTotal: string | null;
  /** Bank arrival date, "YYYY-MM-DD". */
  arrivalDate: string | null;
}

/** A candidate QuickBooks deposit-lump staged row. */
export interface QbDepositForScore {
  id: string;
  /** Deposit amount (major units, string). */
  amount: string | null;
  /** Deposit date, "YYYY-MM-DD". */
  dateReceived: string | null;
  payerName: string | null;
  lineDescription: string | null;
  qbTransactionMemo: string | null;
  rawReference: string | null;
  qbDepositToAccountName: string | null;
  status: string;
  matchedGiftId: string | null;
  createdGiftId: string | null;
  groupReconciledGiftId: string | null;
}

export interface PayoutQbScore {
  score: number;
  amountDiffCents: number;
  dayDiff: number;
  stripeSignal: boolean;
  exactAmount: boolean;
  reasons: string[];
}

/**
 * How far the QB deposit date may sit from the payout arrival date. Widened from
 * the original ±10 to ±45: the bookkeeper often records the QB counterpart days
 * or weeks off the bank-arrival date, and a prod cross-check found ±10 (and even
 * ±45) slightly too tight, while other reconcilers already use 60–90d. Still a
 * PROPOSED link a human confirms, so a wider net only surfaces more candidates.
 */
export const RECONCILE_WINDOW_DAYS = 45;
/** Amount diff (cents) treated as an exact match (penny rounding tolerance). */
const EXACT_CENTS = 1;
/** Near-amount band (cents) allowed only when there's a textual Stripe signal. */
const NEAR_CENTS = 100;
/** Minimum score required to surface a proposal. */
export const MIN_PROPOSE_SCORE = 60;

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

function hasStripeSignal(c: QbDepositForScore): boolean {
  const hay = [
    c.payerName,
    c.lineDescription,
    c.qbTransactionMemo,
    c.rawReference,
    c.qbDepositToAccountName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes("stripe");
}

/** The CRM gift a QB deposit is already booked into, if any. Accepts any row
 * carrying the three gift-link columns (the full scoring row is a superset). */
export function candidateGiftId(c: {
  matchedGiftId: string | null;
  createdGiftId: string | null;
  groupReconciledGiftId: string | null;
}): string | null {
  return c.createdGiftId ?? c.matchedGiftId ?? c.groupReconciledGiftId ?? null;
}

/**
 * Score how well a QB deposit lump matches a Stripe payout. Returns null when
 * the candidate is not eligible (out of date window, or an amount mismatch with
 * no Stripe signal). Higher is better; the caller proposes the best candidate at
 * or above MIN_PROPOSE_SCORE.
 */
export function scoreQbDepositCandidate(
  payout: PayoutForScore,
  c: QbDepositForScore,
): PayoutQbScore | null {
  const target = toCents(payout.amount) ?? toCents(payout.netTotal);
  const cand = toCents(c.amount);
  if (target == null || cand == null) return null;
  if (!payout.arrivalDate || !c.dateReceived) return null;

  const dd = dayDiff(payout.arrivalDate, c.dateReceived);
  if (dd > RECONCILE_WINDOW_DAYS) return null;

  const amountDiffCents = Math.abs(target - cand);
  const exactAmount = amountDiffCents <= EXACT_CENTS;
  const stripeSignal = hasStripeSignal(c);

  // Eligibility: an exact amount, OR a near amount backed by a "Stripe" signal.
  if (!exactAmount && !(stripeSignal && amountDiffCents <= NEAR_CENTS)) {
    return null;
  }

  const reasons: string[] = [];
  let score = 50;
  if (exactAmount) {
    score += 30;
    reasons.push("amount matches exactly");
  } else {
    score -= Math.min(20, Math.floor(amountDiffCents / 5));
    reasons.push(`amount differs by $${(amountDiffCents / 100).toFixed(2)}`);
  }
  if (stripeSignal) {
    score += 20;
    reasons.push('payer/memo mentions "Stripe"');
  }
  score -= dd;
  reasons.push(dd === 0 ? "same deposit date" : `deposit ${dd}d from arrival`);

  score = Math.max(0, Math.min(100, score));
  return { score, amountDiffCents, dayDiff: dd, stripeSignal, exactAmount, reasons };
}

// ── DB proposal pass ──────────────────────────────────────────────────────

export interface ProposalSummary {
  evaluated: number;
  proposed: number;
  conflicts: number;
  cleared: number;
}

const ADD_DAY_MS = 86_400_000;
function shiftDate(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return new Date(t + days * ADD_DAY_MS).toISOString().slice(0, 10);
}

/**
 * Read-flip predicate: a payout is (re)proposable unless it already carries a
 * CONFIRMED settlement link. Correlated on stripePayouts.id, so it drops into
 * both the candidate SELECT's WHERE and each guarded UPDATE's WHERE.
 */
const notConfirmed = () =>
  notExists(
    db
      .select({ x: sql<number>`1` })
      .from(settlementLinks)
      .where(
        and(
          eq(settlementLinks.payoutId, stripePayouts.id),
          eq(settlementLinks.lifecycle, "confirmed"),
        ),
      ),
  );

/**
 * Recompute payout↔deposit proposals over every NON-confirmed payout (optionally
 * restricted to `payoutIds`). Idempotent: re-running yields the same proposals.
 * Writes ONLY stripe_payouts proposal columns and guards against a CONFIRMED
 * settlement link in every UPDATE so a concurrent human confirm is never clobbered.
 *
 * Lock-free: callers already holding the per-account "stripe" advisory lock (the
 * backfill / sync workers) call this directly; the public proposePayoutMatches()
 * wrapper takes the lock for standalone (route-triggered) runs.
 */
export async function runProposalPass(
  payoutIds?: string[],
): Promise<ProposalSummary> {
  const where =
    payoutIds && payoutIds.length
      ? and(notConfirmed(), inArray(stripePayouts.id, payoutIds))
      : notConfirmed();

  // Read-flip: link existence (leftJoin) replaces the legacy `unmatched` enum —
  // a NULL linkId means the payout has no settlement link (nothing to clear).
  const payouts = await db
    .select({
      id: stripePayouts.id,
      amount: stripePayouts.amount,
      netTotal: stripePayouts.netTotal,
      arrivalDate: stripePayouts.arrivalDate,
      chargeCount: stripePayouts.chargeCount,
      linkId: settlementLinks.id,
    })
    .from(stripePayouts)
    .leftJoin(settlementLinks, eq(settlementLinks.payoutId, stripePayouts.id))
    .where(where);

  // Deposit lumps already CONFIRMED-linked to a payout are taken — never propose
  // them to another payout. Read-flip: read the confirmed links' deposits, not
  // the legacy matched pointer column.
  const takenRows = await db
    .select({ id: settlementLinks.depositStagedPaymentId })
    .from(settlementLinks)
    .where(eq(settlementLinks.lifecycle, "confirmed"));
  const taken = new Set(takenRows.map((r) => r.id).filter(Boolean) as string[]);
  // Within a single pass, never assign one deposit lump to two payouts.
  const assigned = new Set<string>();

  let proposed = 0;
  let conflicts = 0;
  let cleared = 0;

  for (const p of payouts) {
    const target = p.amount ?? p.netTotal;
    let best: { c: QbDepositForScore; s: PayoutQbScore } | null = null;

    if (target && p.arrivalDate) {
      const fromStr = shiftDate(p.arrivalDate, -RECONCILE_WINDOW_DAYS);
      const toStr = shiftDate(p.arrivalDate, RECONCILE_WINDOW_DAYS);
      // A "lump" candidate is either a QB row explicitly typed as a Stripe
      // deposit, OR a net-lump the bookkeeper mis-typed as a generic payment —
      // detected by a textual "Stripe" signal or a generic payer name ("Misc
      // Customer"). This broadens beyond qb_entity_type='deposit' so a real lump
      // recorded under the wrong type is still found. A donor-NAME payment row is
      // deliberately excluded here: that is a single donation and belongs at the
      // charge grain (see the single-charge gate below), not a payout↔deposit tie.
      const looksLikeLump = or(
        eq(stagedPayments.qbEntityType, "deposit"),
        sql`lower(
          coalesce(${stagedPayments.payerName}, '') || ' ' ||
          coalesce(${stagedPayments.lineDescription}, '') || ' ' ||
          coalesce(${stagedPayments.qbTransactionMemo}, '') || ' ' ||
          coalesce(${stagedPayments.rawReference}, '') || ' ' ||
          coalesce(${stagedPayments.qbDepositToAccountName}, '')
        ) like '%stripe%'`,
        sql`lower(coalesce(${stagedPayments.payerName}, '')) like '%misc%'`,
      );
      const cands = await db
        .select({
          id: stagedPayments.id,
          qbEntityType: stagedPayments.qbEntityType,
          amount: stagedPayments.amount,
          dateReceived: stagedPayments.dateReceived,
          payerName: stagedPayments.payerName,
          lineDescription: stagedPayments.lineDescription,
          qbTransactionMemo: stagedPayments.qbTransactionMemo,
          rawReference: stagedPayments.rawReference,
          qbDepositToAccountName: stagedPayments.qbDepositToAccountName,
          status: stagedPayments.status,
          matchedGiftId: stagedPayments.matchedGiftId,
          createdGiftId: stagedPayments.createdGiftId,
          groupReconciledGiftId: stagedPayments.groupReconciledGiftId,
        })
        .from(stagedPayments)
        .where(
          and(
            looksLikeLump,
            // `reconciled` is the new model's terminal tie (a deposit already
            // bound to a gift as evidence); it remains a valid Stripe-payout
            // candidate so the payout can be reconciled against that same gift.
            inArray(stagedPayments.status, ["pending", "approved", "reconciled"]),
            gte(stagedPayments.dateReceived, fromStr),
            lte(stagedPayments.dateReceived, toStr),
            sql`abs(${stagedPayments.amount} - ${target}::numeric) <= 5.00`,
          ),
        );

      // Single-charge payouts: the one donation's money is booked as an
      // individual donor "payment", so its correct match is Stripe charge ↔ QB
      // payment/gift (charge grain), NOT a payout↔deposit tie — tying the payout
      // to a mis-typed lump here would double-count against the per-charge match.
      // Only let a single-charge payout tie to an actual deposit-typed lump (rare
      // but real); route everything else to charge-grain review (step 2). A null
      // chargeCount is treated as single-charge (conservative).
      const singleCharge = (p.chargeCount ?? 1) <= 1;

      for (const c of cands) {
        if (taken.has(c.id) || assigned.has(c.id)) continue;
        if (singleCharge && c.qbEntityType !== "deposit") continue;
        const s = scoreQbDepositCandidate(
          { amount: p.amount, netTotal: p.netTotal, arrivalDate: p.arrivalDate },
          c,
        );
        if (!s || s.score < MIN_PROPOSE_SCORE) continue;
        if (
          !best ||
          s.score > best.s.score ||
          (s.score === best.s.score &&
            (s.amountDiffCents < best.s.amountDiffCents ||
              (s.amountDiffCents === best.s.amountDiffCents &&
                s.dayDiff < best.s.dayDiff)))
        ) {
          best = { c, s };
        }
      }
    }

    if (!best) {
      // No eligible candidate — clear any stale proposal back to unmatched.
      if (p.linkId != null) {
        // T5.1: the guarded UPDATE and the settlement-link write must be ONE
        // transaction. The UPDATE row-locks the payout, so a concurrent human
        // confirm (which takes FOR UPDATE) serializes behind it and re-evaluates
        // its status guard. Without this, a confirm landing BETWEEN the two
        // statements would be silently overwritten once reads are flipped to
        // settlement_links (the link would revert confirmed → proposed/absent).
        const didClear = await db.transaction(async (tx) => {
          const upd = await tx
            .update(stripePayouts)
            .set({
              // Row-lock only: this UPDATE takes the payout tuple lock so a
              // concurrent human confirm (which takes FOR UPDATE) serializes
              // behind it and re-evaluates its guard under READ COMMITTED; the
              // authoritative write is deleteSettlementLink() below. No
              // reconciliation columns are written anymore.
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(stripePayouts.id, p.id),
                notConfirmed(),
              ),
            )
            .returning({ id: stripePayouts.id });
          if (!upd.length) return false;
          // Plane-1 authoritative write: remove the settlement link.
          await deleteSettlementLink(tx, p.id);
          return true;
        });
        if (didClear) cleared += 1;
      }
      continue;
    }

    assigned.add(best.c.id);
    const giftId = candidateGiftId(best.c);
    // A deposit already resolved to a gift (legacy `approved` or new-model
    // `reconciled`) is a conflict: the payout's per-charge Stripe gifts are the
    // precise record, so the human must confirm reconciling the coarse deposit.
    const isConflict =
      (best.c.status === "approved" || best.c.status === "reconciled") &&
      giftId != null;

    // Money-safety guard: this pass scored `best.c` from a read taken BEFORE the
    // write, and a concurrent standalone-QB confirm (bundle workbench or staged
    // approve queue) can mint a gift onto that same deposit in between. Re-check
    // the candidate's committed gift-state at UPDATE time so we never stamp a
    // non-conflict `proposed` tie onto a deposit that just became a pure-QB
    // gift (which would let the payout be confirmed as a separate anchor = a
    // double-book). If the state moved, the UPDATE is a no-op and the next pass
    // re-scores it as a (human-gated) conflict instead.
    const candidateHasGift = db
      .select({ x: sql<number>`1` })
      .from(stagedPayments)
      .where(
        and(
          eq(stagedPayments.id, best.c.id),
          or(
            isNotNull(stagedPayments.createdGiftId),
            isNotNull(stagedPayments.matchedGiftId),
            isNotNull(stagedPayments.groupReconciledGiftId),
          ),
        ),
      );
    const candidateStateGuard = isConflict
      ? exists(candidateHasGift)
      : notExists(candidateHasGift);

    // Phase-4 authoritative write: express the proposal as the settlement link we
    // want, then reverse-derive the legacy enum + pointer columns from it. A
    // non-null conflict gift marks the legacy `conflict_approved` case.
    const link = proposeSettlementLink(best.c.id, isConflict ? giftId : null);
    // T5.1: UPDATE + settlement-link upsert in ONE transaction (see clear branch
    // above) so a racing human confirm cannot be lost between the two writes.
    const applied = await db.transaction(async (tx) => {
      const upd = await tx
        .update(stripePayouts)
        .set({
          // Row-lock only (see the clear branch above): the authoritative write
          // is the upsertSettlementLink() below. This guarded UPDATE still
          // tuple-locks the payout and re-checks notConfirmed()+candidateStateGuard
          // under the lock; RETURNING gates the link write on it succeeding.
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stripePayouts.id, p.id),
            notConfirmed(),
            candidateStateGuard,
          ),
        )
        .returning({ id: stripePayouts.id });
      if (!upd.length) return false;
      // Plane-1 authoritative write: upsert the freshly proposed / conflict link.
      await upsertSettlementLink(tx, p.id, link);
      return true;
    });

    if (applied) {
      if (isConflict) conflicts += 1;
      else proposed += 1;
    }
  }

  return { evaluated: payouts.length, proposed, conflicts, cleared };
}

export interface ProposePayoutMatchesResult extends ProposalSummary {
  ran: boolean;
}

/**
 * Standalone (route-triggered) proposal pass. Takes the per-account "stripe"
 * advisory lock so it serializes against the sync / backfill workers, then runs
 * runProposalPass. A no-op (ran:false) when the Stripe connector is unavailable.
 */
export async function proposePayoutMatches(opts: {
  payoutIds?: string[];
} = {}): Promise<ProposePayoutMatchesResult> {
  let accountId: string | null;
  try {
    ({ accountId } = await getUncachableStripeClient());
  } catch (e) {
    logger.debug({ err: e }, "Stripe reconcile: connector unavailable, skipping");
    return { ran: false, evaluated: 0, proposed: 0, conflicts: 0, cleared: 0 };
  }
  if (!accountId) {
    return { ran: false, evaluated: 0, proposed: 0, conflicts: 0, cleared: 0 };
  }

  const outcome = await withSyncLock(accountId, "stripe", () =>
    runProposalPass(opts.payoutIds),
  );
  if (!outcome.ran) {
    return { ran: false, evaluated: 0, proposed: 0, conflicts: 0, cleared: 0 };
  }
  return { ran: true, ...outcome.result! };
}
