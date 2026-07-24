import { db } from "@workspace/db";
import {
  paymentApplications,
  stagedPayments,
  stripeStagedCharges,
} from "@workspace/db/schema";
import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { checkBookOnce } from "./paymentApplications";
import { amountWithinFeeBand } from "./reconciliationGate";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * §4.3 settlement supersede (docs/reconciliation-design.md): when a coarse QB
 * deposit lump is settled against a Stripe payout (the
 * `settled_stripe_payout_id` pairing fact, 0168) AND a gift's money
 * is fully re-expressed by that payout's per-charge counted Stripe rows, the
 * deposit's coarse QB row for that gift is DEMOTED to `corroborating` — the
 * granular per-charge rows become the money trail, and source-agnostic
 * SUM readers can never count the same dollars twice. The demotion is fully
 * reversible: when the coverage fact goes away (pairing cleared, charge
 * unbooked), the row is PROMOTED back to `counted`.
 *
 * Discriminator — which corroborating rows this module owns:
 *   - A demoted row KEEPS its `amount_applied` (the CHECK allows > 0 on
 *     corroborating rows). A corroborating QB row WITH an amount is
 *     supersede-managed and eligible for promotion.
 *   - The corrections flow (gift_evidence_links fold) writes corroborating
 *     rows with `amount_applied` NULL. Those are audit-only annotations and
 *     are NEVER touched here.
 *
 * Idempotent + re-runnable: the decision is a pure function of current facts
 * (settled pairing, per-gift Stripe counted sums, fee band), so re-applying on
 * an already-converged deposit is a no-op.
 */

export interface SupersedeQbRow {
  /** payment_applications.id */
  id: string;
  giftId: string;
  /** Numeric string; NULL only on corrections-flow corroborating rows. */
  amountApplied: string | null;
  linkRole: "counted" | "corroborating";
}

export interface SupersedeDecision {
  rowId: string;
  giftId: string;
  action: "demote" | "promote";
}

/**
 * PURE decision core (DB-free, unit-testable). Given a deposit's QB ledger
 * rows, whether the deposit is currently settled against a payout, and the
 * per-gift counted Stripe sums booked from that payout, decide which rows
 * flip role.
 *
 * Coverage = the settled payout's counted Stripe rows for the SAME gift sum to
 * the QB row's amount within the processor fee band (`amountWithinFeeBand`
 * QB-only band: equal to the cent, or gross within ~10% + $1 above the net) —
 * the same-money test used everywhere else in reconciliation.
 *
 *   - counted row, covered      → demote (granular rows own the money trail)
 *   - corroborating row (with an amount — supersede-managed), NOT covered
 *                               → promote (coverage fact disappeared)
 *   - corroborating row with NULL amount (corrections flow) → never touched
 */
export function decideSupersedeActions(args: {
  hasConfirmedLink: boolean;
  rows: SupersedeQbRow[];
  /** Per-gift SUM of counted Stripe rows anchored on the linked payout(s). */
  stripeSumByGift: ReadonlyMap<string, string>;
}): SupersedeDecision[] {
  const { hasConfirmedLink, rows, stripeSumByGift } = args;
  const decisions: SupersedeDecision[] = [];
  for (const row of rows) {
    // Corrections-flow annotation rows (NULL amount) are not ours.
    if (row.linkRole === "corroborating" && row.amountApplied == null) continue;
    const stripeSum = stripeSumByGift.get(row.giftId) ?? null;
    const covered =
      hasConfirmedLink &&
      stripeSum != null &&
      Number(stripeSum) > 0 &&
      amountWithinFeeBand(row.amountApplied, stripeSum);
    if (row.linkRole === "counted" && covered) {
      decisions.push({ rowId: row.id, giftId: row.giftId, action: "demote" });
    } else if (row.linkRole === "corroborating" && !covered) {
      decisions.push({ rowId: row.id, giftId: row.giftId, action: "promote" });
    }
  }
  return decisions;
}

