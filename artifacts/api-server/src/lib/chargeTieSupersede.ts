// `db` is used ONLY to derive the transaction type (same convention as
// paymentApplications.ts) — nothing here touches the singleton at runtime.
import type { db } from "@workspace/db";
import {
  paymentUnits,
  stagedPayments,
  stripeStagedCharges,
} from "@workspace/db/schema";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import {
  AnchorAlreadyCountedError,
  applyPaymentApplication,
  checkBookOnce,
  CLEARED_TIE_FACTS,
  deleteSupersedeDemotionCrumb,
  supersedeDemotionCrumbsForUnits,
  writeSupersedeDemotionCrumb,
  type PaymentApplicationMatchMethod,
} from "./paymentApplications";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Charge-grain tie supersede — the per-charge twin of §4.3 settlement
 * supersede (settlementSupersede.ts).
 *
 * When a bookkeeper records a donation as its OWN QuickBooks row (an
 * "individually-booked" payout) and that row is confirmed-tied to a Stripe
 * charge (a confirmed source_links charge_qb_tie row; the legacy
 * `linked_qb_staged_payment_id` column is retired — SQL aliases keep the
 * name for API compatibility only), the money is
 * ONE unit seen by two systems. The counted unit→gift tie must live at the
 * CHARGE grain so the tie — `payment_units.gift_id` + fact columns, the sole
 * gift-link record — shows gift ↔ charge ↔ QB row as one trail:
 *
 *   tie CONFIRMED  → the QB unit's tie MOVES to the charge unit (facts +
 *                    provenance carried over) and the QB unit is DEMOTED:
 *                    tie cleared, preserved as a supersede demotion crumb
 *                    (source_links unit_gift_corroboration,
 *                    match_basis = 'supersede_demotion' — reversible).
 *   tie REVERTED   → the tie-derived charge tie is cleared and the demoted
 *                    QB crumb is PROMOTED back to the counted tie — the
 *                    booking returns to where the human originally ratified
 *                    it.
 *
 * SAME-MONEY TEST IS EXACT — deliberately NO fee-band tolerance. A tied QB
 * row records either the charge GROSS (its sibling negative "Stripe fee" row
 * carries the fee — claimSiblingFeeRows) or the charge NET (the post-fee bank
 * deposit), both to the cent — the same rule the tie matchers
 * (assignChargeQbTies / assignManualChargeQbTies) already enforce. A tie
 * confirmed through overrideAmountMismatch fails this test, and the booking
 * conservatively STAYS on the QB row (still match_confirmed via its counted
 * row; the charge stays open for a human to book explicitly).
 *
 * Discriminators (which facts this module owns):
 *   - QB side: a demotion crumb is a unit_gift_corroboration source_link
 *     with match_basis = 'supersede_demotion'. Corrections-flow annotation
 *     claims (other bases) are NEVER touched. Settlement supersede's crumbs
 *     live on settlement-link DEPOSIT units, which can never be charge-tied
 *     (the confirm route 409s them), so the two modules never manage the
 *     same claim.
 *   - Stripe side: a MOVED tie carries the first-class
 *     `gift_match_method = 'charge_tie_supersede'` (the note keeps the
 *     `charge_tie_supersede:<qbId>` text purely as a human-readable trail —
 *     it is never machine-parsed). Only supersede-derived ties are cleared
 *     on revert — a pre-existing human/system charge booking (e.g. the gift
 *     was booked from the charge BEFORE the tie) is never destroyed by an
 *     untie. A charge holds at most ONE confirmed tie at a time
 *     (source_links partial unique), so a supersede-derived tie on the
 *     charge belongs to the tie being reverted.
 *
 * Idempotent + re-runnable: every decision is a pure function of current
 * facts, so re-applying on a converged pair is a no-op.
 */

/** Human-readable note prefix stamped on tie-derived stripe counted rows.
 * Audit-trail text ONLY — the machine discriminator is
 * `match_method = 'charge_tie_supersede'` (never parse the note). */
export const CHARGE_TIE_SUPERSEDE_NOTE_PREFIX = "charge_tie_supersede:";

/** The audit-trail note for one specific tie (records WHICH QB row the
 * booking was moved from — display/debugging only, never parsed). */
