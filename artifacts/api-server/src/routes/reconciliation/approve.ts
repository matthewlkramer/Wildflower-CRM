import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  stagedPayments,
  giftsAndPayments,
  opportunitiesAndPledges,
  stripeStagedCharges,
  stripePayouts,
} from "@workspace/db/schema";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { asyncHandler, newId, notFound } from "../../lib/helpers";
import { getAppUser } from "../../lib/appRequest";
import {
  ApproveReconciliationCardBody,
  validateGiftInvariants,
} from "@workspace/api-zod";
import { donorOf } from "../../lib/quickbooksLink";
import {
  stampGiftFinalAmount,
  adjustSingleAllocationOrFlag,
} from "../../lib/giftFinalAmount";
import { buildGiftValuesFromStaged } from "../../lib/quickbooksGift";
import { applyDerivedOppFieldsMany } from "../../lib/pledgeStage";
import { recordAudit } from "../../lib/audit";
import { runConsistencyGate } from "../../lib/reconciliationGate";

const router: IRouter = Router();

/**
 * Aborts the approve transaction with a chosen HTTP status + JSON body. Thrown
 * from inside the tx so the row mutations roll back; caught after the tx and
 * turned into the response. Lets the consistency gate (and the in-tx existence /
 * race re-checks) run on FRESHLY-LOCKED rows yet still return a clean status.
 */
class ApproveAbort extends Error {
  constructor(
    readonly httpStatus: number,
    readonly payload: Record<string, unknown>,
  ) {
    super("approve_abort");
  }
}

