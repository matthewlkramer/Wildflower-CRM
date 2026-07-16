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
import {
  groupMemberIdsFor,
  isQbGroupMemberSql,
} from "../../lib/unitGroupMembership";
import {
  runConsistencyGate,
  isStagedApprovable,
} from "../../lib/reconciliationGate";
import {
  ReconcileAbort as ApproveAbort,
  mintGiftInTx,
  linkGiftInTx,
} from "../../lib/reconciliationCommit";
import { createGiftFromChargeInTx } from "../../lib/reconciliationBundleCommit";
import {
  qbLedgerPaymentIdForGiftExcludingPayment,
  qbLedgerGiftIdForPaymentExcludingGift,
  qbLedgerExistsForPayment,
  qbLedgerSoleGiftIdForPayment,
  qbLedgerMintedGiftIdForPayment,
  chargeCountedLedgerRow,
  giftCountedStripeChargeId,
} from "../../lib/paymentApplications";
import {
  chargeStatusIn,
  deriveStripeChargeStatus,
  stagedConfirmedSettlementLinkExists,
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
      // Wrapped one sql-layer deep ON PURPOSE: a Column interpolated directly
      // into a top-level select field renders UNQUALIFIED, so the correlated
      // EXISTS would bind "id" to the INNER table and always be wrong.
      confirmedSettlementLink: sql<boolean>`(${stagedConfirmedSettlementLinkExists})`,
      // Ledger-derived link state (the legacy staged gift-link columns are
      // @deprecated and no longer written).
      hasLedgerLink: qbLedgerExistsForPayment(),
    })
    .from(stagedPayments)
    .where(inArray(stagedPayments.id, preIds));
  if (preRows.length !== preIds.length) return notFound(res, "staged payment");
  // Charge-anchored escape hatch: a settlement-only confirmed deposit (Stripe
  // settlement confirmed, NO gift link at all) is closed for QB-lump minting,
  // but when the caller selected a SPECIFIC pending charge of that settlement
  // (e.g. "record on a pledge" from a per-charge card of a multi-charge payout),
  // the remaining money is booked charge-anchored — the charge OWNS the mint,
  // the QB lump stays untouched. Single-row only; groups keep the hard 409.
  let chargeAnchoredIntent = false;
  for (const pre of preRows) {
    if (!isStagedApprovable(pre.status)) {
      // "Settlement-only" means the confirmed evidence is a CONFIRMED
      // settlement link and nothing else. A split-resolved row (counted
      // payment_applications rows, no gift-link columns) also derives
      // match_confirmed with NULL links, but its money is ALREADY booked —
      // opening the hatch there would double-count it.
      const settlementOnlyConfirmed =
        pre.status === "match_confirmed" &&
        pre.confirmedSettlementLink === true &&
        pre.hasLedgerLink === false;
      if (settlementOnlyConfirmed && stripeChargeId && !group) {
        chargeAnchoredIntent = true;
        continue;
      }
      // No charge selected (or a group): the dead-end guidance stands — book
      // the remaining money from the per-charge Stripe card instead.
      res.status(409).json({
        error: "not_approvable",
        message: settlementOnlyConfirmed
          ? "This deposit's Stripe settlement is already confirmed. Book the remaining money from its Stripe charge card (link or create the gift there)."
          : "This staged payment is no longer open for reconciliation. Refresh and try again.",
      });
      return;
    }
    // A row that already has a gift (matched, minted, OR grouped — i.e. any
    // counted QB ledger application) must NOT mint a second one — that would
    // double-count the money. Legacy `approved` rows carrying any gift link
    // belong on the link path (tie evidence to the existing gift), never here.
    if (pre.hasLedgerLink) {
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
    .select({ id: stripePayouts.id, lifecycle: settlementLinks.lifecycle })
    .from(settlementLinks)
    .innerJoin(stripePayouts, eq(stripePayouts.id, settlementLinks.payoutId))
    .where(eq(settlementLinks.depositStagedPaymentId, stagedPaymentId));
  // ALL tied payouts (any lifecycle) drive the normal path — locks, the
  // unreconciled-charge gate, and Stripe stamping all consider proposed links.
  const stagedPayoutIds = stagedPayoutRows.map((r) => r.id);
  // Only CONFIRMED settlements anchor the charge-side escape hatch — a
  // merely-proposed link's payout must not pass the wrong-payout guard.
  const confirmedPayoutIds = stagedPayoutRows
    .filter((r) => r.lifecycle === "confirmed")
    .map((r) => r.id);

  const newGiftId = newId();
  const supersedeGiftIds: string[] = [];
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
        .select({
          ...getTableColumns(stagedPayments),
          status: stagedStatusSql,
          // Wrapped one sql-layer deep (see the pre-check select): unwrapped,
          // the correlated EXISTS renders unqualified and binds to the inner
          // table's columns.
          confirmedSettlementLink: sql<boolean>`(${stagedConfirmedSettlementLinkExists})`,
          // Ledger-derived link state (the legacy staged gift-link columns are
          // @deprecated and no longer written).
          hasLedgerLink: qbLedgerExistsForPayment(),
        })
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
      // Confirmed under the lock (the pre-check ran unlocked): the anchor is
      // STILL settlement-only confirmed, so the mint must be charge-anchored.
      // If a concurrent revert re-opened the row, fall through to the normal
      // QB-anchored path instead.
      let chargeAnchored = false;
      for (const row of lockedRows) {
        if (!isStagedApprovable(row.status)) {
          // Same "settlement-only" definition as the pre-check: a CONFIRMED
          // settlement link with NO counted ledger rows (a split-resolved row
          // is already booked — never charge-anchor over it).
          const settlementOnlyConfirmed =
            row.status === "match_confirmed" &&
            row.confirmedSettlementLink === true &&
            row.hasLedgerLink === false;
          if (
            chargeAnchoredIntent &&
            !group &&
            row.id === stagedPaymentId &&
            settlementOnlyConfirmed
          ) {
            chargeAnchored = true;
            continue;
          }
          throw new ApproveAbort(409, {
            error: "not_approvable",
            message:
              "This staged payment is no longer open for reconciliation. Refresh and try again.",
          });
        }
        // Re-check under the row lock: never mint a second gift for a row that
        // already has one (matched, minted, OR grouped — any counted ledger
        // row) — it belongs on the link path.
        if (row.hasLedgerLink) {
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
        // Gift-link fact = the counted ledger row (pointer columns retired).
        if (
          deriveStripeChargeStatus({
            ...charge,
            hasCountedApplication:
              (await chargeCountedLedgerRow(tx, charge.id)) != null,
          }) !== "pending"
        ) {
          throw new ApproveAbort(409, {
            error: "stripe_charge_not_available",
            message:
              "The selected Stripe charge has already been resolved. Refresh and try again.",
          });
        }
      }

      // ── Charge-anchored mint (settlement-only confirmed deposit) ──────────
      // The deposit's Stripe settlement is already confirmed with NO gift — the
      // QB lump is closed for minting. Book the selected pending charge's money
      // directly: the CHARGE owns the mint (createdGiftId; the same primitive
      // the settlement-bundle confirm uses) and the staged row stays untouched.
      // The QB-anchor consistency gate doesn't apply here — the charge-side
      // guards (derived-pending re-check above, the qb_conflict settlement-link
      // guard inside the primitive, Donor XOR) are the operative ones, exactly
      // as on the standalone per-charge create-gift route.
      if (chargeAnchored) {
        if (!charge) {
          // Unreachable — chargeAnchoredIntent requires a stripeChargeId and a
          // missing charge already 404'd above — kept as a safety net.
          throw new ApproveAbort(409, {
            error: "stripe_charge_required",
            message:
              "This deposit's Stripe settlement is already confirmed. Select the Stripe charge to book.",
          });
        }
        // The charge must belong to a payout whose settlement with THIS
        // deposit is CONFIRMED; an unrelated (or merely-proposed) charge is
        // booked from its own card, not through here.
        if (
          !charge.stripePayoutId ||
          !confirmedPayoutIds.includes(charge.stripePayoutId)
        ) {
          throw new ApproveAbort(409, {
            error: "stripe_charge_wrong_payout",
            message:
              "The selected Stripe charge is not part of this deposit's confirmed settlement. Book it from its own card.",
          });
        }
        // The skipped QB-anchor gate normally rejects archived opportunities —
        // enforce that directly here.
        if (opp && opp.archivedAt != null) {
          throw new ApproveAbort(409, {
            error: "opportunity_archived",
            message:
              "Restore this opportunity before recording a payment against it.",
          });
        }
        // convert: latch the OPEN opportunity into a pledge exactly like the
        // QB-anchored mint (writtenPledge is the user-driven lifecycle input;
        // was_pledge/status/stage→complete DERIVE post-commit — invariant #3).
        // Preserve a real (positive) awarded amount; only when missing fall
        // back to the charge GROSS so a single-payment commitment derives to
        // cash_in instead of staying $0.
        if (opts.convert && opp) {
          const existingAwarded = Number(opp.awardedAmount ?? 0);
          const evNum = Number(charge.grossAmount ?? 0);
          const awardedAmount =
            !(existingAwarded > 0) && Number.isFinite(evNum) && evNum > 0
              ? charge.grossAmount
              : opp.awardedAmount;
          await tx
            .update(opportunitiesAndPledges)
            .set({ writtenPledge: true, awardedAmount, updatedAt: new Date() })
            .where(eq(opportunitiesAndPledges.id, opp.id));
        }
        await createGiftFromChargeInTx(tx, {
          newGiftId,
          charge,
          donor: opp ? donorOf(opp) : bodyDonor!,
          paymentIntermediaryId: body.paymentIntermediaryId ?? null,
          opportunityId,
          audit: {
            summary:
              "Minted gift from Stripe charge (deposit settlement already confirmed)",
            metadata: {
              stagedPaymentId,
              stripeChargeId: charge.id,
              opportunityId: opportunityId ?? null,
              outcome: opts.outcome,
            },
          },
          userId: user.id,
          auditReq: req,
        });
        return;
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
          // New gift has no existing Stripe ledger row yet — no current charge.
          currentStripeChargeId: null,
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

      const mintResult = await mintGiftInTx(tx, {
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
      supersedeGiftIds.push(...mintResult.rederiveGiftIds);
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
  // Supersede-affected gifts (coarse QB rows demoted/promoted) re-derive too.
  await applyGiftQbTieMany(newGiftId, ...supersedeGiftIds);

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
        // Ledger-derived link state (the legacy staged gift-link columns are
        // @deprecated and no longer written). `linkedGiftId` is the sole
        // resolved gift (NULL for a split); `mintedGiftId` marks a row that
        // OWNS a created gift; group membership comes from unit_group_members.
        linkedGiftId: qbLedgerSoleGiftIdForPayment(),
        mintedGiftId: qbLedgerMintedGiftIdForPayment(),
        isGroupMember: sql<boolean>`EXISTS (
          SELECT 1 FROM unit_group_members ugm
          WHERE ugm.evidence_source = 'quickbooks'
            AND ugm.source_id = ${stagedPayments.id}
        )`,
      })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, stagedPaymentId))
      .then((r) => r[0]);
    if (!pre) return notFound(res, "staged payment");
    if (pre.status === "match_confirmed") {
      const tiedGiftId = pre.mintedGiftId == null ? pre.linkedGiftId : null;
      if (tiedGiftId != null && tiedGiftId === giftId) {
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
      if (pre.mintedGiftId != null) {
        // The row OWNS a minted gift — re-pointing would orphan the mint.
        res.status(409).json({
          error: "gift_already_linked",
          message:
            "This payment already owns a created gift. Revert that gift before linking it elsewhere.",
        });
        return;
      }
      if (pre.isGroupMember) {
        // Group members can't be individually re-targeted without corrupting
        // the group's combined booking.
        res.status(409).json({
          error: "not_approvable",
          message:
            "This payment is reconciled through a group. Revert the group first, then re-target.",
        });
        return;
      }
      if (pre.linkedGiftId == null) {
        // Settlement-only confirm (or split): the deposit's Stripe settlement
        // was confirmed with no gift on the deposit itself. The remaining money
        // is booked from the per-charge card, never by linking the whole QB
        // lump to one gift here.
        res.status(409).json({
          error: "not_approvable",
          message:
            "This deposit's Stripe settlement is already confirmed without a gift on the deposit. Book the remaining money from its Stripe charge card instead.",
        });
        return;
      }
      // Confirmed DIRECT match (counted 1:1 ledger row, no mint/group) being
      // pointed at a DIFFERENT gift: fall through to the transaction. The gate
      // composes payment_already_applied there, so the reviewer gets the normal
      // guarded re-target confirmation (moveOwnApplication) instead of a
      // dead-end.
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
    // Gifts whose ledger rows changed in the §4.3 settlement-supersede
    // recompute inside the commit — tie status recomputed post-commit.
    const supersedeGiftIds: string[] = [];

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
            // Ledger-derived link shape (the legacy staged gift-link columns
            // are @deprecated and never read): the single counted gift, the
            // minted gift, and QB group membership.
            ledgerSoleGiftId: qbLedgerSoleGiftIdForPayment(),
            ledgerMintedGiftId: qbLedgerMintedGiftIdForPayment(),
            ledgerGroupMember: isQbGroupMemberSql(),
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
        // A confirmed DIRECT match (exactly one counted ledger row, not a mint,
        // not a group member) may be re-targeted onto a different gift through
        // the guarded move/displace flow below — the gate still composes
        // payment_already_applied unless the reviewer confirmed
        // moveOwnApplication. Every other confirmed shape (settlement-only,
        // group, split, minted) stays closed.
        const openForRelink =
          staged.status === "match_confirmed" &&
          staged.ledgerSoleGiftId != null &&
          staged.ledgerMintedGiftId == null &&
          !staged.ledgerGroupMember;
        if (!isStagedApprovable(staged.status) && !openForRelink) {
          throw new ApproveAbort(409, {
            error: "not_approvable",
            message:
              "This staged payment is no longer open for reconciliation. Refresh and try again.",
          });
        }
        // A row that OWNS a minted gift (a counted ledger row with
        // created_the_gift = true) must not be re-pointed to some other gift
        // here — that would demote its provenance and orphan the mint. No such
        // row reaches the work queue today (minting confirms the row); this is
        // a forward guard against future approved+created rows.
        if (staged.ledgerMintedGiftId != null) {
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
        // the payment's counted ledger gift is the applied gift, and the
        // row must not have minted a gift (guarded above), be
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
        // On the guarded relink path (confirmed DIRECT match being re-pointed)
        // the applied gift is the payment's single counted ledger gift. Treat
        // it as the applied gift so the re-target still composes
        // payment_already_applied and requires the reviewer's explicit
        // moveOwnApplication confirmation — never a silent re-point.
        const effectiveAppliedGiftId =
          ownAppliedGiftId ??
          (openForRelink && staged.ledgerSoleGiftId !== giftId
            ? staged.ledgerSoleGiftId
            : null);
        if (
          effectiveAppliedGiftId &&
          staged.ledgerSoleGiftId === effectiveAppliedGiftId &&
          staged.ledgerMintedGiftId == null &&
          !staged.ledgerGroupMember
        ) {
          movableOwnApplication = effectiveAppliedGiftId;
          oldAppliedGift =
            (await tx
              .select()
              .from(giftsAndPayments)
              .where(eq(giftsAndPayments.id, effectiveAppliedGiftId))
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
          const chargeLedger = await chargeCountedLedgerRow(tx, charge.id);
          const chargeDerived = deriveStripeChargeStatus({
            ...charge,
            hasCountedApplication: chargeLedger != null,
          });
          const chargePending = chargeDerived === "pending";
          const chargeIdempotent =
            chargeDerived === "match_confirmed" &&
            chargeLedger != null &&
            !chargeLedger.createdTheGift &&
            chargeLedger.giftId === giftId;
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
        //
        // finalAmountStripeChargeId is @deprecated; read from the ledger instead.
        let oldStripeCharge: typeof stripeStagedCharges.$inferSelect | null = null;
        const currentChargeId = await giftCountedStripeChargeId(tx, giftId);
        const switchingStripeSource =
          !!charge && !!currentChargeId && currentChargeId !== charge.id;
        if (switchingStripeSource && currentChargeId) {
          oldStripeCharge =
            (await tx
              .select()
              .from(stripeStagedCharges)
              .where(eq(stripeStagedCharges.id, currentChargeId))
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
          staged: { id: staged.id, status: staged.status, openForRelink },
          gift: {
            id: gift.id,
            amount: gift.amount,
            archivedAt: gift.archivedAt,
            organizationId: effectiveGiftDonor.organizationId,
            individualGiverPersonId: effectiveGiftDonor.individualGiverPersonId,
            householdId: effectiveGiftDonor.householdId,
            finalAmountSource: gift.finalAmountSource,
            // Ledger-sourced (finalAmountStripeChargeId is @deprecated).
            currentStripeChargeId: currentChargeId,
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
          allowRelink: openForRelink,
          userId: user.id,
          auditReq: req,
        });
        rederivePledgeIds.push(...linkResult.rederivePledgeIds);
        movedFromGiftId = linkResult.movedFromGiftId;
        supersedeGiftIds.push(...linkResult.rederiveGiftIds);
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
    // (likely → missing) — recompute it too, plus any supersede-affected gifts.
    await applyGiftQbTieMany(giftId, movedFromGiftId, ...supersedeGiftIds);

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