export function chargeTieSupersedeMarker(qbStagedPaymentId: string): string {
  return `${CHARGE_TIE_SUPERSEDE_NOTE_PREFIX}${qbStagedPaymentId}`;
}

const toCents = (v: string | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
};

/** EXACT same-money test: the QB row records the charge's gross or net, to
 * the cent. No band — see the module doc. */
export function qbRowAmountMatchesCharge(args: {
  qbRowAmount: string | null;
  chargeGross: string | null;
  chargeNet: string | null;
}): boolean {
  const qb = toCents(args.qbRowAmount);
  if (qb == null) return false;
  const gross = toCents(args.chargeGross);
  const net = toCents(args.chargeNet);
  return (gross != null && qb === gross) || (net != null && qb === net);
}

/** One QB-anchored tie fact on the tied QB staged payment: a COUNTED unit
 * tie (`linkRole: "counted"`, id = the unit id) or a supersede demotion
 * crumb (`linkRole: "corroborating"`, id = the source_links id). */
export interface TieQbLedgerRow {
  id: string;
  /** The QB-anchored payment unit carrying/carried the tie. */
  paymentUnitId: string;
  giftId: string;
  giftAllocationId: string | null;
  /** The unit's own amount (numeric string). */
  amountApplied: string | null;
  linkRole: "counted" | "corroborating";
  matchMethod: PaymentApplicationMatchMethod;
  confirmedByUserId: string | null;
  confirmedAt: Date | null;
}

/** The counted tie already on the charge's unit. */
export interface TieChargeLedgerRow {
  /** The charge-anchored payment unit id. */
  id: string;
  giftId: string;
  matchMethod: PaymentApplicationMatchMethod;
  note: string | null;
}

export type TieSupersedeDecision =
  | {
      /** Book the copied stripe counted row on the charge, then demote the QB
       * source row (counted → corroborating, amount kept). */
      action: "move";
      qbRow: TieQbLedgerRow;
    }
  | {
      /** The charge already carries a counted row for the gift — just demote
       * the QB side (the pre-existing charge booking stays untouched). */
      action: "demote_only";
      qbRow: TieQbLedgerRow;
    }
  | {
      /** Converge a half-moved state: the QB row is already corroborating but
       * the charge has no counted row for the gift — book the copy. */
      action: "book_only";
      qbRow: TieQbLedgerRow;
    }
  | {
      /** Tie reverted: delete the tie-derived (marked) stripe counted row. */
      action: "remove_charge_row";
      chargeRow: TieChargeLedgerRow;
    }
  | {
      /** Tie reverted: promote the demoted QB row back to counted. */
      action: "promote";
      qbRow: TieQbLedgerRow;
    };

/**
 * PURE decision core (DB-free, unit-testable). Given the current facts of ONE
 * (charge, QB row) pair, decide every ledger change needed to converge it.
 *
 *   tie confirmed + exact amount:
 *     counted QB row, gift already charge-booked  → demote_only
 *     counted QB row, gift not charge-booked      → move
 *     corroborating QB row (amount NOT NULL), gift not charge-booked
 *                                                 → book_only (re-converge)
 *   tie confirmed + INEXACT amount (override tie) → nothing (conservative:
 *     the booking stays on the QB row)
 *   tie absent (reverted):
 *     supersede-derived stripe counted row
 *       (match_method = 'charge_tie_supersede')   → remove_charge_row
 *     corroborating QB row (amount NOT NULL)      → promote
 */
