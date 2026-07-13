import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  stagedPayments,
  giftsAndPayments,
  opportunitiesAndPledges,
  stripeStagedCharges,
  stripePayouts,
  settlementLinks,
} from "@workspace/db/schema";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
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
import { applyDerivedOppFieldsMany } from "../../lib/pledgeStage";
import { applyGiftQbTieMany } from "../../lib/giftQbTie";
import { groupMemberIdsFor } from "../../lib/unitGroupMembership";
import {
  runConsistencyGate,
  isStagedApprovable,
} from "../../lib/reconciliationGate";
import {
  ReconcileAbort as ApproveAbort,
  mintGiftInTx,
  linkGiftInTx,
} from "../../lib/reconciliationCommit";
import {
  qbLedgerPaymentIdForGiftExcludingPayment,
  qbLedgerGiftIdForPaymentExcludingGift,
} from "../../lib/paymentApplications";
import {
  chargeStatusIn,
  deriveStripeChargeStatus,
  stagedStatusSql,
} from "../../lib/derivedStatus";

const router: IRouter = Router();

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
  splitGroupIntoAllocations?: boolean | null;
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
 * Context for minting ONE gift from a source GROUP of staged payments (several
 * QuickBooks records that are one physical gift). `representativeId` owns the
 * mint (createdGiftId); every other member ties to it via groupReconciledGiftId;
 * the gift's final amount is `total` (the sum of every member's amount).
 */
