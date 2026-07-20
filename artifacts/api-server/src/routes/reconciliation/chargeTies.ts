import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  stripePayouts,
  stripeStagedCharges,
  stagedPayments,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { asyncHandler, notFound, parseOrBadRequest } from "../../lib/helpers";
import { getAppUser } from "../../lib/appRequest";
import { ReconcileAbort } from "../../lib/reconciliationCommit";
import { ConfirmPayoutChargeTiesBody } from "@workspace/api-zod";
import {
  assignManualChargeQbTies,
  claimSiblingFeeRows,
  type ChargeForTie,
  type QbRowForTie,
} from "../../lib/chargeQbTie";
import {
  chargeStatusSql,
  stagedStatusSql,
  stagedStatusWhere,
} from "../../lib/derivedStatus";
import { sweepRefundedQbStagedPayments } from "../../lib/refundedChargeSweep";
import { applyChargeTieSupersedePairs } from "../../lib/chargeTieSupersede";

/**
 * Charge-grain settlement confirm for "individually-booked" payouts — payouts
 * whose money the bookkeeper recorded as one QB row PER DONATION instead of a
 * single deposit lump, so the payout↔deposit settlement path can never tie
 * them. Confirming stamps each charge's permanent
 * `linked_qb_staged_payment_id` (+ who/when provenance) — settlement EVIDENCE
 * only (plane 1). It never mints a gift, never changes a QB row's status or
 * donor, and never touches settlement_links; per-charge → gift booking stays
 * with the Gift report.
 *
 * Two modes in one endpoint (see the OpenAPI description): approve the
 * system-proposed ties (no body), or manually tie explicitly-selected QB rows
 * ("Tie selected"). Both are all-or-nothing in one transaction with every
 * charge and QB row locked, so a concurrent claim aborts cleanly with a 409
 * instead of double-tying money.
 */
const router: IRouter = Router();

/** Charge review statuses that count as "already settled" for this report —
 * excluded charges never need (or get) a QB tie. */
const TERMINAL_CHARGE_STATUSES = ["excluded"] as const;

interface TieIssue {
  qbStagedPaymentId?: string;
  chargeId?: string;
  reason: string;
}