export function decideChargeTieSupersede(args: {
  tieConfirmed: boolean;
  qbStagedPaymentId: string;
  /** staged_payments.amount of the tied QB row (the tie's same-money basis). */
  qbRowAmount: string | null;
  chargeGross: string | null;
  chargeNet: string | null;
  qbLedgerRows: TieQbLedgerRow[];
  chargeCountedRows: TieChargeLedgerRow[];
}): TieSupersedeDecision[] {
  const decisions: TieSupersedeDecision[] = [];
  const chargeByGift = new Map(args.chargeCountedRows.map((r) => [r.giftId, r]));

  if (args.tieConfirmed) {
    if (
      !qbRowAmountMatchesCharge({
        qbRowAmount: args.qbRowAmount,
        chargeGross: args.chargeGross,
        chargeNet: args.chargeNet,
      })
    ) {
      return [];
    }
    for (const row of args.qbLedgerRows) {
      if (row.amountApplied == null) continue; // corrections annotation — not ours
      if (row.linkRole === "counted") {
        decisions.push(
          chargeByGift.has(row.giftId)
            ? { action: "demote_only", qbRow: row }
            : { action: "move", qbRow: row },
        );
      } else if (!chargeByGift.has(row.giftId)) {
        decisions.push({ action: "book_only", qbRow: row });
      }
    }
    return decisions;
  }

  // Tie reverted. Every supersede-derived counted row on the charge belongs
  // to this (single-per-charge) tie — discriminated by the first-class
  // match_method, never by parsing the note.
  for (const row of args.chargeCountedRows) {
    if (row.matchMethod === "charge_tie_supersede") {
      decisions.push({ action: "remove_charge_row", chargeRow: row });
    }
  }
  for (const row of args.qbLedgerRows) {
    if (row.linkRole === "corroborating" && row.amountApplied != null) {
      decisions.push({ action: "promote", qbRow: row });
    }
  }
  return decisions;
}

export interface ChargeTiePair {
  chargeId: string;
  qbStagedPaymentId: string;
}

/**
 * Recompute + apply the tie-grain supersede state for a set of
 * (charge, QB row) pairs inside the caller's transaction. Call AFTER the tie
 * fact changed in the same tx — the confirm route passes every pair it just
 * stamped; the revert route passes the pair it just cleared.
 *
 * Locking: charge FOR UPDATE first, then the QB staged payment — the same
 * order the confirm route locks them, and the same per-anchor rows
 * applyPaymentApplication / settlement supersede lock, so every ledger writer
 * serializes on the anchors it touches.
 *
 * Conservative skips (mirror settlementSupersede): a move/book whose copied
 * amount would over-apply the charge's gross cap is SKIPPED (booking stays on
 * the QB row — under-counts nothing, visible, a later re-run converges it);
 * a promote failing the QB book-once guard is SKIPPED the same way.
 *
 * Returns the DISTINCT gift ids whose ledger rows changed so callers can
 * recompute each gift's QuickBooks tie status post-commit
 * (`applyGiftQbTieMany`).
 */