/**
 * Recompute + apply supersede state for a set of QB deposits inside the
 * caller's transaction. Call AFTER the facts changed in the same tx (a payout
 * pairing filled/cleared, a per-charge Stripe row booked/unbooked, a QB row
 * booked against a settled deposit).
 *
 * Per deposit:
 *   1. FOR UPDATE lock the staged payment (serializes against every other
 *      ledger writer for the anchor — applyPaymentApplication locks the same
 *      row).
 *   2. Read its QB ledger rows (counted + supersede-managed corroborating).
 *   3. Read its settled payout pairing → per-gift counted Stripe sums for
 *      that payout.
 *   4. Decide (pure) + apply:
 *      - demote: flip counted → corroborating, KEEPING the amount. Any
 *        pre-existing corroborating row for the same (payment, gift) pair —
 *        e.g. a corrections-flow annotation — is deleted first so the partial
 *        UNIQUE can't collide (the demoted row carries strictly more
 *        information: the amount).
 *      - promote: flip corroborating → counted. If a counted row for the pair
 *        already exists (a fresh booking raced ahead), the stale demoted row
 *        is deleted instead. The book-once guard runs first with the fee-band
 *        tolerance (the row was legally booked before demotion, so this only
 *        blocks a genuine over-application that arose meanwhile); a guard
 *        failure SKIPS the promote — the row stays corroborating, a safe
 *        conservative state a later re-run can still fix.
 *
 * Returns the DISTINCT gift ids whose ledger rows changed, so callers can
 * recompute each gift's QuickBooks tie status post-commit
 * (`applyGiftQbTieMany`).
 */