// ─── POST /reconciliation/cards/:stagedPaymentId/approve ───────────────────
// Human approval of a complete-match card. The server RE-DERIVES and
// RE-VALIDATES the whole graph from the DB (it never trusts UI-supplied locks),
// and — to be race-safe — does so INSIDE the transaction AFTER taking the row
// locks, so the gate can't pass on a row that another request mutates before we
// write. Commits in ONE transaction.
//
// E3 implements `link_existing_gift`: tie the QuickBooks staged row (and, when
// supplied, a Stripe charge) to an EXISTING gift as permanent reconciliation
// evidence — no new gift, never archived. E4 adds `create_gift`: human-mint a NEW
// gift from the QB evidence for a chosen donor — the QB anchor OWNS the mint
// (createdGiftId, not auto-applied → protected from casual revert, exactly like
// the manual create-gift route); a Stripe charge, when selected, supplies the
// precise GROSS and stays matchedGiftId-linked (revert un-sources the amount,
// never deletes the human mint). Either way the gift is the single source of
// truth; its FINAL amount is the Stripe GROSS when a charge is selected, else the
// QB staged amount. The opportunity outcomes (create_gift_from_opportunity /
// convert_to_pledge_and_first_payment) are added in E5.
router.post(
  "/reconciliation/cards/:stagedPaymentId/approve",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const stagedPaymentId = String(req.params.stagedPaymentId ?? "");

    const parsed = ApproveReconciliationCardBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const body = parsed.data;

    // E3/E4 ship link_existing_gift + create_gift; the opportunity outcomes (E5)
    // are still rejected until implemented.
    if (
      body.outcome !== "link_existing_gift" &&
      body.outcome !== "create_gift"
    ) {
      res.status(400).json({
        error: "unsupported_outcome",
        message: `Outcome '${body.outcome}' is not yet supported.`,
      });
      return;
    }

    // ── create_gift (E4): human-only mint ───────────────────────────────────
    // Mint a NEW gift from the QB staged evidence for the human-chosen donor and
    // tie the QB row (and, when supplied, a Stripe charge) to it as permanent
    // reconciliation evidence. Minting is HUMAN-ONLY — there is no background
    // auto-mint on this path. The gift is HEADER-only (no allocations; a fundraiser
    // apportions afterward, exactly like the manual create-gift route).
    if (body.outcome === "create_gift") {
      const donor = {
        organizationId: body.organizationId ?? null,
        individualGiverPersonId: body.individualGiverPersonId ?? null,
        householdId: body.householdId ?? null,
      };
      // The donor is human-CHOSEN (no gift to derive it from yet), so validate
      // Donor XOR up front for a clean 400 before any locking.
      const donorIssues = validateGiftInvariants(donor);
      if (donorIssues.length) {
        res.status(400).json({
          error: "validation_error",
          message: "A new gift needs exactly one donor (Donor XOR).",
          details: { issues: donorIssues },
        });
        return;
      }
      const stripeChargeId = body.stripeChargeId ?? null;

      // Fast non-locking guard: only a pending staged row can mint. (create_gift
      // is intentionally NOT idempotent — re-approving an already-reconciled row
      // must not mint a second gift.)
      const pre = await db
        .select({ status: stagedPayments.status })
        .from(stagedPayments)
        .where(eq(stagedPayments.id, stagedPaymentId))
        .then((r) => r[0]);
      if (!pre) return notFound(res, "staged payment");
      if (pre.status !== "pending") {
        res.status(409).json({
          error: "not_approvable",
          message:
            "This staged payment is no longer pending. Refresh and try again.",
        });
        return;
      }

      // Payouts tied to this staged row — a selected charge must belong to one,
      // and they're the lock targets that serialize us against stripeConfirm.
      const stagedPayoutRows = await db
        .select({ id: stripePayouts.id })
        .from(stripePayouts)
        .where(
          or(
            eq(stripePayouts.matchedQbStagedPaymentId, stagedPaymentId),
            eq(stripePayouts.proposedQbStagedPaymentId, stagedPaymentId),
          ),
        );
      const stagedPayoutIds = stagedPayoutRows.map((r) => r.id);

      const newGiftId = newId();
      try {
        await db.transaction(async (tx) => {
          // Lock order (mirrors the link path + stripeConfirm): payouts → staged
          // → charge. No existing gift to lock — we mint a fresh row.
          if (stagedPayoutIds.length > 0) {
            await tx
              .select({ id: stripePayouts.id })
              .from(stripePayouts)
              .where(inArray(stripePayouts.id, stagedPayoutIds))
              .orderBy(stripePayouts.id)
              .for("update");
          }

          const staged = await tx
            .select()
            .from(stagedPayments)
            .where(eq(stagedPayments.id, stagedPaymentId))
            .for("update")
            .then((r) => r[0]);
          if (!staged) {
            throw new ApproveAbort(404, {
              error: "not_found",
              message: "staged payment not found",
            });
          }
          if (staged.status !== "pending") {
            throw new ApproveAbort(409, {
              error: "not_approvable",
              message:
                "This staged payment is no longer pending. Refresh and try again.",
            });
          }

          let charge: typeof stripeStagedCharges.$inferSelect | null = null;
          if (stripeChargeId) {
            charge =
              (await tx
                .select()
                .from(stripeStagedCharges)
                .where(eq(stripeStagedCharges.id, stripeChargeId))
                .for("update")
                .then((r) => r[0])) ?? null;
            if (!charge) {
              throw new ApproveAbort(404, {
                error: "not_found",
                message: "stripe charge not found",
              });
            }
            // A fresh mint can only claim a still-free (pending) charge.
            if (charge.status !== "pending") {
              throw new ApproveAbort(409, {
                error: "stripe_charge_not_available",
                message:
                  "The selected Stripe charge has already been resolved. Refresh and try again.",
              });
            }
          }

          // Stripe GROSS is the precise amount when a charge is selected; else the
          // QB staged amount. This IS the minted gift's amount (no prior human
          // figure), so the gate's amount-band check is trivially satisfied.
          const evidenceAmount = charge ? charge.grossAmount : staged.amount;

          // When no charge is selected but the tied payouts still carry
          // unreconciled charges, Stripe precedence demands one be chosen up front
          // (a QB-only mint could never adopt its charge later on this path).
          let stripeChargesAvailable = 0;
          if (!charge && stagedPayoutIds.length > 0) {
            const [{ n } = { n: 0 }] = await tx
              .select({ n: sql<number>`COUNT(*)::int` })
              .from(stripeStagedCharges)
              .where(
                and(
                  inArray(stripeStagedCharges.stripePayoutId, stagedPayoutIds),
                  ne(stripeStagedCharges.status, "reconciled"),
                ),
              );
            stripeChargesAvailable = n;
          }

          // Consistency gate over the SYNTHETIC new gift (Donor XOR, Stripe
          // precedence + linkage, the QB anchor; amount band is trivially met).
          const issues = runConsistencyGate({
            staged: { id: staged.id, status: staged.status },
            gift: {
              id: newGiftId,
              amount: evidenceAmount,
              archivedAt: null,
              organizationId: donor.organizationId,
              individualGiverPersonId: donor.individualGiverPersonId,
              householdId: donor.householdId,
              finalAmountSource: null,
              finalAmountStripeChargeId: null,
            },
            opportunity: null,
            evidenceAmount,
            stripeCharge: charge
              ? { id: charge.id, stripePayoutId: charge.stripePayoutId }
              : null,
            stagedPayoutIds,
            stripeChargesAvailable,
            overrideAmountMismatchReason:
              body.overrideAmountMismatchReason ?? null,
          });
          if (issues.length > 0) {
            throw new ApproveAbort(409, {
              error: "consistency_gate",
              message: "The reconciliation graph isn't consistent.",
              details: { issues },
            });
          }

          // Mint the gift HEADER. The amount is the FINAL amount, stamped at
          // insert from the chosen evidence (single XOR pointer); no prior human
          // figure exists, so original_human_crm_amount stays null.
          await tx.insert(giftsAndPayments).values({
            ...buildGiftValuesFromStaged(
              newGiftId,
              {
                qbEntityType: staged.qbEntityType,
                qbEntityId: staged.qbEntityId,
                amount: staged.amount,
                dateReceived: staged.dateReceived,
                payerName: staged.payerName,
                rawReference: staged.rawReference,
                organizationId: donor.organizationId,
                individualGiverPersonId: donor.individualGiverPersonId,
                householdId: donor.householdId,
                matchedPaymentIntermediaryId:
                  body.paymentIntermediaryId ??
                  staged.matchedPaymentIntermediaryId,
              },
              user.id,
            ),
            amount: evidenceAmount,
            ...(charge
              ? {
                  processorFee: charge.feeAmount,
                  finalAmountSource: "stripe" as const,
                  finalAmountStripeChargeId: charge.id,
                  finalAmountQbStagedPaymentId: null,
                }
              : {
                  finalAmountSource: "quickbooks" as const,
                  finalAmountQbStagedPaymentId: stagedPaymentId,
                  finalAmountStripeChargeId: null,
                }),
            originalHumanCrmAmount: null,
          });

          // The QB anchor OWNS the mint (createdGiftId, not auto-applied →
          // protected from casual revert). Adopt the chosen donor onto the
          // evidence row. Guarded on still-pending to catch a concurrent resolve.
          const updated = await tx
            .update(stagedPayments)
            .set({
              ...donor,
              status: "reconciled",
              createdGiftId: newGiftId,
              matchedGiftId: null,
              autoApplied: false,
              matchStatus: "matched",
              matchConfirmedByUserId: user.id,
              matchConfirmedAt: new Date(),
              approvedByUserId: user.id,
              approvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(stagedPayments.id, stagedPaymentId),
                eq(stagedPayments.status, "pending"),
              ),
            )
            .returning({ id: stagedPayments.id });
          if (updated.length === 0) {
            throw new ApproveAbort(409, {
              error: "not_approvable",
              message:
                "This staged payment is no longer pending. Refresh and try again.",
            });
          }

          // A selected Stripe charge is the precise GROSS source: tie it to the
          // gift via matchedGiftId (mirrors E3 + the Stripe confirm paths) so it
          // stays resolvable + revertible — revert un-sources the amount, never
          // deletes the human mint the QB anchor owns. Mark its payout reconciled.
          if (charge) {
            await tx
              .update(stripeStagedCharges)
              .set({
                ...donor,
                status: "reconciled",
                matchedGiftId: newGiftId,
                createdGiftId: null,
                autoApplied: false,
                matchStatus: "matched",
                matchConfirmedByUserId: user.id,
                matchConfirmedAt: new Date(),
                approvedByUserId: user.id,
                approvedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(stripeStagedCharges.id, charge.id));
            if (charge.stripePayoutId) {
              await tx
                .update(stripePayouts)
                .set({
                  qbReconciliationStatus: "confirmed_reconciled",
                  matchedQbStagedPaymentId: stagedPaymentId,
                  proposedQbStagedPaymentId: null,
                  qbReconciliationConfirmedByUserId: user.id,
                  qbReconciliationConfirmedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(eq(stripePayouts.id, charge.stripePayoutId));
            }
          }

          await recordAudit(tx, req, {
            action: "create",
            entityType: "gift",
            entityId: newGiftId,
            summary: "Created gift from reconciliation (complete match)",
            metadata: {
              stagedPaymentId,
              stripeChargeId: charge?.id ?? null,
              outcome: "create_gift",
            },
          });
        });
      } catch (e) {
        if (e instanceof ApproveAbort) {
          res.status(e.httpStatus).json(e.payload);
          return;
        }
        // Unique violation: a Stripe charge just got claimed by another gift, or
        // the gift's stripe-charge pointer collided. Surface as a conflict.
        if (
          typeof e === "object" &&
          e !== null &&
          "code" in e &&
          (e as { code?: string }).code === "23505"
        ) {
          res.status(409).json({
            error: "link_conflict",
            message:
              "That Stripe charge was just linked to another gift. Refresh and try again.",
          });
          return;
        }
        throw e;
      }

      res.status(201).json({
        ok: true as const,
        outcome: "create_gift" as const,
        stagedPaymentId,
        giftId: newGiftId,
        opportunityId: null,
        createdGift: true,
        createdPledge: false,
      });
      return;
    }

    const giftId = body.giftId ?? null;
    if (!giftId) {
      res.status(400).json({
        error: "validation_error",
        message: "giftId is required to link an existing gift.",
      });
      return;
    }
    const opportunityId = body.opportunityId ?? null;
    const stripeChargeId = body.stripeChargeId ?? null;

    // ── Fast idempotency path (non-locking) ──────────────────────────────────
    // A card already reconciled to THIS gift returns its current state; to a
    // different gift is a conflict. The authoritative, race-safe checks run
    // again inside the transaction below.
    const pre = await db
      .select({
        status: stagedPayments.status,
        matchedGiftId: stagedPayments.matchedGiftId,
        groupReconciledGiftId: stagedPayments.groupReconciledGiftId,
      })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, stagedPaymentId))
      .then((r) => r[0]);
    if (!pre) return notFound(res, "staged payment");
    if (pre.status === "reconciled") {
      const tiedGiftId = pre.matchedGiftId ?? pre.groupReconciledGiftId ?? null;
      if (tiedGiftId === giftId) {
        res.json({
          ok: true as const,
          outcome: "link_existing_gift" as const,
          stagedPaymentId,
          giftId,
          opportunityId,
          createdGift: false,
          createdPledge: false,
        });
        return;
      }
      res.status(409).json({
        error: "not_approvable",
        message: "This payment is already reconciled to a different gift.",
      });
      return;
    }

    // Payouts tied to this staged row — a selected charge must belong to one,
    // and they're the lock targets that serialize us against stripeConfirm.
    // (Read-only; the charge↔payout membership is re-validated by the gate.)
    const stagedPayoutRows = await db
      .select({ id: stripePayouts.id })
      .from(stripePayouts)
      .where(
        or(
          eq(stripePayouts.matchedQbStagedPaymentId, stagedPaymentId),
          eq(stripePayouts.proposedQbStagedPaymentId, stagedPaymentId),
        ),
      );
    const stagedPayoutIds = stagedPayoutRows.map((r) => r.id);

    // Pledges whose derived fields must be recomputed AFTER commit (a newly
    // linked payment, or a changed gift amount, shifts a pledge's paid total).
    const rederivePledgeIds: Array<string | null> = [];

    // ── Atomic apply ─────────────────────────────────────────────────────────
    // Lock order matches every other money path so they serialize without
    // deadlocking: payout (mirroring stripeConfirm) → staged → gift (mirroring
    // the legacy reconcile) → opportunity → charge. Rows are RE-READ here under
    // the locks; the gate then validates the just-locked state.
    try {
      await db.transaction(async (tx) => {
        if (stagedPayoutIds.length > 0) {
          await tx
            .select({ id: stripePayouts.id })
            .from(stripePayouts)
            .where(inArray(stripePayouts.id, stagedPayoutIds))
            .orderBy(stripePayouts.id)
            .for("update");
        }

        const staged = await tx
          .select()
          .from(stagedPayments)
          .where(eq(stagedPayments.id, stagedPaymentId))
          .for("update")
          .then((r) => r[0]);
        if (!staged) {
          throw new ApproveAbort(404, {
            error: "not_found",
            message: "staged payment not found",
          });
        }
        if (staged.status !== "pending") {
          throw new ApproveAbort(409, {
            error: "not_approvable",
            message:
              "This staged payment is no longer pending. Refresh and try again.",
          });
        }

        const gift = await tx
          .select()
          .from(giftsAndPayments)
          .where(eq(giftsAndPayments.id, giftId))
          .for("update")
          .then((r) => r[0]);
        if (!gift) {
          throw new ApproveAbort(404, {
            error: "not_found",
            message: "gift not found",
          });
        }

        let opp: typeof opportunitiesAndPledges.$inferSelect | null = null;
        if (opportunityId) {
          opp =
            (await tx
              .select()
              .from(opportunitiesAndPledges)
              .where(eq(opportunitiesAndPledges.id, opportunityId))
              .for("update")
              .then((r) => r[0])) ?? null;
          if (!opp) {
            throw new ApproveAbort(404, {
              error: "not_found",
              message: "opportunity not found",
            });
          }
        }

        let charge: typeof stripeStagedCharges.$inferSelect | null = null;
        if (stripeChargeId) {
          charge =
            (await tx
              .select()
              .from(stripeStagedCharges)
              .where(eq(stripeStagedCharges.id, stripeChargeId))
              .for("update")
              .then((r) => r[0])) ?? null;
          if (!charge) {
            throw new ApproveAbort(404, {
              error: "not_found",
              message: "stripe charge not found",
            });
          }
          // The charge must be free to claim: pending, or already reconciled to
          // THIS same gift (idempotent). Anything else (resolved elsewhere) is a
          // conflict — the charge can back only one gift.
          const chargePending = charge.status === "pending";
          const chargeIdempotent =
            charge.status === "reconciled" && charge.matchedGiftId === giftId;
          if (!chargePending && !chargeIdempotent) {
            throw new ApproveAbort(409, {
              error: "stripe_charge_not_available",
              message:
                "The selected Stripe charge has already been resolved. Refresh and try again.",
            });
          }
        }

        // Stripe GROSS wins when a charge is selected; else the QB staged amount.
        const evidenceAmount = charge ? charge.grossAmount : staged.amount;

        // When no charge is chosen, surface whether precise Stripe evidence is
        // being ignored (precedence): count still-unreconciled charges on the
        // tied payouts.
        let stripeChargesAvailable = 0;
        if (!charge && stagedPayoutIds.length > 0) {
          const [{ n } = { n: 0 }] = await tx
            .select({ n: sql<number>`COUNT(*)::int` })
            .from(stripeStagedCharges)
            .where(
              and(
                inArray(stripeStagedCharges.stripePayoutId, stagedPayoutIds),
                ne(stripeStagedCharges.status, "reconciled"),
              ),
            );
          stripeChargesAvailable = n;
        }

        // ── Consistency gate (E6), on the freshly-locked rows ──────────────────
        const issues = runConsistencyGate({
          staged: { id: staged.id, status: staged.status },
          gift: {
            id: gift.id,
            amount: gift.amount,
            archivedAt: gift.archivedAt,
            organizationId: gift.organizationId,
            individualGiverPersonId: gift.individualGiverPersonId,
            householdId: gift.householdId,
            finalAmountSource: gift.finalAmountSource,
            finalAmountStripeChargeId: gift.finalAmountStripeChargeId,
          },
          opportunity: opp
            ? {
                id: opp.id,
                archivedAt: opp.archivedAt,
                organizationId: opp.organizationId,
                individualGiverPersonId: opp.individualGiverPersonId,
                householdId: opp.householdId,
              }
            : null,
          evidenceAmount,
          stripeCharge: charge
            ? { id: charge.id, stripePayoutId: charge.stripePayoutId }
            : null,
          stagedPayoutIds,
          stripeChargesAvailable,
          overrideAmountMismatchReason:
            body.overrideAmountMismatchReason ?? null,
        });
        if (issues.length > 0) {
          throw new ApproveAbort(409, {
            error: "consistency_gate",
            message: "The reconciliation graph isn't consistent.",
            details: { issues },
          });
        }

        // An explicit human Match treats the selected gift as authoritative: the
        // staged evidence ADOPTS the gift's donor (Donor XOR validated by the gate).
        const finalDonor = donorOf(gift);

        // Tie the staged row to the gift. Only succeeds if still pending AND no
        // other staged row / split already claims this gift — the NOT EXISTS
        // guards + the partial-unique index on matched_gift_id backstop a
        // write-skew between the lock and the commit.
        const updated = await tx
          .update(stagedPayments)
          .set({
            ...finalDonor,
            // Permanent EVIDENCE tied to the gift — `reconciled` (not `approved`)
            // marks that terminal tie; never archived, never a second gift.
            status: "reconciled",
            matchedGiftId: giftId,
            createdGiftId: null,
            autoApplied: false,
            matchStatus: "matched",
            matchConfirmedByUserId: user.id,
            matchConfirmedAt: new Date(),
            approvedByUserId: user.id,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(stagedPayments.id, stagedPaymentId),
              eq(stagedPayments.status, "pending"),
              sql`NOT EXISTS (
                SELECT 1 FROM staged_payments sp2
                WHERE (sp2.matched_gift_id = ${giftId}
                       OR sp2.created_gift_id = ${giftId}
                       OR sp2.group_reconciled_gift_id = ${giftId})
                  AND sp2.id <> ${stagedPaymentId}
              )`,
              sql`NOT EXISTS (
                SELECT 1 FROM staged_payment_splits spl
                WHERE spl.gift_id = ${giftId}
              )`,
            ),
          )
          .returning({ id: stagedPayments.id });

        if (updated.length === 0) {
          throw new ApproveAbort(409, {
            error: "link_conflict",
            message:
              "This staged payment is no longer pending, or that gift was just linked to another payment. Refresh and try again.",
          });
        }

        // Stamp the gift's FINAL amount + rebalance its single allocation (or
        // flag a multi-allocation gift whose splits no longer sum).
        const stamp = charge
          ? await stampGiftFinalAmount(tx, giftId, {
              source: "stripe",
              stripeChargeId: charge.id,
              amount: charge.grossAmount,
              processorFee: charge.feeAmount,
            })
          : await stampGiftFinalAmount(tx, giftId, {
              source: "quickbooks",
              qbStagedPaymentId: stagedPaymentId,
              amount: staged.amount,
            });
        if (!stamp.skipped) {
          await adjustSingleAllocationOrFlag(
            tx,
            giftId,
            stamp.oldAmount,
            stamp.newAmount,
            charge ? "stripe" : "quickbooks",
          );
        }

        // Mark the Stripe charge + its payout as permanent reconciled evidence.
        if (charge) {
          // Tie the charge to the gift row-locally (mirrors the Stripe confirm
          // paths): `matchedGiftId` is what the charge list/detail resolves the
          // gift through (COALESCE(matchedGiftId, createdGiftId)) and what the
          // revert flow unwinds. The partial-unique on matched_gift_id also makes
          // a gift claimable by at most ONE charge (23505 → 409 link_conflict).
          await tx
            .update(stripeStagedCharges)
            .set({
              ...finalDonor,
              status: "reconciled",
              matchedGiftId: giftId,
              createdGiftId: null,
              autoApplied: false,
              matchStatus: "matched",
              matchConfirmedByUserId: user.id,
              matchConfirmedAt: new Date(),
              approvedByUserId: user.id,
              approvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(stripeStagedCharges.id, charge.id));
          if (charge.stripePayoutId) {
            await tx
              .update(stripePayouts)
              .set({
                qbReconciliationStatus: "confirmed_reconciled",
                matchedQbStagedPaymentId: stagedPaymentId,
                proposedQbStagedPaymentId: null,
                qbReconciliationConfirmedByUserId: user.id,
                qbReconciliationConfirmedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(stripePayouts.id, charge.stripePayoutId));
          }
        }

        // A changed gift amount shifts the paid total of the pledge it's already
        // on (if any) — re-derive that pledge after commit.
        if (stamp.changed && gift.paymentOnPledgeId) {
          rederivePledgeIds.push(gift.paymentOnPledgeId);
        }
        // Optionally tie the gift to the chosen opportunity (payment-on-pledge),
        // without clobbering an existing link; the newly linked pledge also needs
        // re-derivation (a payment was attached to it).
        if (opp && gift.paymentOnPledgeId == null) {
          await tx
            .update(giftsAndPayments)
            .set({ paymentOnPledgeId: opp.id, updatedAt: new Date() })
            .where(eq(giftsAndPayments.id, giftId));
          rederivePledgeIds.push(opp.id);
        }

        await recordAudit(tx, req, {
          action: "update",
          entityType: "gift",
          entityId: giftId,
          summary: `Reconciled QuickBooks payment to gift (complete match)`,
          metadata: {
            stagedPaymentId,
            stripeChargeId: charge?.id ?? null,
            opportunityId: opp?.id ?? null,
            outcome: "link_existing_gift",
          },
        });
      });
    } catch (e) {
      if (e instanceof ApproveAbort) {
        res.status(e.httpStatus).json(e.payload);
        return;
      }
      if (
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        (e as { code?: string }).code === "23505"
      ) {
        res.status(409).json({
          error: "link_conflict",
          message:
            "That gift was just linked to another payment. Refresh and try again.",
        });
        return;
      }
      throw e;
    }

    // Re-derive affected pledges from the committed gift amounts (mirrors the
    // gift create/PATCH paths; runs outside the tx on its own connection).
    await applyDerivedOppFieldsMany(...rederivePledgeIds);

    res.json({
      ok: true as const,
      outcome: "link_existing_gift" as const,
      stagedPaymentId,
      giftId,
      opportunityId,
      createdGift: false,
      createdPledge: false,
    });
  }),
);

export default router;
