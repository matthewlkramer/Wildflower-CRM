import { db } from "@workspace/db";
import {
  paymentUnits,
  stagedPayments,
  stripeStagedCharges,
} from "@workspace/db/schema";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import {
  checkBookOnce,
  CLEARED_TIE_FACTS,
  deleteSupersedeDemotionCrumb,
  supersedeDemotionCrumbsForUnits,
  writeSupersedeDemotionCrumb,
  type PaymentApplicationMatchMethod,
} from "./paymentApplications";
import {
  settledDepositIdForPayout,
  settledPayoutIdForDeposit,
} from "./payoutSettlement";
import { amountWithinFeeBand } from "./reconciliationGate";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * §4.3 settlement supersede (docs/reconciliation-design.md): when a coarse QB
 * deposit lump is settled against a Stripe payout (the
 * `payout_qb_settlement` pairing fact, 0168) AND a gift's money
 * is fully re-expressed by that payout's per-charge counted Stripe units, the
 * deposit unit's coarse tie for that gift is DEMOTED — the granular
 * per-charge units become the money trail, and source-agnostic SUM readers
 * can never count the same dollars twice. The demotion is fully reversible:
 * when the coverage fact goes away (pairing cleared, charge unbooked), the
 * tie is PROMOTED back onto the deposit unit.
 *
 * Discriminator — which facts this module owns:
 *   - A demoted tie is preserved as a supersede demotion crumb: a
 *     unit_gift_corroboration source_link with
 *     match_basis = 'supersede_demotion' (provenance carries the original
 *     match method; confirmed_by/confirmed_at its confirmation stamp).
 *   - Corrections-flow corroboration claims (other bases) are audit-only
 *     annotations and are NEVER touched here.
 *
 * Idempotent + re-runnable: the decision is a pure function of current facts
 * (settled pairing, per-gift Stripe counted sums, fee band), so re-applying on
 * an already-converged deposit is a no-op.
 */

export interface SupersedeQbRow {
  /** The unit id for a counted tie; the source_links id for a crumb. */
  id: string;
  /** The QB-anchored payment unit carrying/carried the tie. */
  paymentUnitId: string;
  giftId: string;
  /** The unit's own amount (numeric string). */
  amountApplied: string | null;
  linkRole: "counted" | "corroborating";
}

export interface SupersedeDecision {
  rowId: string;
  giftId: string;
  action: "demote" | "promote";
}

/**
 * PURE decision core (DB-free, unit-testable). Given a deposit's unit ties
 * (counted) and supersede crumbs (corroborating), whether the deposit is
 * currently settled against a payout, and the per-gift counted Stripe sums
 * booked from that payout, decide which ties flip.
 *
 * Coverage = the settled payout's counted Stripe units for the SAME gift sum
 * to the deposit unit's amount within the processor fee band
 * (`amountWithinFeeBand` QB-only band: equal to the cent, or gross within
 * ~10% + $1 above the net) — the same-money test used everywhere else in
 * reconciliation.
 *
 *   - counted tie, covered      → demote (granular units own the money trail)
 *   - crumb, NOT covered        → promote (coverage fact disappeared)
 */