router.post(
  "/reconciliation/payouts/:payoutId/charge-ties/confirm",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const body = parseOrBadRequest(
      ConfirmPayoutChargeTiesBody,
      req.body ?? {},
      res,
    );
    if (!body) return;
    const payoutId = req.params.payoutId as string;
    const manualIds = body.qbStagedPaymentIds;
    if (manualIds !== undefined && manualIds.length === 0) {
      res.status(400).json({
        error: "bad_request",
        message: "qbStagedPaymentIds must contain at least one id.",
      });
      return;
    }
    if (manualIds && new Set(manualIds).size !== manualIds.length) {
      res.status(400).json({
        error: "bad_request",
        message: "qbStagedPaymentIds contains duplicates.",
      });
      return;
    }
    // PINNED manual tie: the caller names the exact charge (the per-charge
    // "Find the QuickBooks row" dialog). Only meaningful for exactly one row —
    // pinning several rows to one charge is a contradiction.
    const pinChargeId = body.chargeId;
    if (pinChargeId !== undefined && (manualIds?.length ?? 0) !== 1) {
      res.status(400).json({
        error: "bad_request",
        message:
          "chargeId requires exactly one qbStagedPaymentIds entry — a pinned tie places one QB row on one charge.",
      });
      return;
    }
    // Explicit-flag gating: the amount override exists ONLY for pinned ties.
    // Without a named charge the server assigns by exact amount, so there is
    // no coherent target for a mismatched row.
    if (body.overrideAmountMismatch && pinChargeId === undefined) {
      res.status(400).json({
        error: "bad_request",
        message:
          "overrideAmountMismatch requires chargeId — an amount override is only meaningful against an explicitly named charge.",
      });
      return;
    }

    const [payout] = await db
      .select({ id: stripePayouts.id })
      .from(stripePayouts)
      .where(eq(stripePayouts.id, payoutId))
      .limit(1);
    if (!payout) return notFound(res, "stripe payout");

    try {
      const result = await db.transaction(async (tx) => {
        const now = new Date();

        // Lock ALL of the payout's charges — the ones we stamp AND the ones
        // that decide payoutFullyTied — so nothing shifts mid-confirm.
        const charges = await tx
          .select({
            id: stripeStagedCharges.id,
            grossAmount: stripeStagedCharges.grossAmount,
            netAmount: stripeStagedCharges.netAmount,
            dateReceived: stripeStagedCharges.dateReceived,
            payerName: stripeStagedCharges.payerName,
            description: stripeStagedCharges.description,
            // DERIVED lifecycle status (no stored column) — lib/derivedStatus.ts.
            status: chargeStatusSql.as("status"),
            linkedQbStagedPaymentId:
              stripeStagedCharges.linkedQbStagedPaymentId,
            proposedQbStagedPaymentId:
              stripeStagedCharges.proposedQbStagedPaymentId,
          })
          .from(stripeStagedCharges)
          .where(eq(stripeStagedCharges.stripePayoutId, payoutId))
          .for("update");

        const openCharges = charges.filter(
          (c) =>
            c.linkedQbStagedPaymentId == null &&
            !TERMINAL_CHARGE_STATUSES.includes(
              c.status as (typeof TERMINAL_CHARGE_STATUSES)[number],
            ),
        );

        // chargeId → QB row id to confirm.
        let ties: Map<string, string>;

        if (manualIds === undefined) {
          // Mode A — approve the system-proposed ties.
          ties = new Map(
            openCharges
              .filter((c) => c.proposedQbStagedPaymentId != null)
              .map((c) => [c.id, c.proposedQbStagedPaymentId as string]),
          );
          if (ties.size === 0) {
            throw new ReconcileAbort(409, {
              error: "nothing_proposed",
              message:
                "No charge of this payout carries a proposed QuickBooks tie.",
            });
          }
        } else {
          // Mode B — manual "Tie selected": place every given QB row onto a
          // distinct untied charge by exact amount (name/date only order the
          // assignment; the human asserted these rows are this payout's money).
          const rows = await tx
            .select({
              id: stagedPayments.id,
              amount: stagedPayments.amount,
              dateReceived: stagedPayments.dateReceived,
              payerName: stagedPayments.payerName,
              // DERIVED lifecycle status (no stored column).
              status: stagedStatusSql.as("status"),
            })
            .from(stagedPayments)
            .where(inArray(stagedPayments.id, manualIds))
            .for("update");
          const rowById = new Map(rows.map((r) => [r.id, r]));
          const issues: TieIssue[] = [];
          // Deliberate human override for excluded rows: the picker labels
          // excluded rows (never hides them) and a second click asserts "this
          // IS the payout's money". Collect them for an in-tx re-include
          // (rows are already FOR UPDATE-locked above).
          const overrideExcludedIds: string[] = [];
          for (const id of manualIds) {
            const row = rowById.get(id);
            if (!row) {
              issues.push({
                qbStagedPaymentId: id,
                reason: "QuickBooks row no longer exists.",
              });
            } else if (row.status === "excluded") {
              if (body.overrideExclusion) {
                overrideExcludedIds.push(id);
              } else {
                issues.push({
                  qbStagedPaymentId: id,
                  reason: `QuickBooks row is ${row.status} — only active rows can be tied.`,
                });
              }
            }
          }
          if (issues.length > 0) {
            throw new ReconcileAbort(409, {
              error: "qb_rows_unavailable",
              message: "Some selected QuickBooks rows cannot be tied.",
              details: { issues },
            });
          }
          // Re-include the overridden rows exactly like the
          // /staged-payments/:id/re-include primitive: clearing the exclusion
          // IS the re-include (status is derived), and classification_source
          // 'manual' pins it so the re-runnable classifier never re-excludes.
          if (overrideExcludedIds.length > 0) {
            await tx
              .update(stagedPayments)
              .set({
                exclusionReason: null,
                classificationSource: "manual",
                updatedAt: new Date(),
              })
              .where(
                and(
                  inArray(stagedPayments.id, overrideExcludedIds),
                  stagedStatusWhere.excluded,
                ),
              );
          }
          const chargesForTie: ChargeForTie[] = openCharges.map((c) => ({
            id: c.id,
            grossAmount: c.grossAmount,
            netAmount: c.netAmount,
            dateReceived: c.dateReceived,
            payerName: c.payerName,
            description: c.description,
          }));
          const rowsForTie: QbRowForTie[] = manualIds.map((id) => {
            const r = rowById.get(id)!;
            return {
              id: r.id,
              amount: r.amount,
              dateReceived: r.dateReceived,
              payerName: r.payerName,
            };
          });
          if (pinChargeId !== undefined) {
            // PINNED tie: the human named the exact charge, so the ONLY open
            // question is the exact-amount rule. Reuse the same matcher on
            // the single (charge, row) pair; a mismatch is overridable by the
            // explicit overrideAmountMismatch assertion — never implicitly.
            const target = chargesForTie.find((c) => c.id === pinChargeId);
            if (!target) {
              const anywhere = charges.find((c) => c.id === pinChargeId);
              if (!anywhere) {
                throw new ReconcileAbort(404, {
                  error: "not_found",
                  message: "That charge does not belong to this payout.",
                });
              }
              throw new ReconcileAbort(409, {
                error: "charge_unavailable",
                message:
                  anywhere.linkedQbStagedPaymentId != null
                    ? "That charge already carries a confirmed QuickBooks tie — untie it first."
                    : "That charge is excluded — excluded charges never get a QuickBooks tie.",
                details: {
                  issues: [
                    { chargeId: pinChargeId, reason: "charge unavailable" },
                  ],
                },
              });
            }
            const rowId = manualIds[0]!;
            const pinned = assignManualChargeQbTies([target], rowsForTie);
            if (pinned.issues.length > 0 && !body.overrideAmountMismatch) {
              throw new ReconcileAbort(409, {
                error: "amount_mismatch",
                message:
                  "The QuickBooks row's amount matches neither the charge's gross nor its net. Confirm the override to tie it anyway.",
                details: { issues: pinned.issues },
              });
            }
            // Either an exact fit, or the human overrode the amount rule —
            // the tie target is the pinned charge either way.
            ties = new Map([[pinChargeId, rowId]]);
          } else {
            const manual = assignManualChargeQbTies(chargesForTie, rowsForTie);
            if (manual.issues.length > 0) {
              throw new ReconcileAbort(409, {
                error: "unassignable_qb_rows",
                message:
                  "Some selected QuickBooks rows match no untied charge of this payout by exact amount (gross or net).",
                details: { issues: manual.issues },
              });
            }
            ties = manual.assigned;
          }
        }

        // Shared availability guard: no QB row may already be spoken for —
        // tied to some other charge, or serving as a settlement-link deposit
        // in any lifecycle. (Manual mode re-checks too: selection lists can
        // go stale between render and click.)
        const qbIds = [...new Set(ties.values())];
        if (qbIds.length !== ties.size) {
          throw new ReconcileAbort(409, {
            error: "duplicate_qb_tie",
            message:
              "Two charges resolved to the same QuickBooks row. Re-run proposals and retry.",
          });
        }
        // Mode A locks its QB rows here (mode B already locked them above).
        if (manualIds === undefined) {
          const proposalRows = await tx
            .select({
              id: stagedPayments.id,
              // DERIVED lifecycle status (no stored column).
              status: stagedStatusSql.as("status"),
            })
            .from(stagedPayments)
            .where(inArray(stagedPayments.id, qbIds))
            .for("update");
          const byId = new Map(proposalRows.map((r) => [r.id, r]));
          const issues: TieIssue[] = [];
          for (const id of qbIds) {
            const row = byId.get(id);
            if (!row) {
              issues.push({
                qbStagedPaymentId: id,
                reason: "Proposed QuickBooks row no longer exists.",
              });
            } else if (row.status === "excluded") {
              issues.push({
                qbStagedPaymentId: id,
                reason: `Proposed QuickBooks row is now ${row.status}.`,
              });
            }
          }
          if (issues.length > 0) {
            throw new ReconcileAbort(409, {
              error: "qb_rows_unavailable",
              message:
                "Some proposed QuickBooks rows are no longer available. Re-run proposals and retry.",
              details: { issues },
            });
          }
        }
        const conflicts = await tx
          .select({
            qbId: stagedPayments.id,
            tiedCharge: sql<string | null>`(
              SELECT cc.id FROM stripe_staged_charges cc
              WHERE cc.linked_qb_staged_payment_id = ${stagedPayments.id}
              LIMIT 1
            )`,
            settlementLinked: sql<boolean>`EXISTS (
              SELECT 1 FROM settlement_links sl
              WHERE sl.deposit_staged_payment_id = ${stagedPayments.id}
            )`,
          })
          .from(stagedPayments)
          .where(inArray(stagedPayments.id, qbIds));
        const conflictIssues: TieIssue[] = [];
        for (const c of conflicts) {
          if (c.tiedCharge != null) {
            conflictIssues.push({
              qbStagedPaymentId: c.qbId,
              reason:
                "QuickBooks row is already tied to another Stripe charge.",
            });
          } else if (c.settlementLinked) {
            conflictIssues.push({
              qbStagedPaymentId: c.qbId,
              reason:
                "QuickBooks row is already a payout settlement-link deposit.",
            });
          }
        }
        if (conflictIssues.length > 0) {
          throw new ReconcileAbort(409, {
            error: "qb_rows_claimed",
            message:
              "Some QuickBooks rows were claimed elsewhere in the meantime. Reload and retry.",
            details: { issues: conflictIssues },
          });
        }

        // Stamp every tie, each guarded on the charge still being untied (the
        // FOR UPDATE lock makes drift impossible, but the guard keeps the
        // write self-defending if this code is ever called without it).
        let tied = 0;
        for (const [chargeId, qbId] of ties) {
          const upd = await tx
            .update(stripeStagedCharges)
            .set({
              linkedQbStagedPaymentId: qbId,
              proposedQbStagedPaymentId: null,
              crossProcessorLinkedByUserId: user.id,
              crossProcessorLinkedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(stripeStagedCharges.id, chargeId),
                isNull(stripeStagedCharges.linkedQbStagedPaymentId),
              ),
            )
            .returning({ id: stripeStagedCharges.id });
          if (upd.length === 0) {
            throw new ReconcileAbort(409, {
              error: "charge_tie_drift",
              message:
                "A charge's tie changed mid-confirm. Reload and retry.",
              details: { issues: [{ chargeId, reason: "already tied" }] },
            });
          }
          tied += 1;
        }

        // Auto-claim the sibling NEGATIVE "Stripe fee" QB rows of the same
        // deposits (amount exactly −(gross − net)) — plane-1 settlement
        // evidence only; fee rows never enter payment_applications. Both
        // modes run this; manual mode auto-grabs too but the response
        // surfaces the count so nothing happens silently.
        const chargeAmounts = new Map(
          charges.map((c) => [
            c.id,
            { grossAmount: c.grossAmount, netAmount: c.netAmount },
          ]),
        );
        const feeRowsTied = await claimSiblingFeeRows(
          tx,
          [...ties].map(([chargeId, qbId]) => ({ chargeId, qbId })),
          chargeAmounts,
        );

        // Move each tied QB row's counted gift booking to the CHARGE grain
        // (charge-tie supersede): the ledger then shows gift ↔ charge ↔ QB
        // row as ONE money trail instead of leaving the charge looking
        // unbooked. Exact-cents same-money test; override-mismatch ties
        // conservatively keep their QB-side booking.
        const supersededGiftIds = await applyChargeTieSupersedePairs(
          tx,
          [...ties].map(([chargeId, qbId]) => ({
            chargeId,
            qbStagedPaymentId: qbId,
          })),
        );

        // Fully tied when every charge is either confirmed-tied or terminal.
        const stillOpen = openCharges.filter((c) => !ties.has(c.id)).length;
        const payoutFullyTied = charges.length > 0 && stillOpen === 0;

        return {
          confirmed: true,
          payoutId,
          tied,
          feeRowsTied,
          payoutFullyTied,
          supersededGiftIds,
        };
      });

      req.log.info(
        {
          payoutId,
          tied: result.tied,
          feeRowsTied: result.feeRowsTied,
          fullyTied: result.payoutFullyTied,
          supersededGifts: result.supersededGiftIds.length,
        },
        "Confirmed charge-grain Stripe↔QB ties",
      );

      // A just-confirmed tie can complete a pending QB row's Stripe trace as
      // all-refunded money — sweep so it lands in Excluded immediately.
      await sweepRefundedQbStagedPayments();

      const { supersededGiftIds: _superseded, ...response } = result;
      res.json(response);
    } catch (e) {
      if (e instanceof ReconcileAbort) {
        res.status(e.httpStatus).json(e.payload);
        return;
      }
      throw e;
    }
  }),
);