export async function applySettlementSupersedeMany(
  tx: Tx,
  depositIds: Array<string | null | undefined>,
): Promise<string[]> {
  const ids = [...new Set(depositIds.filter((d): d is string => !!d))];
  const affectedGiftIds = new Set<string>();

  for (const depositId of ids) {
    const deposit = await tx
      .select({
        id: stagedPayments.id,
        amount: stagedPayments.amount,
        settledStripePayoutId: stagedPayments.settledStripePayoutId,
      })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, depositId))
      .for("update")
      .then((r) => r[0]);
    if (!deposit) continue;

    const rows: SupersedeQbRow[] = await tx
      .select({
        id: paymentApplications.id,
        giftId: paymentApplications.giftId,
        amountApplied: paymentApplications.amountApplied,
        linkRole: paymentApplications.linkRole,
      })
      .from(paymentApplications)
      .where(
        and(
          eq(paymentApplications.paymentId, depositId),
          eq(paymentApplications.evidenceSource, "quickbooks"),
          or(
            eq(paymentApplications.linkRole, "counted"),
            and(
              eq(paymentApplications.linkRole, "corroborating"),
              isNotNull(paymentApplications.amountApplied),
            ),
          ),
        ),
      );
    if (rows.length === 0) continue;

    // The payout this deposit settles as the QBO lump (0168 pairing fact;
    // UNIQUE per payout, at most one per deposit row).
    const payoutIds = deposit.settledStripePayoutId
      ? [deposit.settledStripePayoutId]
      : [];

    const stripeSumByGift = new Map<string, string>();
    if (payoutIds.length > 0) {
      const giftIds = [...new Set(rows.map((r) => r.giftId))];
      const sums = await tx
        .select({
          giftId: paymentApplications.giftId,
          total: sql<string>`coalesce(sum(${paymentApplications.amountApplied}), 0)::text`,
        })
        .from(paymentApplications)
        .innerJoin(
          stripeStagedCharges,
          eq(stripeStagedCharges.id, paymentApplications.stripeChargeId),
        )
        .where(
          and(
            eq(paymentApplications.evidenceSource, "stripe"),
            eq(paymentApplications.linkRole, "counted"),
            inArray(stripeStagedCharges.stripePayoutId, payoutIds),
            inArray(paymentApplications.giftId, giftIds),
          ),
        )
        .groupBy(paymentApplications.giftId);
      for (const s of sums) stripeSumByGift.set(s.giftId, s.total);
    }

    const decisions = decideSupersedeActions({
      hasConfirmedLink: payoutIds.length > 0,
      // ("hasConfirmedLink" kept as the arg name: "the deposit is settled".)
      rows,
      stripeSumByGift,
    });
    if (decisions.length === 0) continue;

    // Demotes first: a same-tx demote+promote pair (money moving between
    // gifts) must free the coarse row's cap headroom before the promote's
    // book-once guard reads the live counted SUM.
    const now = new Date();
    for (const d of decisions) {
      if (d.action !== "demote") continue;
      // Clear any pre-existing corroborating row for the pair (partial UNIQUE
      // (payment_id, gift_id) WHERE corroborating would collide).
      await tx
        .delete(paymentApplications)
        .where(
          and(
            eq(paymentApplications.paymentId, depositId),
            eq(paymentApplications.giftId, d.giftId),
            eq(paymentApplications.linkRole, "corroborating"),
            ne(paymentApplications.id, d.rowId),
          ),
        );
      await tx
        .update(paymentApplications)
        .set({ linkRole: "corroborating", updatedAt: now })
        .where(eq(paymentApplications.id, d.rowId));
      affectedGiftIds.add(d.giftId);
    }

    for (const d of decisions) {
      if (d.action !== "promote") continue;
      // A fresh counted booking for the pair supersedes the stale demoted row
      // (the counted partial UNIQUE forbids two): drop the crumb instead.
      const countedExists = await tx
        .select({ id: paymentApplications.id })
        .from(paymentApplications)
        .where(
          and(
            eq(paymentApplications.paymentId, depositId),
            eq(paymentApplications.giftId, d.giftId),
            eq(paymentApplications.linkRole, "counted"),
          ),
        )
        .limit(1)
        .then((r) => r[0]);
      if (countedExists) {
        await tx
          .delete(paymentApplications)
          .where(eq(paymentApplications.id, d.rowId));
        affectedGiftIds.add(d.giftId);
        continue;
      }
      // Book-once guard (mirrors applyPaymentApplication): the promoted amount
      // plus the deposit's OTHER counted rows must fit the deposit's value +
      // fee-band headroom (splits book gross sub-amounts against a net lump,
      // so the plain epsilon would false-fail a legal restore).
      const row = rows.find((r) => r.id === d.rowId);
      const otherSum = await tx
        .select({
          total: sql<string>`coalesce(sum(${paymentApplications.amountApplied}), 0)::text`,
        })
        .from(paymentApplications)
        .where(
          and(
            eq(paymentApplications.paymentId, depositId),
            eq(paymentApplications.linkRole, "counted"),
            ne(paymentApplications.giftId, d.giftId),
          ),
        )
        .then((r) => r[0]?.total ?? "0");
      const guard = checkBookOnce({
        paymentAmount: deposit.amount,
        otherAppliedSum: otherSum,
        newAmount: row?.amountApplied ?? null,
        tolerance: Number(deposit.amount ?? 0) * 0.1 + 1,
      });
      // Conservative skip: leaving the row corroborating under-counts (safe,
      // visible as a `missing` tie) instead of double-counting; a later
      // re-run promotes it once the conflicting booking is reverted.
      if (!guard.ok) continue;
      await tx
        .update(paymentApplications)
        .set({ linkRole: "counted", updatedAt: now })
        .where(eq(paymentApplications.id, d.rowId));
      affectedGiftIds.add(d.giftId);
    }
  }

  return [...affectedGiftIds];
}

/**
 * Convenience for the per-charge booking/revert paths, which know the PAYOUT
 * (from the charge) rather than the deposit: resolve the QBO lump settled
 * against the payout (settled_stripe_payout_id) and recompute supersede state
 * for it. No settled lump → no-op.
 */
export async function applySupersedeForPayoutInTx(
  tx: Tx,
  payoutId: string | null | undefined,
): Promise<string[]> {
  if (!payoutId) return [];
  const lump = await tx
    .select({ id: stagedPayments.id })
    .from(stagedPayments)
    .where(eq(stagedPayments.settledStripePayoutId, payoutId))
    .then((r) => r[0]);
  if (!lump) return [];
  return applySettlementSupersedeMany(tx, [lump.id]);
}