export function decideSupersedeActions(args: {
  hasConfirmedLink: boolean;
  rows: SupersedeQbRow[];
  /** Per-gift SUM of counted Stripe units anchored on the linked payout(s). */
  stripeSumByGift: ReadonlyMap<string, string>;
}): SupersedeDecision[] {
  const { hasConfirmedLink, rows, stripeSumByGift } = args;
  const decisions: SupersedeDecision[] = [];
  for (const row of rows) {
    if (row.amountApplied == null) continue;
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
 * pairing filled/cleared, a per-charge Stripe unit booked/unbooked, a QB row
 * booked against a settled deposit).
 *
 * Per deposit:
 *   1. FOR UPDATE lock the staged payment (serializes against every other
 *      tie writer for the anchor — applyPaymentApplication locks the same
 *      row).
 *   2. Read its unit ties (counted) + supersede crumbs (corroborating).
 *   3. Read its settled payout pairing → per-gift counted Stripe sums for
 *      that payout.
 *   4. Decide (pure) + apply:
 *      - demote: clear the unit's tie facts, preserving them as a supersede
 *        crumb (upsert on the deterministic per-pair id — a pre-existing
 *        corrections annotation for the pair is re-stamped as the crumb).
 *      - promote: restore the tie onto the crumb's unit. If the unit already
 *        carries a fresh counted tie (a booking raced ahead), the stale crumb
 *        is deleted instead. The book-once guard runs first with the fee-band
 *        tolerance (the tie was legally booked before demotion, so this only
 *        blocks a genuine over-application that arose meanwhile); a guard
 *        failure SKIPS the promote — the crumb stays, a safe conservative
 *        state a later re-run can still fix.
 *
 * Returns the DISTINCT gift ids whose ties changed, so callers can recompute
 * each gift's QuickBooks tie status post-commit (`applyGiftQbTieMany`).
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
      })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, depositId))
      .for("update")
      .then((r) => r[0]);
    if (!deposit) continue;
    const settledPayoutId = await settledPayoutIdForDeposit(tx, depositId);

    const units = await tx
      .select({
        id: paymentUnits.id,
        grossAmount: paymentUnits.grossAmount,
        giftId: paymentUnits.giftId,
        giftMatchMethod: paymentUnits.giftMatchMethod,
        giftConfirmedByUserId: paymentUnits.giftConfirmedByUserId,
        giftConfirmedAt: paymentUnits.giftConfirmedAt,
      })
      .from(paymentUnits)
      .where(eq(paymentUnits.sourceStagedPaymentId, depositId))
      .for("update");
    if (units.length === 0) continue;
    const unitById = new Map(units.map((u) => [u.id, u]));
    const crumbs = await supersedeDemotionCrumbsForUnits(
      tx,
      units.map((u) => u.id),
    );
    const crumbById = new Map(crumbs.map((c) => [c.id, c]));

    const rows: SupersedeQbRow[] = [
      ...units.flatMap((u): SupersedeQbRow[] =>
        u.giftId
          ? [
              {
                id: u.id,
                paymentUnitId: u.id,
                giftId: u.giftId,
                amountApplied: u.grossAmount,
                linkRole: "counted",
              },
            ]
          : [],
      ),
      ...crumbs.map(
        (c): SupersedeQbRow => ({
          id: c.id,
          paymentUnitId: c.paymentUnitId,
          giftId: c.giftId,
          amountApplied: unitById.get(c.paymentUnitId)?.grossAmount ?? null,
          linkRole: "corroborating",
        }),
      ),
    ];
    if (rows.length === 0) continue;

    // The payout this deposit settles as the QBO lump (0168 pairing fact;
    // UNIQUE per payout, at most one per deposit row).
    const payoutIds = settledPayoutId ? [settledPayoutId] : [];

    const stripeSumByGift = new Map<string, string>();
    if (payoutIds.length > 0) {
      const giftIds = [...new Set(rows.map((r) => r.giftId))];
      const sums = await tx
        .select({
          giftId: sql<string>`${paymentUnits.giftId}`,
          total: sql<string>`coalesce(sum(${paymentUnits.grossAmount}), 0)::text`,
        })
        .from(paymentUnits)
        .innerJoin(
          stripeStagedCharges,
          eq(stripeStagedCharges.id, paymentUnits.stripeChargeId),
        )
        .where(
          and(
            isNotNull(paymentUnits.stripeChargeId),
            inArray(stripeStagedCharges.stripePayoutId, payoutIds),
            inArray(paymentUnits.giftId, giftIds),
          ),
        )
        .groupBy(paymentUnits.giftId);
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
      const unit = unitById.get(d.rowId);
      if (!unit?.giftId) continue;
      await writeSupersedeDemotionCrumb(tx, {
        paymentUnitId: unit.id,
        giftId: unit.giftId,
        matchMethod: (unit.giftMatchMethod ??
          "system") as PaymentApplicationMatchMethod,
        confirmedByUserId: unit.giftConfirmedByUserId,
        confirmedAt: unit.giftConfirmedAt,
      });
      await tx
        .update(paymentUnits)
        .set({ ...CLEARED_TIE_FACTS, updatedAt: now })
        .where(eq(paymentUnits.id, unit.id));
      affectedGiftIds.add(d.giftId);
    }

    for (const d of decisions) {
      if (d.action !== "promote") continue;
      const crumb = crumbById.get(d.rowId);
      if (!crumb) continue;
      // A fresh counted booking on the crumb's unit:
      //   - for the SAME gift → the crumb is stale, drop it;
      //   - for a DIFFERENT gift → conservative skip (the crumb stays a safe
      //     under-count; a later re-run promotes it once that tie clears).
      const liveGiftId = await tx
        .select({ giftId: paymentUnits.giftId })
        .from(paymentUnits)
        .where(eq(paymentUnits.id, crumb.paymentUnitId))
        .then((r) => r[0]?.giftId ?? null);
      if (liveGiftId) {
        if (liveGiftId === crumb.giftId) {
          await deleteSupersedeDemotionCrumb(tx, crumb.id);
          affectedGiftIds.add(d.giftId);
        }
        continue;
      }
      // Book-once guard (mirrors applyPaymentApplication): the promoted amount
      // plus the deposit's OTHER counted units must fit the deposit's value +
      // fee-band headroom (splits book gross sub-amounts against a net lump,
      // so the plain epsilon would false-fail a legal restore).
      const row = rows.find((r) => r.id === d.rowId);
      const otherSum = await tx
        .select({
          total: sql<string>`coalesce(sum(${paymentUnits.grossAmount}), 0)::text`,
        })
        .from(paymentUnits)
        .where(
          and(
            eq(paymentUnits.sourceStagedPaymentId, depositId),
            isNotNull(paymentUnits.giftId),
            ne(paymentUnits.id, crumb.paymentUnitId),
          ),
        )
        .then((r) => r[0]?.total ?? "0");
      const guard = checkBookOnce({
        paymentAmount: deposit.amount,
        otherAppliedSum: otherSum,
        newAmount: row?.amountApplied ?? null,
        tolerance: Number(deposit.amount ?? 0) * 0.1 + 1,
      });
      // Conservative skip: leaving the tie demoted under-counts (safe,
      // visible as a `missing` tie) instead of double-counting; a later
      // re-run promotes it once the conflicting booking is reverted.
      if (!guard.ok) continue;
      await tx
        .update(paymentUnits)
        .set({
          giftId: crumb.giftId,
          giftAllocationId: null,
          giftMatchMethod: crumb.matchMethod,
          giftConfirmedByUserId: crumb.confirmedByUserId,
          giftConfirmedAt: crumb.confirmedAt,
          giftNote: null,
          createdTheGift: false,
          updatedAt: now,
        })
        .where(eq(paymentUnits.id, crumb.paymentUnitId));
      await deleteSupersedeDemotionCrumb(tx, crumb.id);
      affectedGiftIds.add(d.giftId);
    }
  }

  return [...affectedGiftIds];
}

/**
 * Convenience for the per-charge booking/revert paths, which know the PAYOUT
 * (from the charge) rather than the deposit: resolve the QBO lump settled
 * against the payout (payout_qb_settlement) and recompute supersede state
 * for it. No settled lump → no-op.
 */
export async function applySupersedeForPayoutInTx(
  tx: Tx,
  payoutId: string | null | undefined,
): Promise<string[]> {
  if (!payoutId) return [];
  const lumpId = await settledDepositIdForPayout(tx, payoutId);
  if (!lumpId) return [];
  return applySettlementSupersedeMany(tx, [lumpId]);
}