/**
 * Per-row reject of ONE proposed charge↔QB tie (the "Missing deposit" card's
 * per-charge Reject). Clears the proposal only — the pair is NOT persistently
 * dismissed, so a later proposal pass may re-propose it (the human can simply
 * reject again, or manually "Tie selected" a different row). Plane 1 only:
 * no gift, QB row, or settlement link is touched.
 */
router.post(
  "/reconciliation/charges/:chargeId/qb-tie/reject",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const chargeId = req.params.chargeId as string;

    try {
      const result = await db.transaction(async (tx) => {
        const [charge] = await tx
          .select({
            id: stripeStagedCharges.id,
            linkedQbStagedPaymentId:
              stripeStagedCharges.linkedQbStagedPaymentId,
            proposedQbStagedPaymentId:
              stripeStagedCharges.proposedQbStagedPaymentId,
          })
          .from(stripeStagedCharges)
          .where(eq(stripeStagedCharges.id, chargeId))
          .for("update");
        if (!charge) {
          throw new ReconcileAbort(404, {
            error: "not_found",
            message: "Stripe charge not found.",
          });
        }
        if (charge.linkedQbStagedPaymentId != null) {
          throw new ReconcileAbort(409, {
            error: "already_confirmed",
            message:
              "This charge's QuickBooks tie is already confirmed — reverting a confirmed tie is a separate path.",
          });
        }
        const qbId = charge.proposedQbStagedPaymentId;
        if (qbId == null) {
          throw new ReconcileAbort(409, {
            error: "nothing_proposed",
            message: "This charge has no proposed QuickBooks tie to reject.",
          });
        }

        // Clear the proposal — guarded on the exact proposal we read still
        // being in place (the FOR UPDATE lock makes drift impossible; the
        // guard keeps the write self-defending).
        const upd = await tx
          .update(stripeStagedCharges)
          .set({
            proposedQbStagedPaymentId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(stripeStagedCharges.id, chargeId),
              eq(stripeStagedCharges.proposedQbStagedPaymentId, qbId),
              isNull(stripeStagedCharges.linkedQbStagedPaymentId),
            ),
          )
          .returning({ id: stripeStagedCharges.id });
        if (upd.length === 0) {
          throw new ReconcileAbort(409, {
            error: "charge_tie_drift",
            message: "The charge's tie changed mid-reject. Reload and retry.",
          });
        }

        return { rejected: true, chargeId, qbStagedPaymentId: qbId };
      });

      req.log.info(
        { chargeId, qbStagedPaymentId: result.qbStagedPaymentId },
        "Rejected a proposed charge-grain Stripe↔QB tie",
      );
      res.json(result);
    } catch (e) {
      if (e instanceof ReconcileAbort) {
        res.status(e.httpStatus).json(e.payload);
        return;
      }
      throw e;
    }
  }),
);

