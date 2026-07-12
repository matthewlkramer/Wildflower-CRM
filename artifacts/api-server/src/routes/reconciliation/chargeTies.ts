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
  type ChargeForTie,
  type QbRowForTie,
} from "../../lib/chargeQbTie";

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
 * excluded/rejected charges never need (or get) a QB tie. */
const TERMINAL_CHARGE_STATUSES = ["excluded", "rejected"] as const;

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
            dateReceived: stripeStagedCharges.dateReceived,
            payerName: stripeStagedCharges.payerName,
            description: stripeStagedCharges.description,
            status: stripeStagedCharges.status,
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
              status: stagedPayments.status,
            })
            .from(stagedPayments)
            .where(inArray(stagedPayments.id, manualIds))
            .for("update");
          const rowById = new Map(rows.map((r) => [r.id, r]));
          const issues: TieIssue[] = [];
          for (const id of manualIds) {
            const row = rowById.get(id);
            if (!row) {
              issues.push({
                qbStagedPaymentId: id,
                reason: "QuickBooks row no longer exists.",
              });
            } else if (
              !["pending", "approved", "reconciled"].includes(row.status)
            ) {
              issues.push({
                qbStagedPaymentId: id,
                reason: `QuickBooks row is ${row.status} — only active rows can be tied.`,
              });
            }
          }
          if (issues.length > 0) {
            throw new ReconcileAbort(409, {
              error: "qb_rows_unavailable",
              message: "Some selected QuickBooks rows cannot be tied.",
              details: { issues },
            });
          }
          const chargesForTie: ChargeForTie[] = openCharges.map((c) => ({
            id: c.id,
            grossAmount: c.grossAmount,
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
          const manual = assignManualChargeQbTies(chargesForTie, rowsForTie);
          if (manual.issues.length > 0) {
            throw new ReconcileAbort(409, {
              error: "unassignable_qb_rows",
              message:
                "Some selected QuickBooks rows match no untied charge of this payout by exact amount.",
              details: { issues: manual.issues },
            });
          }
          ties = manual.assigned;
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
            .select({ id: stagedPayments.id, status: stagedPayments.status })
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
            } else if (
              !["pending", "approved", "reconciled"].includes(row.status)
            ) {
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

        // Fully tied when every charge is either confirmed-tied or terminal.
        const stillOpen = openCharges.filter((c) => !ties.has(c.id)).length;
        const payoutFullyTied = charges.length > 0 && stillOpen === 0;

        return { confirmed: true, payoutId, tied, payoutFullyTied };
      });

      req.log.info(
        { payoutId, tied: result.tied, fullyTied: result.payoutFullyTied },
        "Confirmed charge-grain Stripe↔QB ties",
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

export default router;
