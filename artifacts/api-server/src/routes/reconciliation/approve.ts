import { Router, type IRouter, type Request, type Response } from "express";
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
import {
  donorOf,
  donorsMatch,
  hasExactlyOneDonor,
  type LinkDonor,
} from "../../lib/quickbooksLink";
import {
  stampGiftFinalAmount,
  adjustSingleAllocationOrFlag,
} from "../../lib/giftFinalAmount";
import { buildGiftValuesFromStaged } from "../../lib/quickbooksGift";
import { applyDerivedOppFieldsMany } from "../../lib/pledgeStage";
import { recordAudit } from "../../lib/audit";
import {
  runConsistencyGate,
  isStagedApprovable,
  APPROVABLE_STAGED_STATUSES,
} from "../../lib/reconciliationGate";

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

type DonorXor = {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
};

/** Fields the mint helper reads off the (already-validated) approve body. */
type MintBody = Partial<DonorXor> & {
  opportunityId?: string | null;
  stripeChargeId?: string | null;
  paymentIntermediaryId?: string | null;
  overrideAmountMismatchReason?: string | null;
};

interface MintOpts {
  /** The create-* outcome being applied; echoed back in the response + audit. */
  outcome:
    | "create_gift"
    | "create_gift_from_opportunity"
    | "convert_to_pledge_and_first_payment";
  /** Require + lock an opportunity, and DERIVE the gift donor from it. */
  requireOpportunity: boolean;
  /** Latch the opportunity into a pledge (open-only → commitment stage). */
  convert: boolean;
  /** Value of the response `createdPledge` flag. */
  createdPledge: boolean;
}

/**
 * Shared in-tx mint path for the three create-* approve outcomes (create_gift,
 * create_gift_from_opportunity, convert_to_pledge_and_first_payment). Minting is
 * HUMAN-ONLY; the QB staged row OWNS the mint (createdGiftId, not auto-applied →
 * protected from casual revert, exactly like the manual create-gift route). A
 * selected Stripe charge supplies the precise GROSS and stays matchedGiftId-linked
 * (revert un-sources the amount, never deletes the human mint). The gift is the
 * single source of truth; its FINAL amount is the Stripe GROSS when a charge is
 * selected, else the QB staged amount. HEADER-only (no allocations; a fundraiser
 * apportions afterward). Not idempotent — re-approving a reconciled row is a 409.
 *
 *   - create_gift: donor is the human-chosen BODY donor; no opportunity.
 *   - create_gift_from_opportunity: a one-time PAYMENT against an existing
 *     opportunity/pledge — donor DERIVED from the opp; gift.paymentOnPledgeId set;
 *     the opp derives to cash_in when fully paid. Stage is left untouched.
 *   - convert_to_pledge_and_first_payment: latch an OPEN opportunity into a pledge
 *     (stage → written_commitment; was_pledge + status DERIVED post-commit) AND
 *     book the first payment. Rejected when the opp is archived or already a
 *     pledge/closed (use create_gift_from_opportunity for those).
 */