/**
 * Revert ONE CONFIRMED charge↔QB tie — the undo for an accidental or wrong
 * confirm (the "separate path" the reject endpoint's 409 points at). Clears
 * the charge's permanent `linked_qb_staged_payment_id` (+ who/when
 * provenance) and frees the sibling negative "Stripe fee" QB row claimed at
 * confirm time, if any. Plane 1 only: no gift, donor, or settlement link is
 * touched — both statuses are derived, so the QB row returns to the open
 * review flow and the charge reopens for a new tie on their own. The original
 * proposal is NOT restored and the pair is NOT remembered as dismissed, so a
 * later proposal pass may re-propose it. One deliberate asymmetry: a confirm
 * done with overrideExclusion cleared the QB row's exclusion_reason (manual
 * pin) — revert does NOT restore that exclusion; the row returns to review as
 * pending for a human to re-classify.
 */
router.post(
  "/reconciliation/charges/:chargeId/qb-tie/revert",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const chargeId = req.params.chargeId as string;

    try {
      const result = await db.transaction(async (tx) => {
        const [charge] = await tx
          .select({
            id: stripeStagedCharges.id,
            linkedQbStagedPaymentId:
              stripeStagedCharges.linkedQbStagedPaymentId,
            linkedFeeQbStagedPaymentId:
              stripeStagedCharges.linkedFeeQbStagedPaymentId,
          })
          .from(stripeStagedCharges)
          .where(eq(stripeStagedCharges.id, chargeId))
          .for("update");
        if (!charge) {
          throw new ReconcileAbort(404, {
            error: "not_found",
            message: "Stripe charge not found.",
          });
        }
        const qbId = charge.linkedQbStagedPaymentId;
        if (qbId == null) {
          throw new ReconcileAbort(409, {
            error: "not_confirmed",
            message:
              "This charge has no confirmed QuickBooks tie to revert (an unconfirmed proposal is rejected instead).",
          });
        }
        const feeQbId = charge.linkedFeeQbStagedPaymentId;

        // Clear the tie — guarded on the exact link we read still being in
        // place (the FOR UPDATE lock makes drift impossible; the guard keeps
        // the write self-defending).
        const upd = await tx
          .update(stripeStagedCharges)
          .set({
            linkedQbStagedPaymentId: null,
            linkedFeeQbStagedPaymentId: null,
            crossProcessorLinkedByUserId: null,
            crossProcessorLinkedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(stripeStagedCharges.id, chargeId),
              eq(stripeStagedCharges.linkedQbStagedPaymentId, qbId),
            ),
          )
          .returning({ id: stripeStagedCharges.id });
        if (upd.length === 0) {
          throw new ReconcileAbort(409, {
            error: "charge_tie_drift",
            message: "The charge's tie changed mid-revert. Reload and retry.",
          });
        }

        // Undo the charge-tie supersede: delete the tie-derived (marked)
        // stripe counted rows and promote the demoted QB rows back to
        // counted — the gift booking returns to where the human originally
        // ratified it. Pre-existing (unmarked) charge bookings are never
        // touched.
        const supersededGiftIds = await applyChargeTieSupersedePairs(tx, [
          { chargeId, qbStagedPaymentId: qbId },
        ]);

        return {
          reverted: true,
          chargeId,
          qbStagedPaymentId: qbId,
          feeQbStagedPaymentId: feeQbId,
          supersededGiftIds,
        };
      });

      req.log.info(
        {
          chargeId,
          qbStagedPaymentId: result.qbStagedPaymentId,
          feeQbStagedPaymentId: result.feeQbStagedPaymentId,
          supersededGifts: result.supersededGiftIds.length,
        },
        "Reverted a confirmed charge-grain Stripe↔QB tie",
      );

      const { supersededGiftIds: _superseded, ...response } = result;
      res.json(response);
    } catch (e) {
      if (e instanceof ReconcileAbort) {
        res.status(e.httpStatus).json(e.payload);
        return;
      }
      throw e;
    }
  }),
);

export default router;