export async function applyChargeTieSupersedePairs(
  tx: Tx,
  pairs: ChargeTiePair[],
): Promise<string[]> {
  const affectedGiftIds = new Set<string>();

  for (const pair of pairs) {
    const charge = await tx
      .select({
        id: stripeStagedCharges.id,
        grossAmount: stripeStagedCharges.grossAmount,
        netAmount: stripeStagedCharges.netAmount,
        // The CONFIRMED tie from the source_links ledger (the authority).
        linkedQbStagedPaymentId: sql<string | null>`(
          SELECT srcl.qb_staged_payment_id FROM source_links srcl
          WHERE srcl.link_type = 'charge_qb_tie'
            AND srcl.lifecycle = 'confirmed'
            AND srcl.stripe_charge_id = "stripe_staged_charges"."id"
        )`,
      })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, pair.chargeId))
      .for("update", { of: stripeStagedCharges })
      .then((r) => r[0]);
    if (!charge) continue;

    const qbRow = await tx
      .select({ id: stagedPayments.id, amount: stagedPayments.amount })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, pair.qbStagedPaymentId))
      .for("update")
      .then((r) => r[0]);
    if (!qbRow) continue;

    // QB-side tie facts: counted unit ties + supersede demotion crumbs.
    const qbUnits = await tx
      .select({
        id: paymentUnits.id,
        grossAmount: paymentUnits.grossAmount,
        giftId: paymentUnits.giftId,
        giftAllocationId: paymentUnits.giftAllocationId,
        giftMatchMethod: paymentUnits.giftMatchMethod,
        giftConfirmedByUserId: paymentUnits.giftConfirmedByUserId,
        giftConfirmedAt: paymentUnits.giftConfirmedAt,
      })
      .from(paymentUnits)
      .where(eq(paymentUnits.sourceStagedPaymentId, pair.qbStagedPaymentId))
      .for("update");
    const unitAmountById = new Map(qbUnits.map((u) => [u.id, u.grossAmount]));
    const crumbs = await supersedeDemotionCrumbsForUnits(
      tx,
      qbUnits.map((u) => u.id),
    );
    const qbLedgerRows: TieQbLedgerRow[] = [
      ...qbUnits.flatMap((u): TieQbLedgerRow[] =>
        u.giftId
          ? [
              {
                id: u.id,
                paymentUnitId: u.id,
                giftId: u.giftId,
                giftAllocationId: u.giftAllocationId,
                amountApplied: u.grossAmount,
                linkRole: "counted",
                matchMethod: u.giftMatchMethod ?? "system",
                confirmedByUserId: u.giftConfirmedByUserId,
                confirmedAt: u.giftConfirmedAt,
              },
            ]
          : [],
      ),
      ...crumbs.map(
        (c): TieQbLedgerRow => ({
          id: c.id,
          paymentUnitId: c.paymentUnitId,
          giftId: c.giftId,
          giftAllocationId: null,
          amountApplied: unitAmountById.get(c.paymentUnitId) ?? null,
          linkRole: "corroborating",
          matchMethod: c.matchMethod,
          confirmedByUserId: c.confirmedByUserId,
          confirmedAt: c.confirmedAt,
        }),
      ),
    ];

    // Charge-side counted tie: the charge unit's own fact columns.
    const chargeUnit = await tx
      .select({
        id: paymentUnits.id,
        giftId: paymentUnits.giftId,
        giftAllocationId: paymentUnits.giftAllocationId,
        giftMatchMethod: paymentUnits.giftMatchMethod,
        giftNote: paymentUnits.giftNote,
      })
      .from(paymentUnits)
      .where(eq(paymentUnits.stripeChargeId, pair.chargeId))
      .for("update")
      .then((r) => r[0]);
    const chargeCountedRows: TieChargeLedgerRow[] =
      chargeUnit?.giftId != null
        ? [
            {
              id: chargeUnit.id,
              giftId: chargeUnit.giftId,
              matchMethod: chargeUnit.giftMatchMethod ?? "system",
              note: chargeUnit.giftNote,
            },
          ]
        : [];

    const decisions = decideChargeTieSupersede({
      tieConfirmed: charge.linkedQbStagedPaymentId === pair.qbStagedPaymentId,
      qbStagedPaymentId: pair.qbStagedPaymentId,
      qbRowAmount: qbRow.amount,
      chargeGross: charge.grossAmount,
      chargeNet: charge.netAmount,
      qbLedgerRows,
      chargeCountedRows,
    });
    if (decisions.length === 0) continue;

    const now = new Date();
    const marker = chargeTieSupersedeMarker(pair.qbStagedPaymentId);

    const bookCopyOnCharge = async (row: TieQbLedgerRow): Promise<boolean> => {
      const guard = checkBookOnce({
        paymentAmount: charge.grossAmount,
        // One gift per unit — a charge tie for a DIFFERENT gift surfaces as
        // AnchorAlreadyCountedError below, so there is no "other gifts" sum.
        otherAppliedSum: "0",
        newAmount: row.amountApplied,
      });
      // Conservative skip: booking stays on the QB row — safe, visible,
      // converged by a later re-run once the conflicting booking clears.
      if (!guard.ok) return false;
      try {
        await applyPaymentApplication(tx, {
          evidenceSource: "stripe",
          stripeChargeId: pair.chargeId,
          giftId: row.giftId,
          giftAllocationId: row.giftAllocationId,
          // COPY the human-ratified amount (exact-cents contract: it equals the
          // charge gross or net) — never re-stamp the gross over a net booking.
          amountApplied: row.amountApplied as string,
          // First-class supersede discriminator (revert clears by it); the
          // note below keeps the source QB row id as human-readable trail.
          matchMethod: "charge_tie_supersede",
          confirmedByUserId: row.confirmedByUserId,
          confirmedAt: row.confirmedAt,
          note: marker,
          createdTheGift: false,
        });
      } catch (e) {
        // Counted-uniqueness conservative skip: the charge unit is already
        // tied to a DIFFERENT gift. Same semantics as the guard skip —
        // booking stays on the QB row, converged by a later re-run once the
        // conflicting booking clears.
        if (e instanceof AnchorAlreadyCountedError) return false;
        throw e;
      }
      return true;
    };

    // Demote a counted QB unit tie: clear the tie facts, preserving them as
    // a supersede crumb so a revert can promote the booking back.
    const demoteQbUnit = async (row: TieQbLedgerRow): Promise<void> => {
      await writeSupersedeDemotionCrumb(tx, {
        paymentUnitId: row.paymentUnitId,
        giftId: row.giftId,
        matchMethod: row.matchMethod,
        confirmedByUserId: row.confirmedByUserId,
        confirmedAt: row.confirmedAt,
      });
      await tx
        .update(paymentUnits)
        .set({ ...CLEARED_TIE_FACTS, updatedAt: now })
        .where(eq(paymentUnits.id, row.paymentUnitId));
    };

    for (const d of decisions) {
      switch (d.action) {
        case "move": {
          if (!(await bookCopyOnCharge(d.qbRow))) break;
          await demoteQbUnit(d.qbRow);
          affectedGiftIds.add(d.qbRow.giftId);
          break;
        }
        case "demote_only": {
          await demoteQbUnit(d.qbRow);
          affectedGiftIds.add(d.qbRow.giftId);
          break;
        }
        case "book_only": {
          if (await bookCopyOnCharge(d.qbRow)) {
            affectedGiftIds.add(d.qbRow.giftId);
          }
          break;
        }
        case "remove_charge_row": {
          // Clear the tie-derived charge tie (d.chargeRow.id is the charge
          // unit id).
          await tx
            .update(paymentUnits)
            .set({ ...CLEARED_TIE_FACTS, updatedAt: now })
            .where(eq(paymentUnits.id, d.chargeRow.id));
          affectedGiftIds.add(d.chargeRow.giftId);
          break;
        }
        case "promote": {
          // A fresh counted booking on the crumb's unit: for the SAME gift
          // the crumb is stale — drop it; for a DIFFERENT gift skip
          // conservatively (the crumb stays; a later re-run promotes it once
          // that tie clears).
          const unit = qbUnits.find((u) => u.id === d.qbRow.paymentUnitId);
          if (unit?.giftId) {
            if (unit.giftId === d.qbRow.giftId) {
              await deleteSupersedeDemotionCrumb(tx, d.qbRow.id);
              affectedGiftIds.add(d.qbRow.giftId);
            }
            break;
          }
          // Book-once guard against the QB row's own cap. Plain epsilon — a
          // tied QB row was booked exactly (no gross-vs-net lump headroom
          // needed). A failure SKIPS the promote (stays a crumb: safe).
          const otherSum = await tx
            .select({
              total: sql<string>`coalesce(sum(${paymentUnits.grossAmount}), 0)::text`,
            })
            .from(paymentUnits)
            .where(
              and(
                eq(paymentUnits.sourceStagedPaymentId, pair.qbStagedPaymentId),
                isNotNull(paymentUnits.giftId),
                ne(paymentUnits.id, d.qbRow.paymentUnitId),
              ),
            )
            .then((r) => r[0]?.total ?? "0");
          const guard = checkBookOnce({
            paymentAmount: qbRow.amount,
            otherAppliedSum: otherSum,
            newAmount: d.qbRow.amountApplied,
          });
          if (!guard.ok) break;
          // Restore the tie onto the crumb's unit. The allocation pointer
          // travels with the charge-side copy (the crumb cannot carry it),
          // so it is restored from the tie-derived charge tie when present.
          const restoredAllocationId =
            chargeUnit?.giftId === d.qbRow.giftId &&
            chargeUnit.giftMatchMethod === "charge_tie_supersede"
              ? chargeUnit.giftAllocationId
              : null;
          await tx
            .update(paymentUnits)
            .set({
              giftId: d.qbRow.giftId,
              giftAllocationId: restoredAllocationId,
              giftMatchMethod: d.qbRow.matchMethod,
              giftConfirmedByUserId: d.qbRow.confirmedByUserId,
              giftConfirmedAt: d.qbRow.confirmedAt,
              giftNote: null,
              createdTheGift: false,
              updatedAt: now,
            })
            .where(eq(paymentUnits.id, d.qbRow.paymentUnitId));
          await deleteSupersedeDemotionCrumb(tx, d.qbRow.id);
          affectedGiftIds.add(d.qbRow.giftId);
          break;
        }
      }
    }
  }

  return [...affectedGiftIds];
}