async function mintGiftFromEvidence(
  req: Request,
  res: Response,
  user: { id: string },
  stagedPaymentId: string,
  body: MintBody,
  opts: MintOpts,
): Promise<void> {
  // Opportunity behavior is gated on the OUTCOME (opts.requireOpportunity), never
  // on the mere presence of body.opportunityId: the shared approve body allows
  // opportunityId for every outcome, so a stray/stale id on a plain create_gift
  // must NOT silently lock that opp, hijack the donor away from the validated body
  // donor, attach the payment (paymentOnPledgeId), or re-derive the opp.
  const opportunityId = opts.requireOpportunity ? (body.opportunityId ?? null) : null;
  if (opts.requireOpportunity && !opportunityId) {
    res.status(400).json({
      error: "validation_error",
      message: `${opts.outcome} requires an opportunityId.`,
    });
    return;
  }

  // Donor source: create_gift uses the human-CHOSEN body donor (validate Donor
  // XOR up front for a clean 400 before any locking). The opportunity outcomes
  // DERIVE the donor from the chosen opportunity inside the tx (authoritative —
  // the human picked the opp, which already enforces Donor XOR), so the body
  // donor fields are ignored on those paths.
  let bodyDonor: DonorXor | null = null;
  if (!opts.requireOpportunity) {
    bodyDonor = {
      organizationId: body.organizationId ?? null,
      individualGiverPersonId: body.individualGiverPersonId ?? null,
      householdId: body.householdId ?? null,
    };
    const donorIssues = validateGiftInvariants(bodyDonor);
    if (donorIssues.length) {
      res.status(400).json({
        error: "validation_error",
        message: "A new gift needs exactly one donor (Donor XOR).",
        details: { issues: donorIssues },
      });
      return;
    }
  }

  const stripeChargeId = body.stripeChargeId ?? null;

  // Fast non-locking guard: only an OPEN (pending, or a legacy approved) staged
  // row with NO existing gift can mint. (Minting is intentionally NOT idempotent
  // — re-approving an already-reconciled row must not mint a second gift.)
  const pre = await db
    .select({
      status: stagedPayments.status,
      matchedGiftId: stagedPayments.matchedGiftId,
      createdGiftId: stagedPayments.createdGiftId,
      groupReconciledGiftId: stagedPayments.groupReconciledGiftId,
    })
    .from(stagedPayments)
    .where(eq(stagedPayments.id, stagedPaymentId))
    .then((r) => r[0]);
  if (!pre) return notFound(res, "staged payment");
  if (!isStagedApprovable(pre.status)) {
    res.status(409).json({
      error: "not_approvable",
      message:
        "This staged payment is no longer open for reconciliation. Refresh and try again.",
    });
    return;
  }
  // A row that already has a gift (matched, minted, OR grouped) must NOT mint a
  // second one — that would double-count the money. Legacy `approved` rows
  // carrying any gift link belong on the link path (tie evidence to the existing
  // gift), never here.
  if (
    pre.matchedGiftId != null ||
    pre.createdGiftId != null ||
    pre.groupReconciledGiftId != null
  ) {
    res.status(409).json({
      error: "gift_already_linked",
      message:
        "This payment already has a gift. Link that existing gift instead of creating a new one.",
    });
    return;
  }

  // Payouts tied to this staged row — a selected charge must belong to one, and
  // they're the lock targets that serialize us against stripeConfirm.
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
      // Lock order (mirrors the link path + stripeConfirm): payouts → staged →
      // opportunity → charge. No existing gift to lock — we mint a fresh row.
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
      if (!isStagedApprovable(staged.status)) {
        throw new ApproveAbort(409, {
          error: "not_approvable",
          message:
            "This staged payment is no longer open for reconciliation. Refresh and try again.",
        });
      }
      // Re-check under the row lock: never mint a second gift for a row that
      // already has one (matched, minted, OR grouped) — it belongs on the link
      // path.
      if (
        staged.matchedGiftId != null ||
        staged.createdGiftId != null ||
        staged.groupReconciledGiftId != null
      ) {
        throw new ApproveAbort(409, {
          error: "gift_already_linked",
          message:
            "This payment already has a gift. Link that existing gift instead of creating a new one.",
        });
      }

      // Lock the chosen opportunity (opp outcomes). The donor is derived from it.
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

      // convert_to_pledge_and_first_payment is an OPEN→pledge transition: refuse
      // archived opps and opps already latched into a pledge / closed (use
      // create_gift_from_opportunity to book a payment against an existing pledge).
      if (opts.convert && opp) {
        if (opp.archivedAt != null) {
          throw new ApproveAbort(409, {
            error: "opportunity_archived",
            message: "Restore this opportunity before converting it to a pledge.",
          });
        }
        const alreadyPledgeLike =
          opp.wasPledge === true ||
          opp.stage === "conditional_commitment" ||
          opp.stage === "written_commitment" ||
          opp.stage === "cash_in" ||
          opp.lossType != null;
        if (alreadyPledgeLike) {
          throw new ApproveAbort(409, {
            error: "already_pledge",
            message:
              "This opportunity is already a pledge or closed. Use create_gift_from_opportunity to book a payment against it.",
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
        // A fresh mint can only claim a still-free (pending) charge.
        if (charge.status !== "pending") {
          throw new ApproveAbort(409, {
            error: "stripe_charge_not_available",
            message:
              "The selected Stripe charge has already been resolved. Refresh and try again.",
          });
        }
      }

      // Stripe GROSS is the precise amount when a charge is selected; else the QB
      // staged amount. This IS the minted gift's amount (no prior human figure),
      // so the gate's amount-band check is trivially satisfied.
      const evidenceAmount = charge ? charge.grossAmount : staged.amount;

      // Donor: derived from the locked opportunity for the opp outcomes; else the
      // validated body donor (create_gift; bodyDonor is set on that branch).
      const donor: DonorXor = opp ? donorOf(opp) : bodyDonor!;

      // When no charge is selected but the tied payouts still carry unreconciled
      // charges, Stripe precedence demands one be chosen up front (a QB-only mint
      // could never adopt its charge later on this path).
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

      // Consistency gate over the SYNTHETIC new gift (Donor XOR, gift donor ==
      // opp donor — trivially met here since the donor is derived from the opp —,
      // Stripe precedence + linkage, the QB anchor; amount band trivially met).
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
        overrideAmountMismatchReason: body.overrideAmountMismatchReason ?? null,
      });
      if (issues.length > 0) {
        throw new ApproveAbort(409, {
          error: "consistency_gate",
          message: "The reconciliation graph isn't consistent.",
          details: { issues },
        });
      }

      // convert: latch the opportunity into a pledge by setting a commitment
      // stage (the user-driven lifecycle input). was_pledge + status are DERIVED
      // post-commit by applyDerivedOppFields — never written by hand (invariant
      // #3). Preserve a real (positive) awarded amount; only when it's missing
      // fall back to the evidence amount so a single-payment commitment derives to
      // cash_in instead of staying $0.
      if (opts.convert && opp) {
        const existingAwarded = Number(opp.awardedAmount ?? 0);
        const evNum = Number(evidenceAmount ?? 0);
        const awardedAmount =
          !(existingAwarded > 0) && Number.isFinite(evNum) && evNum > 0
            ? evidenceAmount
            : opp.awardedAmount;
        await tx
          .update(opportunitiesAndPledges)
          .set({
            stage: "written_commitment",
            awardedAmount,
            updatedAt: new Date(),
          })
          .where(eq(opportunitiesAndPledges.id, opp.id));
      }

      // Mint the gift HEADER. The amount is the FINAL amount, stamped at insert
      // from the chosen evidence (single XOR pointer); no prior human figure
      // exists, so original_human_crm_amount stays null. The opp outcomes tie the
      // gift to the opportunity via paymentOnPledgeId so the pledge derives
      // cash_in when fully paid.
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
              body.paymentIntermediaryId ?? staged.matchedPaymentIntermediaryId,
          },
          user.id,
        ),
        amount: evidenceAmount,
        ...(opportunityId ? { paymentOnPledgeId: opportunityId } : {}),
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

      // The QB anchor OWNS the mint (createdGiftId, not auto-applied → protected
      // from casual revert). Adopt the chosen donor onto the evidence row. Guarded
      // on still-pending to catch a concurrent resolve.
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
            inArray(stagedPayments.status, [...APPROVABLE_STAGED_STATUSES]),
          ),
        )
        .returning({ id: stagedPayments.id });
      if (updated.length === 0) {
        throw new ApproveAbort(409, {
          error: "not_approvable",
          message:
            "This staged payment is no longer open for reconciliation. Refresh and try again.",
        });
      }

      // A selected Stripe charge is the precise GROSS source: tie it to the gift
      // via matchedGiftId (mirrors the link path + the Stripe confirm paths) so it
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
          opportunityId: opp?.id ?? null,
          outcome: opts.outcome,
        },
      });
    });
  } catch (e) {
    if (e instanceof ApproveAbort) {
      res.status(e.httpStatus).json(e.payload);
      return;
    }
    // Unique violation: a Stripe charge just got claimed by another gift, or the
    // gift's stripe-charge pointer collided. Surface as a conflict.
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

  // Re-derive the opportunity from the committed gift amounts (the new payment, or
  // the latched pledge, shifts its derived status/paid totals + latches
  // was_pledge). Runs outside the tx on its own connection.
  if (opportunityId) {
    await applyDerivedOppFieldsMany(opportunityId);
  }

  res.status(201).json({
    ok: true as const,
    outcome: opts.outcome,
    stagedPaymentId,
    giftId: newGiftId,
    opportunityId: opportunityId ?? null,
    createdGift: true,
    createdPledge: opts.createdPledge,
  });
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

    // The three create-* outcomes all MINT a new gift from the QB evidence
    // (human-only); they share one in-tx helper. link_existing_gift falls through
    // to the linker below. create_gift uses the human-chosen body donor; the two
    // opportunity outcomes derive the donor from the chosen opp.
    if (body.outcome === "create_gift") {
      await mintGiftFromEvidence(req, res, user, stagedPaymentId, body, {
        outcome: "create_gift",
        requireOpportunity: false,
        convert: false,
        createdPledge: false,
      });
      return;
    }
    if (body.outcome === "create_gift_from_opportunity") {
      await mintGiftFromEvidence(req, res, user, stagedPaymentId, body, {
        outcome: "create_gift_from_opportunity",
        requireOpportunity: true,
        convert: false,
        createdPledge: false,
      });
      return;
    }
    if (body.outcome === "convert_to_pledge_and_first_payment") {
      await mintGiftFromEvidence(req, res, user, stagedPaymentId, body, {
        outcome: "convert_to_pledge_and_first_payment",
        requireOpportunity: true,
        convert: true,
        createdPledge: true,
      });
      return;
    }

    // ── link_existing_gift (E3): tie evidence to an EXISTING gift ─────────────
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
        if (!isStagedApprovable(staged.status)) {
          throw new ApproveAbort(409, {
            error: "not_approvable",
            message:
              "This staged payment is no longer open for reconciliation. Refresh and try again.",
          });
        }
        // A row that OWNS a minted gift (createdGiftId) must not be re-pointed to
        // some other gift here — that would demote its provenance and orphan the
        // mint. No such row reaches the work queue today (minting sets the row
        // `reconciled`); this is a forward guard against future approved+created rows.
        if (staged.createdGiftId != null) {
          throw new ApproveAbort(409, {
            error: "gift_already_linked",
            message:
              "This payment already owns a created gift. Revert that gift before linking it elsewhere.",
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

        // ── Optional gift-donor switch (human-confirmed) ───────────────────────
        // Normally an explicit Match ADOPTS the gift's existing donor. When the
        // reviewer instead picks a DIFFERENT donor and the client sends
        // `switchGiftDonor`, re-point the gift's donor to the supplied one — but
        // only after re-validating Donor XOR here, and only when the gift is not a
        // payment on a pledge/opportunity owned by another donor (that must be
        // fixed on the pledge first). Never trust the UI's notion of a switch.
        const bodyDonor: LinkDonor = {
          organizationId: body.organizationId ?? null,
          individualGiverPersonId: body.individualGiverPersonId ?? null,
          householdId: body.householdId ?? null,
        };
        let donorSwitching = false;
        if (body.switchGiftDonor === true) {
          if (!hasExactlyOneDonor(bodyDonor)) {
            throw new ApproveAbort(400, {
              error: "validation_error",
              message:
                "Switching a gift's donor requires exactly one donor (Donor XOR).",
            });
          }
          donorSwitching = !donorsMatch(donorOf(gift), bodyDonor);
        }
        // Block the switch when this gift is a payment on a pledge/opportunity
        // owned by a different donor — re-pointing the payment alone would split
        // the money off its commitment. Reuse the already-locked `opp` when it IS
        // that pledge; otherwise lock the tied pledge too.
        if (donorSwitching && gift.paymentOnPledgeId) {
          const tiedPledge =
            opp && opp.id === gift.paymentOnPledgeId
              ? opp
              : ((await tx
                  .select()
                  .from(opportunitiesAndPledges)
                  .where(eq(opportunitiesAndPledges.id, gift.paymentOnPledgeId))
                  .for("update")
                  .then((r) => r[0])) ?? null);
          if (tiedPledge && !donorsMatch(donorOf(tiedPledge), bodyDonor)) {
            throw new ApproveAbort(409, {
              error: "gift_pledge_donor_conflict",
              message:
                "This gift is a payment on a pledge owned by a different donor. Switch the pledge's donor first, then re-point the gift.",
            });
          }
        }
        const effectiveGiftDonor: LinkDonor = donorSwitching
          ? bodyDonor
          : donorOf(gift);

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
            organizationId: effectiveGiftDonor.organizationId,
            individualGiverPersonId: effectiveGiftDonor.individualGiverPersonId,
            householdId: effectiveGiftDonor.householdId,
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
        // staged evidence ADOPTS the gift's (possibly just-switched) donor — the
        // gate validated Donor XOR on `effectiveGiftDonor` above.
        const finalDonor = effectiveGiftDonor;

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
              inArray(stagedPayments.status, [...APPROVABLE_STAGED_STATUSES]),
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
              "This staged payment is no longer open for reconciliation, or that gift was just linked to another payment. Refresh and try again.",
          });
        }

        // Re-point the gift's donor when the reviewer confirmed a switch (the
        // pledge-conflict + Donor XOR checks above already cleared it).
        if (donorSwitching) {
          await tx
            .update(giftsAndPayments)
            .set({
              organizationId: effectiveGiftDonor.organizationId,
              individualGiverPersonId:
                effectiveGiftDonor.individualGiverPersonId,
              householdId: effectiveGiftDonor.householdId,
              updatedAt: new Date(),
            })
            .where(eq(giftsAndPayments.id, giftId));
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
          summary: donorSwitching
            ? `Reconciled QuickBooks payment to gift and switched its donor (complete match)`
            : `Reconciled QuickBooks payment to gift (complete match)`,
          metadata: {
            stagedPaymentId,
            stripeChargeId: charge?.id ?? null,
            opportunityId: opp?.id ?? null,
            outcome: "link_existing_gift",
            ...(donorSwitching
              ? {
                  switchedGiftDonor: true,
                  fromDonor: donorOf(gift),
                  toDonor: effectiveGiftDonor,
                }
              : {}),
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