type GroupMintContext = {
  representativeId: string;
  memberIds: string[];
  total: string;
  /**
   * Per-member rows (id, amount, attributed entity), used to seed one allocation
   * per subcomponent when the operator opts into `splitGroupIntoAllocations`.
   */
  members: { id: string; amount: string | null; entityId: string | null }[];
};


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
 *     opportunity/pledge — donor DERIVED from the opp; gift.opportunityId set;
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
  group: GroupMintContext | null = null,
): Promise<void> {
  // Opportunity behavior is gated on the OUTCOME (opts.requireOpportunity), never
  // on the mere presence of body.opportunityId: the shared approve body allows
  // opportunityId for every outcome, so a stray/stale id on a plain create_gift
  // must NOT silently lock that opp, hijack the donor away from the validated body
  // donor, attach the payment (opportunityId), or re-derive the opp.
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

  // Fast non-locking guard: every row to be minted must be OPEN (derived
  // pending/match_proposed) with NO existing gift. For a source group this
  // covers ALL members. (Minting is intentionally NOT idempotent — re-approving an
  // already-booked row must not mint a second gift.)
  const preIds = group ? group.memberIds : [stagedPaymentId];
  const preRows = await db
    .select({
      status: stagedStatusSql,
      matchedGiftId: stagedPayments.matchedGiftId,
      createdGiftId: stagedPayments.createdGiftId,
      groupReconciledGiftId: stagedPayments.groupReconciledGiftId,
    })
    .from(stagedPayments)
    .where(inArray(stagedPayments.id, preIds));
  if (preRows.length !== preIds.length) return notFound(res, "staged payment");
  for (const pre of preRows) {
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
  }

  // Payouts tied to this staged row — a selected charge must belong to one, and
  // they're the lock targets that serialize us against stripeConfirm.
  const stagedPayoutRows = await db
    .select({ id: stripePayouts.id })
    .from(settlementLinks)
    .innerJoin(stripePayouts, eq(stripePayouts.id, settlementLinks.payoutId))
    .where(eq(settlementLinks.depositStagedPaymentId, stagedPaymentId));
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

      // Lock every member row (the single-row path locks just one; a source group
      // locks ALL members, ordered by id to avoid deadlocks) and re-check each
      // under the lock. `staged` is the representative — the evidence the gift
      // HEADER is built from.
      const lockIds = group ? group.memberIds : [stagedPaymentId];
      // Full row + the DERIVED status (the EXISTS arms — settlement link,
      // counted ledger row — can't be derived from the row alone, and a
      // split-resolved row carries none of the three gift-link columns).
      const lockedRows = await tx
        .select({ ...getTableColumns(stagedPayments), status: stagedStatusSql })
        .from(stagedPayments)
        .where(inArray(stagedPayments.id, lockIds))
        .orderBy(stagedPayments.id)
        .for("update");
      if (lockedRows.length !== lockIds.length) {
        throw new ApproveAbort(404, {
          error: "not_found",
          message: "staged payment not found",
        });
      }
      for (const row of lockedRows) {
        if (!isStagedApprovable(row.status)) {
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
          row.matchedGiftId != null ||
          row.createdGiftId != null ||
          row.groupReconciledGiftId != null
        ) {
          throw new ApproveAbort(409, {
            error: "gift_already_linked",
            message:
              "This payment already has a gift. Link that existing gift instead of creating a new one.",
          });
        }
      }
      const staged = lockedRows.find((r) => r.id === stagedPaymentId)!;

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
          opp.writtenPledge === true ||
          // Won/closed: redesigned wins land at stage 'complete' / status
          // 'cash_in'; legacy rows may still carry deprecated commitment stages.
          opp.stage === "complete" ||
          opp.status === "cash_in" ||
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
        // A fresh mint can only claim a still-free (derived-pending) charge.
        if (deriveStripeChargeStatus(charge) !== "pending") {
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
      const evidenceAmount = charge
        ? charge.grossAmount
        : group
          ? group.total
          : staged.amount;

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
              // Claimable = still open (an excluded charge is terminal noise
              // and must not block a QB-only mint; a booked charge is taken).
              chargeStatusIn(["pending", "match_proposed"]),
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
        evidenceNetAmount: charge ? charge.netAmount : null,
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

      await mintGiftInTx(tx, {
        newGiftId,
        staged,
        stagedPaymentId,
        donor,
        charge,
        opp,
        opportunityId,
        evidenceAmount,
        paymentIntermediaryId: body.paymentIntermediaryId ?? null,
        convert: opts.convert,
        outcome: opts.outcome,
        group: group
          ? {
              memberIds: group.memberIds,
              members: group.members,
              splitIntoAllocations: body.splitGroupIntoAllocations === true,
            }
          : null,
        userId: user.id,
        auditReq: req,
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
  // The newly minted gift now carries QB linkage — persist its tie status.
  await applyGiftQbTieMany(newGiftId);

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

    // ── Source group: approval acts on the WHOLE group ────────────────────────
    // A staged row stamped with sourceGroupId is one slice of a single physical
    // gift entered as several QuickBooks records. Resolve the whole group as a
    // unit: the create-* outcomes mint ONE gift summing every member; linking an
    // EXISTING gift ties all members at once via the group-reconcile endpoint, so
    // it's rejected here with a redirect (this card endpoint mints only).
    const groupRow = await db
      .select({ id: stagedPayments.id })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, stagedPaymentId))
      .then((r) => r[0]);
    if (!groupRow) return notFound(res, "staged payment");
    // Group membership (and the group expansion below) reads from unit-group
    // membership — the single source, docs/reconciliation-design.md §4.6b — not
    // the legacy `source_group_id` pointer. `groupMemberIdsFor` returns [] for
    // an ungrouped unit and the sorted members (incl. self) for a grouped one,
    // so its first element is the deterministic representative (min id).
    const memberIds = await groupMemberIdsFor(db, stagedPaymentId);
    if (memberIds.length > 0) {
      if (body.outcome === "link_existing_gift") {
        res.status(409).json({
          error: "source_group_use_reconcile",
          message:
            "This payment is part of a group. Link the whole group to an existing gift from its card.",
        });
        return;
      }
      // Build the group context: all members, a deterministic representative
      // (min id) that owns the mint, and the combined total.
      const members = await db
        .select({
          id: stagedPayments.id,
          amount: stagedPayments.amount,
          entityId: stagedPayments.entityId,
        })
        .from(stagedPayments)
        .where(inArray(stagedPayments.id, memberIds));
      const representativeId = memberIds[0];
      const total = members
        .reduce((acc, m) => acc + Number(m.amount ?? 0), 0)
        .toFixed(2);

      // Per-charge Stripe GROSS reconciliation can't be summed across a group yet:
      // reject groups whose members carry a tied Stripe payout, or an explicit
      // charge selection. Ungroup to reconcile those individually.
      const stripeTied = await db
        .select({ id: stripePayouts.id })
        .from(settlementLinks)
        .innerJoin(stripePayouts, eq(stripePayouts.id, settlementLinks.payoutId))
        .where(inArray(settlementLinks.depositStagedPaymentId, memberIds))
        .then((r) => r[0]);
      if (stripeTied || body.stripeChargeId) {
        res.status(409).json({
          error: "source_group_stripe_unsupported",
          message:
            "Stripe-backed payments can't be minted as a group yet. Ungroup them to reconcile individually.",
        });
        return;
      }

      const group: GroupMintContext = {
        representativeId,
        memberIds,
        total,
        members,
      };
      if (body.outcome === "create_gift") {
        await mintGiftFromEvidence(
          req,
          res,
          user,
          representativeId,
          body,
          {
            outcome: "create_gift",
            requireOpportunity: false,
            convert: false,
            createdPledge: false,
          },
          group,
        );
        return;
      }
      if (body.outcome === "create_gift_from_opportunity") {
        await mintGiftFromEvidence(
          req,
          res,
          user,
          representativeId,
          body,
          {
            outcome: "create_gift_from_opportunity",
            requireOpportunity: true,
            convert: false,
            createdPledge: false,
          },
          group,
        );
        return;
      }
      if (body.outcome === "convert_to_pledge_and_first_payment") {
        await mintGiftFromEvidence(
          req,
          res,
          user,
          representativeId,
          body,
          {
            outcome: "convert_to_pledge_and_first_payment",
            requireOpportunity: true,
            convert: true,
            createdPledge: true,
          },
          group,
        );
        return;
      }
    }

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
        status: stagedStatusSql,
        matchedGiftId: stagedPayments.matchedGiftId,
        groupReconciledGiftId: stagedPayments.groupReconciledGiftId,
      })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, stagedPaymentId))
      .then((r) => r[0]);
    if (!pre) return notFound(res, "staged payment");
    if (pre.status === "match_confirmed") {
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
      .from(settlementLinks)
      .innerJoin(stripePayouts, eq(stripePayouts.id, settlementLinks.payoutId))
      .where(eq(settlementLinks.depositStagedPaymentId, stagedPaymentId));
    const stagedPayoutIds = stagedPayoutRows.map((r) => r.id);

    // Pledges whose derived fields must be recomputed AFTER commit (a newly
    // linked payment, or a changed gift amount, shifts a pledge's paid total).
    const rederivePledgeIds: Array<string | null> = [];
    // The gift the anchor payment was moved OFF of (own-application move) — it
    // lost its only QB evidence in the commit, so its tie status needs
    // recomputing alongside the newly linked gift's.
    let movedFromGiftId: string | null = null;

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
          .select({
            ...getTableColumns(stagedPayments),
            status: stagedStatusSql,
          })
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

        // ── Optional QB-link displacement (human-confirmed, Task #550) ─────────
        // Tying THIS payment to a gift already QB-linked to a DIFFERENT staged
        // payment collides with the ledger's one-QB-payment-per-gift guard. Look
        // up the INCUMBENT payment (excluding this anchor) from the cash-
        // application ledger — the SAME predicate the link commit's UPDATE guard
        // uses, so detection and commit can never disagree. Both subquery args
        // are bound params (not columns), so there is no bare-column footgun.
        // When present, hard-block (gate: gift_already_qb_linked) unless the
        // reviewer confirmed the displacement; then load + lock the incumbent so
        // we can (a) surface its details in the 409 the UI describes and (b) hand
        // it to the commit to disconnect back to the pending queue. Locking a
        // second staged row after this anchor carries a rare deadlock risk under
        // concurrent cross-displacement — Postgres aborts one txn (retryable),
        // acceptable for this manual admin action (mirrors #546's charge lock).
        const incumbentPaymentId = await tx
          .execute<{ incumbent_id: string | null }>(
            sql`SELECT ${qbLedgerPaymentIdForGiftExcludingPayment(
              sql`${giftId}`,
              sql`${stagedPaymentId}`,
            )} AS incumbent_id`,
          )
          .then((r) => r.rows[0]?.incumbent_id ?? null);
        const displaceLinkedPayment = body.displaceLinkedPayment === true;
        let incumbentStagedPayment:
          | typeof stagedPayments.$inferSelect
          | null = null;
        if (incumbentPaymentId) {
          incumbentStagedPayment =
            (await tx
              .select()
              .from(stagedPayments)
              .where(eq(stagedPayments.id, incumbentPaymentId))
              .for("update")
              .then((r) => r[0])) ?? null;
        }

        // ── Optional own-application move (human-confirmed) ────────────────────
        // The inverse dead-end of the incumbent displacement above: the ANCHOR
        // payment itself is already applied to a DIFFERENT gift (the sync worker
        // auto-matched it to the wrong one of two identical donations). Left
        // alone, the commit's book-once guard hard-409s (payment_already_applied)
        // with no UI recovery. Detect it from the cash-application ledger
        // (excluding the TARGET gift, so re-approving the same link stays
        // idempotent). The move is offered ONLY for a plain worker auto-match:
        // the ledger gift must AGREE with the row's own matchedGiftId, and the
        // row must not have minted a gift (createdGiftId — guarded above), be
        // group-reconciled, or be applied to several gifts (split). Any of those
        // fall through with ownAppliedGiftId unset → the commit's hard 409 stands
        // (revert the group/split first). When movable, load + lock the old gift
        // so the commit can unwind its stamp under the same locks. Locking a
        // SECOND gift after the target gift carries a rare deadlock risk under
        // concurrent cross-moves — Postgres aborts one txn (retryable),
        // acceptable for this manual admin action (mirrors the incumbent lock).
        const ownAppliedGiftId = await tx
          .execute<{ applied_gift_id: string | null }>(
            sql`SELECT ${qbLedgerGiftIdForPaymentExcludingGift(
              sql`${stagedPaymentId}`,
              sql`${giftId}`,
            )} AS applied_gift_id`,
          )
          .then((r) => r.rows[0]?.applied_gift_id ?? null);
        const moveOwnApplication = body.moveOwnApplication === true;
        let oldAppliedGift: typeof giftsAndPayments.$inferSelect | null = null;
        let movableOwnApplication: string | null = null;
        if (
          ownAppliedGiftId &&
          staged.matchedGiftId === ownAppliedGiftId &&
          staged.createdGiftId == null &&
          staged.groupReconciledGiftId == null
        ) {
          movableOwnApplication = ownAppliedGiftId;
          oldAppliedGift =
            (await tx
              .select()
              .from(giftsAndPayments)
              .where(eq(giftsAndPayments.id, ownAppliedGiftId))
              .for("update")
              .then((r) => r[0])) ?? null;
          if (!oldAppliedGift) {
            // Ledger says applied, gift row is gone — genuine drift; let the
            // commit's hard 409 surface it rather than half-unwinding.
            movableOwnApplication = null;
          }
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
        if (donorSwitching && gift.opportunityId) {
          const tiedPledge =
            opp && opp.id === gift.opportunityId
              ? opp
              : ((await tx
                  .select()
                  .from(opportunitiesAndPledges)
                  .where(eq(opportunitiesAndPledges.id, gift.opportunityId))
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
          // The charge must be free to claim: pending, or already confirmed to
          // THIS same gift (idempotent). Anything else (resolved elsewhere) is a
          // conflict — the charge can back only one gift.
          const chargeDerived = deriveStripeChargeStatus(charge);
          const chargePending = chargeDerived === "pending";
          const chargeIdempotent =
            chargeDerived === "match_confirmed" &&
            charge.matchedGiftId === giftId;
          if (!chargePending && !chargeIdempotent) {
            throw new ApproveAbort(409, {
              error: "stripe_charge_not_available",
              message:
                "The selected Stripe charge has already been resolved. Refresh and try again.",
            });
          }
        }

        // ── Optional Stripe-source switch (human-confirmed) ────────────────────
        // Re-targeting to a gift already sourced from a DIFFERENT Stripe charge
        // hard-blocks (gate: gift_already_stripe_sourced) unless the reviewer
        // confirmed the switch. When a switch is in play, load + lock the charge
        // that currently backs the gift so we can (a) surface its details in the
        // 409 the UI describes and (b) hand it to the commit to orphan back to the
        // queue. Only meaningful when a new charge is selected and it differs.
        let oldStripeCharge: typeof stripeStagedCharges.$inferSelect | null = null;
        const switchingStripeSource =
          !!charge &&
          gift.finalAmountSource === "stripe" &&
          !!gift.finalAmountStripeChargeId &&
          gift.finalAmountStripeChargeId !== charge.id;
        if (switchingStripeSource && gift.finalAmountStripeChargeId) {
          oldStripeCharge =
            (await tx
              .select()
              .from(stripeStagedCharges)
              .where(eq(stripeStagedCharges.id, gift.finalAmountStripeChargeId))
              .for("update")
              .then((r) => r[0])) ?? null;
        }
        const switchStripeSource = body.switchStripeSource === true;

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
                // Claimable = still open (excluded charges are terminal noise,
                // booked charges are taken).
                chargeStatusIn(["pending", "match_proposed"]),
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
          evidenceNetAmount: charge ? charge.netAmount : null,
          stripeCharge: charge
            ? { id: charge.id, stripePayoutId: charge.stripePayoutId }
            : null,
          stagedPayoutIds,
          stripeChargesAvailable,
          overrideAmountMismatchReason:
            body.overrideAmountMismatchReason ?? null,
          switchStripeSource,
          currentStripeChargeDetails: oldStripeCharge
            ? {
                id: oldStripeCharge.id,
                amount: oldStripeCharge.grossAmount,
                payerName: oldStripeCharge.payerName,
                date: oldStripeCharge.dateReceived,
              }
            : null,
          qbLinkedPaymentId: incumbentPaymentId,
          displaceLinkedPayment,
          currentQbPaymentDetails: incumbentStagedPayment
            ? {
                id: incumbentStagedPayment.id,
                amount: incumbentStagedPayment.amount,
                payerName: incumbentStagedPayment.payerName,
                date: incumbentStagedPayment.dateReceived,
              }
            : null,
          ownAppliedGiftId: movableOwnApplication,
          moveOwnApplication,
          currentAppliedGiftDetails: oldAppliedGift
            ? {
                id: oldAppliedGift.id,
                name: oldAppliedGift.name,
                amount: oldAppliedGift.amount,
                date: oldAppliedGift.dateReceived,
              }
            : null,
        });
        if (issues.length > 0) {
          throw new ApproveAbort(409, {
            error: "consistency_gate",
            message: "The reconciliation graph isn't consistent.",
            details: { issues },
          });
        }

        const linkResult = await linkGiftInTx(tx, {
          staged,
          stagedPaymentId,
          gift,
          giftId,
          opp,
          charge,
          evidenceAmount,
          effectiveGiftDonor,
          donorSwitching,
          switchStripeSource,
          oldStripeCharge,
          displaceLinkedPayment,
          incumbentStagedPayment,
          moveOwnApplication,
          oldAppliedGift,
          userId: user.id,
          auditReq: req,
        });
        rederivePledgeIds.push(...linkResult.rederivePledgeIds);
        movedFromGiftId = linkResult.movedFromGiftId;
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
    // The linked gift now carries QB linkage — persist its tie status. When the
    // payment was moved off another gift, that gift just LOST its QB evidence
    // (likely → missing) — recompute it too.
    await applyGiftQbTieMany(giftId, movedFromGiftId);

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
