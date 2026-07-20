import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import {
  stripeStagedCharges,
  stripePayouts,
  stripeSyncState,
  stagedPayments,
  giftAllocations,
  giftsAndPayments,
  donorboxDonations,
  organizations,
  households,
  people,
  paymentIntermediaries,
  settlementLinks,
  paymentApplications,
} from "@workspace/db/schema";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias, type PgSelect } from "drizzle-orm/pg-core";
import { requireAuth } from "../middlewares/requireAuth";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parsePagination,
} from "../lib/helpers";
import {
  seedInitialGiftAllocation,
  assertGiftHasAllocations,
} from "../lib/giftAllocationSeed";
import { getAppUser } from "../lib/appRequest";
import {
  validateGiftInvariants,
  type InvariantIssue,
  ResolveStagedPaymentBody,
  ExcludeStagedPaymentBody,
  LinkStripeChargeToGiftBody,
} from "@workspace/api-zod";
import { linkChargeToGiftInTx } from "../lib/reconciliationBundleCommit";
import {
  ReconcileAbort,
  orphanStripeSourceChargeInTx,
} from "../lib/reconciliationCommit";
import { donorOf, hasExactlyOneDonor, donorsMatch } from "../lib/quickbooksLink";
import { applyDerivedOppFieldsMany } from "../lib/pledgeStage";
import { buildGiftValuesFromStripeCharge } from "../lib/stripeGift";
import {
  bookStripeChargeApplication,
  removePaymentApplicationsForGift,
  removePaymentApplicationsForPayment,
  removePaymentApplicationsForStripeCharge,
  qbLedgerDirectMatchExists,
  qbLedgerSoleGiftIdForPayment,
  DEFAULT_PAYMENT_ID_SQL,
  stripeLedgerGiftIdForCharge,
  chargeCountedLedgerRow,
} from "../lib/paymentApplications";
import {
  unstampGiftFinalAmount,
  adjustSingleAllocationOrFlag,
} from "../lib/giftFinalAmount";
import { applySupersedeForPayoutInTx } from "../lib/settlementSupersede";
import {
  reconAudit,
  fmtMoney,
  payerLabel,
} from "../lib/reconciliationAudit";
import { giftHeaderColumns } from "./giftsAndPayments";
import { logger } from "../lib/logger";
import {
  syncStripe,
  rematchStripeCharges,
  startStripeFullResync,
  getStripeFullResyncState,
} from "../lib/stripeSync";
import {
  confirmRefundPropagation,
  dismissRefundPropagation,
  isFullyRefunded,
} from "../lib/stripeRefund";
import {
  confirmPendingQbDeposit,
  confirmKeepApprovedQbGift,
  confirmReplaceApprovedQbGift,
  revertPayoutQbConfirmation,
  type ConfirmRevertResult,
} from "../lib/stripeConfirm";
import { proposePayoutMatches } from "../lib/stripeReconcile";
import { proposeChargeQbTies } from "../lib/chargeQbTie";
import {
  chargeStatusIn,
  chargeStatusSql,
  chargeStatusWhere,
  deriveStripeChargeStatus,
  qbStatusCaseText,
} from "../lib/derivedStatus";
import {
  deriveEvidenceLanes,
  derivePayoutLanes,
} from "../lib/reconciliationLanes";
import {
  donorboxEnrichmentSelect,
  donorboxEnrichmentOrNull,
} from "../lib/donorboxEnrichment";
import { personDisplayNameSql } from "../lib/personNameSql";

/**
 * Review queue for incoming Stripe charges plus the manual sync / rematch
 * triggers. Mirrors the QuickBooks reconciler (routes/quickbooks.ts) but keyed
 * on Stripe ids and grouped under the payout each charge settled in.
 *
 * Queue buckets (status is DERIVED from facts — see lib/derivedStatus.ts —
 * identical semantics to staged_payments):
 *   pending         : no exclusion, no gift link — still needs review.
 *   match_proposed  : autoApplied=true, matchConfirmedAt IS NULL, gift link
 *                     present — high-confidence reconciles the system applied.
 *   match_confirmed : linked to / minted into a gift (human or confirmed auto).
 *   excluded        : exclusion_reason set — non-gift noise or a dismissal.
 *
 * Money: donors are credited the GROSS charge amount. The payout net is
 * gross − fees − refunds; the gap is processor fees (never a donor amount).
 *
 * Listing/resolving is open to any authenticated fundraiser; sync / rematch are
 * admin-gated.
 */
const router: IRouter = Router();
router.use(requireAuth);

function requireAdmin(
  req: import("express").Request,
  res: import("express").Response,
): boolean {
  const me = getAppUser(req);
  if (!me || me.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return false;
  }
  return true;
}

function respondInvariantFailure(res: Response, issues: InvariantIssue[]): void {
  res.status(400).json({
    error: "validation_error",
    message: "Request validation failed",
    details: {
      issues: issues.map((i) => ({ path: [i.path], message: i.message })),
    },
  });
}

// The gift a staged charge resolved to (reconciled OR minted), for display.
const resolvedGift = alias(giftsAndPayments, "resolved_gift");

// Derived queue bucket for a staged charge (kept in sync with queueWhere below).
// Status is fully derived from facts (lib/derivedStatus.ts) — there is no
// stored status column.
const queueExpr = sql<string>`
  CASE
    WHEN ${chargeStatusWhere.excluded} THEN 'excluded'
    WHEN ${chargeStatusWhere.pending} THEN 'needs_review'
    WHEN ${chargeStatusWhere.match_proposed} THEN 'auto_matched'
    ELSE 'done'
  END
`.as("queue");

// Verbatim raw Stripe charge JSON is stored for audit but excluded from every
// list/detail response — it is large and never needed by the UI.
const { rawCharge: _rawCharge, ...stagedColumns } =
  getTableColumns(stripeStagedCharges);

const stagedSelect = {
  ...stagedColumns,
  // Derived lifecycle status — pending | match_proposed | match_confirmed |
  // excluded (lib/derivedStatus.ts).
  status: chargeStatusSql,
  queue: queueExpr,
  organizationName: organizations.name,
  householdName: households.name,
  individualGiverPersonName: personDisplayNameSql(people).as(
    "individual_giver_person_name",
  ),
  intermediaryName: paymentIntermediaries.name,
  resolvedGiftId: resolvedGift.id,
  resolvedGiftName: resolvedGift.name,
  resolvedGiftAmount: resolvedGift.amount,
  resolvedGiftDate: resolvedGift.dateReceived,
  // Payout-level rollups (gross − fees − refunds = net) so the UI can group
  // charges under their payout and show the fee gap. Joined read-only.
  payoutAmount: stripePayouts.amount,
  payoutGrossTotal: stripePayouts.grossTotal,
  payoutFeeTotal: stripePayouts.feeTotal,
  payoutRefundTotal: stripePayouts.refundTotal,
  payoutNetTotal: stripePayouts.netTotal,
  payoutArrivalDate: stripePayouts.arrivalDate,
  payoutStatus: stripePayouts.status,
  // A conflict gift on the payout's settlement link blocks minting a
  // duplicate per-charge gift (the KEEP/REPLACE decision is still open).
  payoutQbConflictGiftId: settlementLinks.conflictGiftId,
};

function withJoins<T extends PgSelect>(q: T) {
  return q
    .leftJoin(
      organizations,
      eq(organizations.id, stripeStagedCharges.organizationId),
    )
    .leftJoin(households, eq(households.id, stripeStagedCharges.householdId))
    .leftJoin(
      people,
      eq(people.id, stripeStagedCharges.individualGiverPersonId),
    )
    .leftJoin(
      paymentIntermediaries,
      eq(
        paymentIntermediaries.id,
        stripeStagedCharges.matchedPaymentIntermediaryId,
      ),
    )
    .leftJoin(
      resolvedGift,
      // Ledger-resolved gift link (the legacy matched/created gift-pointer
      // columns are retired, never read).
      sql`${resolvedGift.id} = ${stripeLedgerGiftIdForCharge()}`,
    )
    .leftJoin(
      stripePayouts,
      eq(stripePayouts.id, stripeStagedCharges.stripePayoutId),
    )
    .leftJoin(
      settlementLinks,
      eq(settlementLinks.payoutId, stripeStagedCharges.stripePayoutId),
    );
}

type Queue =
  | "needs_review"
  | "auto_matched"
  | "excluded"
  | "done"
  | "refund_review";

const STAGED_SORTS = [
  "date_desc",
  "date_asc",
  "amount_desc",
  "amount_asc",
  "payer_asc",
  "payer_desc",
] as const;
type StagedSort = (typeof STAGED_SORTS)[number];

function stagedOrderBy(sort: StagedSort) {
  switch (sort) {
    case "date_asc":
      return [
        asc(stripeStagedCharges.dateReceived),
        desc(stripeStagedCharges.createdAt),
      ];
    case "amount_desc":
      return [
        desc(stripeStagedCharges.grossAmount),
        desc(stripeStagedCharges.createdAt),
      ];
    case "amount_asc":
      return [
        asc(stripeStagedCharges.grossAmount),
        desc(stripeStagedCharges.createdAt),
      ];
    case "payer_asc":
      return [
        asc(stripeStagedCharges.payerName),
        desc(stripeStagedCharges.createdAt),
      ];
    case "payer_desc":
      return [
        desc(stripeStagedCharges.payerName),
        desc(stripeStagedCharges.createdAt),
      ];
    case "date_desc":
    default:
      return [
        desc(stripeStagedCharges.dateReceived),
        desc(stripeStagedCharges.createdAt),
      ];
  }
}

// Escape LIKE/ILIKE wildcards so "%"/"_" search for those literal characters.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function stagedSearchWhere(term: string) {
  const like = `%${escapeLike(term)}%`;
  return or(
    ilike(stripeStagedCharges.payerName, like),
    ilike(stripeStagedCharges.payerEmail, like),
    ilike(stripeStagedCharges.description, like),
    ilike(stripeStagedCharges.statementDescriptor, like),
  );
}

function queueWhere(queue: Queue) {
  switch (queue) {
    case "auto_matched":
      // A system-applied gift link a human has not yet reviewed.
      return chargeStatusWhere.match_proposed;
    case "done":
      // Settled work: the charge's money is booked to a gift (linked or
      // minted) and human-owned (confirmed or never auto-applied).
      return chargeStatusWhere.match_confirmed;
    case "excluded":
      return chargeStatusWhere.excluded;
    case "refund_review":
      // Cross-cutting filter (independent of status): charges with a refund /
      // chargeback proposal awaiting a human confirm/dismiss (INV-13).
      return eq(stripeStagedCharges.refundPropagationStatus, "proposed");
    case "needs_review":
    default:
      return chargeStatusWhere.pending;
  }
}

// ─── GET /stripe-staged-charges ────────────────────────────────────────────
router.get(
  "/stripe-staged-charges",
  asyncHandler(async (req, res) => {
    const raw = typeof req.query["queue"] === "string" ? req.query["queue"] : "";
    const queue: Queue = (
      [
        "needs_review",
        "auto_matched",
        "excluded",
        "done",
        "refund_review",
      ] as const
    ).includes(raw as Queue)
      ? (raw as Queue)
      : "needs_review";
    const rawSort =
      typeof req.query["sort"] === "string" ? req.query["sort"] : "";
    const sort: StagedSort = (STAGED_SORTS as readonly string[]).includes(
      rawSort,
    )
      ? (rawSort as StagedSort)
      : "date_desc";
    const { limit, offset, page } = parsePagination(req.query);
    const search =
      typeof req.query["search"] === "string" ? req.query["search"].trim() : "";
    const where = search
      ? and(queueWhere(queue), stagedSearchWhere(search))
      : queueWhere(queue);

    const [rows, totalRow] = await Promise.all([
      withJoins(
        db
          .select({ ...stagedSelect, donorbox: donorboxEnrichmentSelect })
          .from(stripeStagedCharges)
          .$dynamic(),
      )
        .leftJoin(
          donorboxDonations,
          eq(donorboxDonations.stripeChargeId, stripeStagedCharges.id),
        )
        .where(where)
        .orderBy(...stagedOrderBy(sort))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(stripeStagedCharges)
        .where(where)
        .then((r) => r[0]),
    ]);

    res.json({
      data: rows.map((row) => ({
        ...row,
        donorbox: donorboxEnrichmentOrNull(row.donorbox),
        reconciliationLanes: deriveEvidenceLanes({
          status: row.status,
          donorPresent:
            row.organizationId != null ||
            row.individualGiverPersonId != null ||
            row.householdId != null,
          donorConfirmed: row.matchConfirmedAt != null,
          giftLinked: row.resolvedGiftId != null,
          giftProposed: false,
        }),
      })),
      pagination: { page, limit, total: totalRow?.value ?? 0 },
    });
  }),
);

// ─── GET /stripe-staged-charges-summary ────────────────────────────────────
router.get(
  "/stripe-staged-charges-summary",
  asyncHandler(async (_req, res) => {
    const [statusRows, reasonRows, refundReviewRow] = await Promise.all([
      db
        .select({ status: chargeStatusSql, value: count() })
        .from(stripeStagedCharges)
        .groupBy(chargeStatusSql),
      db
        .select({
          reason: stripeStagedCharges.exclusionReason,
          value: count(),
        })
        .from(stripeStagedCharges)
        .where(chargeStatusWhere.excluded)
        .groupBy(stripeStagedCharges.exclusionReason),
      db
        .select({ value: count() })
        .from(stripeStagedCharges)
        .where(queueWhere("refund_review"))
        .then((r) => r[0]),
    ]);

    const byStatus = {
      pending: 0,
      match_proposed: 0,
      match_confirmed: 0,
      excluded: 0,
    };
    for (const r of statusRows) {
      if (r.status in byStatus) {
        byStatus[r.status as keyof typeof byStatus] = r.value;
      }
    }

    const excludedByReason = {
      zero_amount: 0,
      // `loan` is a retired legacy reason kept for historical rows; new rows use
      // the split loan_repayment / loan_proceeds / note_payable reasons.
      loan: 0,
      loan_repayment: 0,
      loan_proceeds: 0,
      note_payable: 0,
      miscoded_withdrawal: 0,
      membership: 0,
      interest: 0,
      // `government_reimbursement` no longer excludes (rows flow into the queue);
      // kept here so any legacy excluded rows still surface in the summary.
      government_reimbursement: 0,
      tax_refund: 0,
      other_revenue: 0,
      earned_income: 0,
      // `fiscally_sponsored` exclusion retired (surfaced via the worklist now);
      // legacy excluded rows still counted.
      fiscally_sponsored: 0,
      intercompany_transfer: 0,
      other: 0,
      insurance: 0,
      expense_refund: 0,
      expensify: 0,
      returned_wire: 0,
    };
    for (const r of reasonRows) {
      if (r.reason && r.reason in excludedByReason) {
        excludedByReason[r.reason as keyof typeof excludedByReason] = r.value;
      }
    }

    res.json({
      needsReview: byStatus.pending,
      // Derived buckets map 1:1 onto the queues: match_proposed = auto-matched
      // awaiting review, match_confirmed = done (booked + human-owned).
      autoMatched: byStatus.match_proposed,
      done: byStatus.match_confirmed,
      excluded: byStatus.excluded,
      // Open refund/chargeback proposals awaiting a human confirm/dismiss.
      refundReview: refundReviewRow?.value ?? 0,
      excludedByReason,
    });
  }),
);

// ─── POST /stripe-staged-charges/:id/resolve ───────────────────────────────
// Fundraiser fixes the donor match (sets exactly one donor FK). Keeps the row
// pending; switches matchStatus to "matched" and stamps human confirmation.
router.post(
  "/stripe-staged-charges/:id/resolve",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const parsed = ResolveStagedPaymentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const body = parsed.data;

    const existing = await db
      .select({ status: chargeStatusSql })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "stripe staged charge");
    if (existing.status !== "pending") {
      res.status(409).json({
        error: "not_pending",
        message: "Only pending staged charges can be resolved.",
      });
      return;
    }

    const donor = {
      organizationId: body.organizationId ?? null,
      individualGiverPersonId: body.individualGiverPersonId ?? null,
      householdId: body.householdId ?? null,
    };
    const issues = validateGiftInvariants(donor);
    if (issues.length) return respondInvariantFailure(res, issues);

    const [row] = await db
      .update(stripeStagedCharges)
      .set({
        ...donor,
        matchStatus: "matched",
        matchMethod: "manual",
        matchedPaymentIntermediaryId: body.paymentIntermediaryId ?? null,
        matchConfirmedByUserId: user.id,
        matchConfirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(stripeStagedCharges.id, id), chargeStatusWhere.pending),
      )
      .returning();
    if (!row) {
      res.status(409).json({
        error: "not_pending",
        message: "This staged charge is no longer pending. Refresh and retry.",
      });
      return;
    }
    // Donor-only resolve on a still-pending charge — no un-resolve endpoint
    // exists (revert requires a gift link), so no safe undo.
    await reconAudit(req, {
      action: "update",
      entityType: "stripe_staged_charge",
      entityId: id,
      summary: `Set the donor on the Stripe charge from ${payerLabel(row.payerName)} (${fmtMoney(row.grossAmount)})`,
      undo: null,
    });
    res.json(row);
  }),
);

// ─── POST /stripe-staged-charges/:id/link-gift ─────────────────────────────
// Tie a single Stripe charge (a per-charge card expanded from a MULTI-charge
// payout) to an EXISTING gift as permanent reconciled evidence. Mirrors the
// settlement-bundle charge-link path (linkChargeToGiftInTx) but for one charge:
// the charge adopts the gift's donor (or a confirmed switch), the gift's final
// amount is stamped to the charge GROSS, and the charge never touches the payout
// (the payout↔deposit tie is owned separately). No new gift is minted.
//
// Why this exists: a multi-charge payout's QB deposit approve carries a
// deposit-level graph whose evidence.stripe.chargeId is null, so the per-charge
// "Approve"/re-target on the workbench can't route through the deposit approve
// (it 409s stripe_charge_required). This is the per-charge money path for that
// case.
router.post(
  "/stripe-staged-charges/:id/link-gift",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const parsed = LinkStripeChargeToGiftBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const { giftId } = parsed.data;

    const rederivePledgeIds: string[] = [];
    const supersedeGiftIds: string[] = [];
    let alreadyLinked = false;
    try {
      await db.transaction(async (tx) => {
        // Lock the gift, then the charge (bundle lock order: gift before charge).
        const gift = await tx
          .select()
          .from(giftsAndPayments)
          .where(eq(giftsAndPayments.id, giftId))
          .for("update")
          .then((r) => r[0]);
        if (!gift) {
          throw new ReconcileAbort(404, {
            error: "not_found",
            message: "Gift not found.",
          });
        }
        if (gift.archivedAt != null) {
          throw new ReconcileAbort(409, {
            error: "gift_archived",
            message: "That gift is archived. Restore it before linking.",
          });
        }
        const charge = await tx
          .select()
          .from(stripeStagedCharges)
          .where(eq(stripeStagedCharges.id, id))
          .for("update")
          .then((r) => r[0]);
        if (!charge) {
          throw new ReconcileAbort(404, {
            error: "not_found",
            message: "Stripe staged charge not found.",
          });
        }
        // Idempotent: already reconciled to THIS gift (matched, not minted) →
        // no-op success. Ledger-based (pointer columns are retired).
        const chargeLedger = await chargeCountedLedgerRow(tx, charge.id);
        const chargeStatus = deriveStripeChargeStatus({
          ...charge,
          hasCountedApplication: chargeLedger != null,
        });
        if (
          chargeStatus === "match_confirmed" &&
          chargeLedger != null &&
          !chargeLedger.createdTheGift &&
          chargeLedger.giftId === giftId
        ) {
          alreadyLinked = true;
          return;
        }
        if (chargeStatus !== "pending") {
          throw new ReconcileAbort(409, {
            error: "not_pending",
            message:
              "This staged charge is no longer open for reconciliation. Refresh and try again.",
          });
        }

        // ── Incumbent Stripe source (one gift ↔ one backing charge) ────────
        // A DIFFERENT charge already backing this gift blocks the link unless
        // the reviewer confirmed a source switch — the same
        // gift_already_stripe_sourced gate the deposit-approve re-target path
        // raises, so the workbench can offer one confirm-the-swap dialog for
        // both. On a confirmed switch the incumbent is orphaned back to the
        // unmatched-money queue FIRST (the ledger's partial-unique forbids two
        // counted charges on one gift, and the unstamp is pointer-safe),
        // then this charge is linked below. The gift is never deleted, even
        // if the incumbent minted it — it is the switch target. Resolved via
        // the counted ledger rows (pointer columns are retired).
        const incumbentLedger = await tx
          .select({ chargeId: paymentApplications.stripeChargeId })
          .from(paymentApplications)
          .where(
            and(
              eq(paymentApplications.giftId, giftId),
              eq(paymentApplications.evidenceSource, "stripe"),
              eq(paymentApplications.linkRole, "counted"),
              ne(paymentApplications.stripeChargeId, charge.id),
            ),
          )
          .limit(1)
          .then((r) => r[0]);
        const incumbent = incumbentLedger?.chargeId
          ? ((await tx
              .select()
              .from(stripeStagedCharges)
              .where(eq(stripeStagedCharges.id, incumbentLedger.chargeId))
              .for("update")
              .then((r) => r[0])) ?? null)
          : null;
        if (incumbent && parsed.data.switchStripeSource !== true) {
          const message =
            "This gift's amount is already sourced from a different Stripe charge.";
          throw new ReconcileAbort(409, {
            error: "consistency_gate",
            message,
            details: {
              issues: [
                {
                  code: "gift_already_stripe_sourced",
                  message,
                  details: {
                    currentStripeCharge: {
                      id: incumbent.id,
                      amount: incumbent.grossAmount,
                      payerName: incumbent.payerName,
                      date: incumbent.dateReceived,
                    },
                    targetStripeChargeId: charge.id,
                  },
                },
              ],
            },
          });
        }
        if (incumbent) {
          await orphanStripeSourceChargeInTx(tx, {
            oldCharge: incumbent,
            giftId,
          });
        }

        // Donor: the charge adopts the gift's donor. A confirmed switch
        // (switchGiftDonor + exactly one donor FK) re-points the gift instead.
        // Mirrors the settlement-bundle existing-donor branch.
        const giftDonor = donorOf(gift);
        let effectiveGiftDonor = giftDonor;
        let donorSwitching = false;
        if (parsed.data.switchGiftDonor === true) {
          const chosen = {
            organizationId: parsed.data.organizationId ?? null,
            individualGiverPersonId: parsed.data.individualGiverPersonId ?? null,
            householdId: parsed.data.householdId ?? null,
          };
          if (!hasExactlyOneDonor(chosen)) {
            throw new ReconcileAbort(400, {
              error: "donor_xor",
              message:
                "A donor switch needs exactly one donor (organization, person, or household).",
            });
          }
          if (!donorsMatch(giftDonor, chosen)) {
            effectiveGiftDonor = chosen;
            donorSwitching = true;
          }
        }

        const linkRes = await linkChargeToGiftInTx(tx, {
          charge,
          gift,
          giftId,
          effectiveGiftDonor,
          donorSwitching,
          userId: user.id,
          auditReq: req,
        });
        rederivePledgeIds.push(...linkRes.rederivePledgeIds);
        supersedeGiftIds.push(...linkRes.supersedeGiftIds);
      });
    } catch (e) {
      if (e instanceof ReconcileAbort) {
        res.status(e.httpStatus).json(e.payload);
        return;
      }
      // Unique violation: another Stripe charge just claimed this gift between
      // the ownership check and the guarded update. Surface as a conflict.
      if (
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        (e as { code?: string }).code === "23505"
      ) {
        res.status(409).json({
          error: "link_conflict",
          message:
            "That gift was just linked to another Stripe charge. Refresh and try again.",
        });
        return;
      }
      throw e;
    }

    // Re-derive the linked pledge(s) + recompute the gift's QuickBooks tie from
    // the committed evidence (outside the tx, on their own connections). Skipped
    // for the idempotent no-op — nothing changed.
    if (!alreadyLinked) {
      if (rederivePledgeIds.length) {
        await applyDerivedOppFieldsMany(...rederivePledgeIds);
      }
    }

    const [row] = await db
      .select()
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, id));
    // Reconciled to an EXISTING gift — the Stripe revert safely unlinks it
    // (gift left intact). Skipped for the idempotent already-linked no-op.
    if (!alreadyLinked) {
      const [linkedGift] = await db
        .select({ name: giftsAndPayments.name })
        .from(giftsAndPayments)
        .where(eq(giftsAndPayments.id, giftId));
      await reconAudit(req, {
        action: "update",
        entityType: "stripe_staged_charge",
        entityId: id,
        summary: `Linked the Stripe charge from ${payerLabel(row?.payerName)} (${fmtMoney(row?.grossAmount)}) to gift "${linkedGift?.name ?? giftId}"`,
        undo: { kind: "revert_stripe_charge", targetId: id },
        extra: { giftId },
      });
    }
    res.json(row);
  }),
);

// ─── POST /stripe-staged-charges/:id/create-gift ───────────────────────────
// Mint a real gifts_and_payments row (donor XOR) crediting the GROSS amount,
// then mark the staged row approved + done (autoApplied=false, human-confirmed).
router.post(
  "/stripe-staged-charges/:id/create-gift",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const existing = await db
      .select()
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "stripe staged charge");
    const existingLedger = await chargeCountedLedgerRow(db, id);
    if (
      deriveStripeChargeStatus({
        ...existing,
        hasCountedApplication: existingLedger != null,
      }) !== "pending"
    ) {
      res.status(409).json({
        error: "not_pending",
        message: "This staged charge has already been resolved.",
      });
      return;
    }
    const preIssues = validateGiftInvariants({
      organizationId: existing.organizationId,
      individualGiverPersonId: existing.individualGiverPersonId,
      householdId: existing.householdId,
    });
    if (preIssues.length) return respondInvariantFailure(res, preIssues);

    const giftId = newId();
    // Lock + re-read inside the tx so the gift is always minted from the fresh
    // donor snapshot (a concurrent unmatch/resolve can change the donor while
    // status stays pending → TOCTOU).
    const NOT_PENDING = "__staged_not_pending__";
    const INVARIANT = "__staged_invariant__";
    const QB_CONFLICT = "__qb_conflict__";
    let lockedIssues: InvariantIssue[] = [];
    const supersedeGiftIds: string[] = [];
    try {
      await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(stripeStagedCharges)
          .where(eq(stripeStagedCharges.id, id))
          .for("update")
          .then((r) => r[0]);
        if (!locked) throw new Error(NOT_PENDING);
        const lockedLedger = await chargeCountedLedgerRow(tx, id);
        if (
          deriveStripeChargeStatus({
            ...locked,
            hasCountedApplication: lockedLedger != null,
          }) !== "pending"
        ) {
          throw new Error(NOT_PENDING);
        }

        // Non-destructive QuickBooks reconciliation guard: if this charge's
        // payout was matched to an ALREADY-APPROVED QB net lump (a conflict
        // awaiting the human's KEEP/REPLACE decision), minting a per-charge gift
        // here would double-count. Block until that conflict is resolved in the
        // reconciliation queue (we never mutate QB data). Set by the proposal
        // pass; inert (unmatched) until a proposal lands on an approved lump.
        if (locked.stripePayoutId) {
          // Read-flip: the settlement link is authoritative. Block when the
          // payout's money is ALREADY booked as a QB-derived gift — a link
          // carrying a conflict gift, whether an unresolved conflict (proposed
          // link + conflict gift) or a confirmed "keep" that left that gift in
          // place (confirmed link + conflict gift). A link with no conflict gift
          // reconciled a bare deposit into no gift, so per-charge gifts are still
          // the correct booking — allow it.
          const link = await tx
            .select({ conflictGiftId: settlementLinks.conflictGiftId })
            .from(settlementLinks)
            .where(eq(settlementLinks.payoutId, locked.stripePayoutId))
            .then((r) => r[0]);
          if (link?.conflictGiftId) {
            throw new Error(QB_CONFLICT);
          }
        }

        const donor = {
          organizationId: locked.organizationId,
          individualGiverPersonId: locked.individualGiverPersonId,
          householdId: locked.householdId,
        };
        const issues = validateGiftInvariants(donor);
        if (issues.length) {
          lockedIssues = issues;
          throw new Error(INVARIANT);
        }
        await tx.insert(giftsAndPayments).values(
          buildGiftValuesFromStripeCharge(
            giftId,
            {
              chargeId: locked.id,
              grossAmount: locked.grossAmount,
              feeAmount: locked.feeAmount,
              dateReceived: locked.dateReceived,
              payerName: locked.payerName,
              description: locked.description,
              organizationId: donor.organizationId,
              individualGiverPersonId: donor.individualGiverPersonId,
              householdId: donor.householdId,
              matchedPaymentIntermediaryId: locked.matchedPaymentIntermediaryId,
            },
            user.id,
          ),
        );
        // Every gift needs at least one allocation (the sole home of money
        // scope). Seed a default full-amount line; fundraiser refines scope later.
        await seedInitialGiftAllocation(tx, {
          giftId,
          amount: locked.grossAmount,
          dateReceived: locked.dateReceived,
        });
        await assertGiftHasAllocations(tx, giftId);
        await tx
          .update(stripeStagedCharges)
          .set({
            // D4: this charge is now permanent EVIDENCE tied to the gift it
            // minted — the counted ledger row booked below (createdTheGift:
            // true) + the confirmation stamps derive it to `match_confirmed`.
            // No gift-pointer write (the legacy columns are retired).
            autoApplied: false,
            matchStatus: "matched",
            matchConfirmedByUserId: user.id,
            matchConfirmedAt: new Date(),
            approvedByUserId: user.id,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(stripeStagedCharges.id, id));
        // Dual-write (Phase 2): this charge MINTED the gift
        // (createdTheGift:true). Book the charge → gift ledger row;
        // delete-by-anchor keeps it idempotent.
        await bookStripeChargeApplication(tx, {
          stripeChargeId: locked.id,
          grossAmount: locked.grossAmount,
          giftId,
          matchMethod: "human",
          confirmedByUserId: user.id,
          confirmedAt: new Date(),
          createdTheGift: true,
        });
        // §4.3 supersede: this per-charge counted row may complete the
        // coverage of a coarse QB deposit confirmed-settled against the
        // charge's payout — the deposit's coarse row demotes in the same tx.
        supersedeGiftIds.push(
          ...(await applySupersedeForPayoutInTx(tx, locked.stripePayoutId)),
        );
      });
    } catch (e) {
      if (e instanceof Error && e.message === NOT_PENDING) {
        res.status(409).json({
          error: "not_pending",
          message: "This staged charge has already been resolved.",
        });
        return;
      }
      if (e instanceof Error && e.message === QB_CONFLICT) {
        res.status(409).json({
          error: "qb_conflict",
          message:
            "This payout is already booked as an approved QuickBooks lump. Resolve the QuickBooks side before creating per-charge gifts.",
        });
        return;
      }
      if (e instanceof Error && e.message === INVARIANT) {
        return respondInvariantFailure(res, lockedIssues);
      }
      throw e;
    }

    // Stripe-sourced gift (no direct QB link) ties at the payout level — persist
    const [gift] = await db
      .select(giftHeaderColumns)
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId));
    // A charge-minted gift IS revertible: the Stripe revert deletes the minted
    // gift (allocations + ledger rows cleared in-tx) and re-pends the charge.
    await reconAudit(req, {
      action: "create",
      entityType: "stripe_staged_charge",
      entityId: id,
      summary: `Created gift "${gift?.name ?? giftId}" from the Stripe charge from ${payerLabel(existing.payerName)} (${fmtMoney(existing.grossAmount)})`,
      undo: { kind: "revert_stripe_charge", targetId: id },
      extra: { giftId },
    });
    res.status(201).json({ gift, stagedPaymentId: id });
  }),
);

// ─── POST /stripe-staged-charges/:id/exclude ───────────────────────────────
// Human-driven exclude: file a staged charge under a non-gift category. Pins
// classificationSource='manual'. Allowed from pending or excluded (reclassify).
router.post(
  "/stripe-staged-charges/:id/exclude",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const parsed = ExcludeStagedPaymentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const { exclusionReason } = parsed.data;

    const existing = await db
      .select({ status: chargeStatusSql })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "stripe staged charge");
    if (existing.status !== "pending" && existing.status !== "excluded") {
      res.status(409).json({
        error: "not_excludable",
        message:
          "Only a pending or already-excluded staged charge can be excluded.",
      });
      return;
    }

    const [row] = await db
      .update(stripeStagedCharges)
      .set({
        // Setting exclusion_reason IS the exclusion (derived status).
        exclusionReason,
        classificationSource: "manual",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stripeStagedCharges.id, id),
          chargeStatusIn(["pending", "excluded"]),
        ),
      )
      .returning();
    if (!row) {
      res.status(409).json({
        error: "not_excludable",
        message: "This staged charge can no longer be excluded. Refresh.",
      });
      return;
    }
    await reconAudit(req, {
      action: "update",
      entityType: "stripe_staged_charge",
      entityId: id,
      summary: `Excluded the Stripe charge from ${payerLabel(row.payerName)} (${fmtMoney(row.grossAmount)}) — ${exclusionReason.replace(/_/g, " ")}`,
      undo: { kind: "reinclude_stripe_charge", targetId: id },
      extra: { exclusionReason },
    });
    res.json(row);
  }),
);

// ─── POST /stripe-staged-charges/:id/re-include ────────────────────────────
// Move an excluded row back to pending (false positive). Pins
// classificationSource='manual' so the re-runnable classifier never re-excludes.
router.post(
  "/stripe-staged-charges/:id/re-include",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const existing = await db
      .select({ status: chargeStatusSql })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "stripe staged charge");
    if (existing.status !== "excluded") {
      res.status(409).json({
        error: "not_excluded",
        message: "Only excluded staged charges can be re-included.",
      });
      return;
    }
    const [row] = await db
      .update(stripeStagedCharges)
      .set({
        // Clearing exclusion_reason returns the row to derived `pending`.
        exclusionReason: null,
        classificationSource: "manual",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stripeStagedCharges.id, id),
          chargeStatusWhere.excluded,
        ),
      )
      .returning();
    if (!row) {
      res.status(409).json({
        error: "not_excluded",
        message: "This staged charge is no longer excluded. Refresh and retry.",
      });
      return;
    }
    // No safe undo: re-excluding needs a reason the rail can't supply.
    await reconAudit(req, {
      action: "update",
      entityType: "stripe_staged_charge",
      entityId: id,
      summary: `Re-included the Stripe charge from ${payerLabel(row.payerName)} (${fmtMoney(row.grossAmount)}) back into the queue`,
      undo: null,
    });
    res.json(row);
  }),
);

// A Stripe-charge revert must also free any QuickBooks staged rows still
// reconciled to the same gift: the QB row would otherwise stay
// `reconciled`/`approved` pointing at a gift that just lost (or was deleted
// with) its Stripe evidence, stranding real money behind a 409 with no
// recovery path — a manual revert should fully undo the match. Rows are reset
// to pending (mirroring the QB revert in quickbooks/shared.ts) so the reviewer
// can immediately re-link them. Mint-owned (createdGiftId) and group-reconciled
// rows are excluded — those must be reverted through their own explicit paths.
async function cascadeResetLinkedQbStagedRows(
  tx: Parameters<typeof unstampGiftFinalAmount>[0],
  giftId: string,
  opts: {
    /** False when the gift is being deleted — there's no stamp left to unwind. */
    unstampGift: boolean;
  },
): Promise<string[]> {
  const rows = await tx
    .select({ id: stagedPayments.id })
    .from(stagedPayments)
    .where(
      and(
        // A DIRECT 1:1 counted ledger match to this gift IS the linked state
        // (ledger replacement for the dropped matched_gift_id shape —
        // non-mint, non-group). The sole-gift check additionally excludes
        // split payments (a split fans out to other gifts; resetting it here
        // would wipe the other legs' applications too — legacy splits carried
        // no pointer column and were never cascade-reset).
        qbLedgerDirectMatchExists(DEFAULT_PAYMENT_ID_SQL, sql`${giftId}`),
        sql`${qbLedgerSoleGiftIdForPayment()} = ${giftId}`,
      ),
    )
    .for("update");
  const ids: string[] = [];
  for (const qb of rows) {
    await removePaymentApplicationsForPayment(tx, qb.id);
    if (opts.unstampGift) {
      const un = await unstampGiftFinalAmount(tx, giftId, {
        source: "quickbooks",
        qbStagedPaymentId: qb.id,
      });
      if (un.restored) {
        await adjustSingleAllocationOrFlag(
          tx,
          giftId,
          un.oldAmount,
          un.newAmount,
          "quickbooks",
        );
      }
    }
    await tx
      .update(stagedPayments)
      .set({
        // The counted ledger rows were just removed above — that IS the unlink
        // (the legacy gift-link columns are @deprecated and never written, so
        // there is nothing to clear); resetting the confirmation stamps
        // derives the row back to pending.
        autoApplied: false,
        matchConfirmedByUserId: null,
        matchConfirmedAt: null,
        approvedByUserId: null,
        approvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(stagedPayments.id, qb.id));
    ids.push(qb.id);
  }
  return ids;
}

// ─── POST /stripe-staged-charges/:id/revert ────────────────────────────────
// Undo an approved row: unlink a reconciled gift (leave the gift intact) or
// delete a gift this row minted (clearing its allocations first — the gift
// belongs solely to this charge), returning the row to the pending queue.
// Any QuickBooks staged rows reconciled to the same gift are cascade-reset to
// pending alongside (see cascadeResetLinkedQbStagedRows above).
router.post(
  "/stripe-staged-charges/:id/revert",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);

    const NOT_FOUND = "__not_found__";
    const NOT_REVERTIBLE = "__not_revertible__";
    let reverted: typeof stripeStagedCharges.$inferSelect | null = null;
    let survivingGiftId: string | null = null;
    // QB staged rows cascade-reset to pending alongside this charge (logged
    // after commit as an audit trail — the reviewer sees the QB row reappear
    // in the pending queue).
    const cascadedQbStagedIds: string[] = [];
    const supersedeGiftIds: string[] = [];
    try {
      // Returned (not assigned inside the closure) so TS control-flow keeps
      // the row type on `reverted` for the audit summary below.
      reverted = await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(stripeStagedCharges)
          .where(eq(stripeStagedCharges.id, id))
          .for("update")
          .then((r) => r[0]);
        if (!locked) throw new Error(NOT_FOUND);
        // Revertible = the row carries a gift link of its own (auto-proposed
        // or confirmed/minted). Pending and excluded rows have nothing to undo.
        // The counted ledger row IS the gift link (pointer columns retired);
        // capture it before the branches below delete it.
        const lockedLedger = await chargeCountedLedgerRow(tx, id);
        const lockedStatus = deriveStripeChargeStatus({
          ...locked,
          hasCountedApplication: lockedLedger != null,
        });
        if (
          lockedStatus !== "match_proposed" &&
          lockedStatus !== "match_confirmed"
        ) {
          throw new Error(NOT_REVERTIBLE);
        }

        const hasDonor =
          !!locked.organizationId ||
          !!locked.individualGiverPersonId ||
          !!locked.householdId;
        const newMatchStatus = hasDonor ? "suggested" : "unmatched";

        if (lockedLedger?.createdTheGift) {
          const mintedGiftId = lockedLedger.giftId;
          // Free any QB staged rows still reconciled to this gift BEFORE
          // deleting it — the FK would SET NULL silently, stranding them as
          // reconciled-to-nothing with no revert path.
          cascadedQbStagedIds.push(
            ...(await cascadeResetLinkedQbStagedRows(tx, mintedGiftId, {
              unstampGift: false,
            })),
          );
          // This row minted the gift — remove it. Clear allocations first
          // (gift_allocations FK is RESTRICT; every gift has >= 1 only after a
          // human allocates). The gift is gone, so there's no stamp to unwind.
          await tx
            .delete(giftAllocations)
            .where(eq(giftAllocations.giftId, mintedGiftId));
          // payment_applications.gift_id is RESTRICT too — clear the ledger
          // rows for this gift first (including the mint row itself).
          await removePaymentApplicationsForGift(tx, mintedGiftId);
          await tx
            .delete(giftsAndPayments)
            .where(eq(giftsAndPayments.id, mintedGiftId));
        } else if (lockedLedger) {
          // This row reconciled to an EXISTING gift — leave the gift in place but
          // undo any final-amount stamp THIS charge applied to it (strict no-op
          // unless the gift is still sourced from this exact charge), then
          // rebalance its allocations to the restored amount.
          const giftId = lockedLedger.giftId;
          // The surviving matched gift loses this Stripe evidence — recompute.
          survivingGiftId = giftId;
          // Drop this charge's ledger row by ANCHOR (leave any parallel QB row
          // for the same gift intact).
          await removePaymentApplicationsForStripeCharge(tx, locked.id);
          const unstamped = await unstampGiftFinalAmount(tx, giftId, {
            source: "stripe",
            stripeChargeId: locked.id,
          });
          if (unstamped.restored) {
            await adjustSingleAllocationOrFlag(
              tx,
              giftId,
              unstamped.oldAmount,
              unstamped.newAmount,
              "stripe",
            );
          }
          // The Nneka case: a QB staged row reconciled to the same gift stays
          // locked to it after this Stripe revert, blocking any re-link with a
          // hard 409. A manual revert should fully undo the match — reset the
          // QB side to pending too.
          cascadedQbStagedIds.push(
            ...(await cascadeResetLinkedQbStagedRows(tx, giftId, {
              unstampGift: true,
            })),
          );
        } else {
          // Approved/reconciled with no gift linkage of its own — nothing to revert.
          throw new Error(NOT_REVERTIBLE);
        }

        // §4.3 supersede: this charge's counted Stripe row is gone — if its
        // payout is confirmed-settled against a coarse QB deposit whose rows
        // were demoted on the strength of that coverage, promote them back to
        // counted in the same tx (the money trail must never go dark).
        supersedeGiftIds.push(
          ...(await applySupersedeForPayoutInTx(tx, locked.stripePayoutId)),
        );

        // A failed charge (raw Stripe status 'failed') never settled — after
        // unlinking it must land in the excluded bucket, not back in the
        // pending queue where it would look like real money again. Likewise a
        // FULLY-refunded charge: once unlinked it is never-booked refunded
        // money → refunded_charge (failed wins when both apply; a dispute is
        // a chargeback, not this — mirrors isFullyRefunded).
        const rawChargeStatus =
          locked.rawCharge && typeof locked.rawCharge === "object"
            ? ((locked.rawCharge as Record<string, unknown>)["status"] ?? null)
            : null;
        const revertExclusion =
          rawChargeStatus === "failed"
            ? ("failed_charge" as const)
            : isFullyRefunded({
                  refunded: locked.refunded === true,
                  disputed: locked.disputed === true,
                  amountRefunded: locked.amountRefunded,
                  grossAmount: locked.grossAmount,
                })
              ? ("refunded_charge" as const)
              : null;

        const [row] = await tx
          .update(stripeStagedCharges)
          .set({
            // Derived: exclusion_reason set → excluded; cleared → pending (the
            // gift link is the counted ledger row, deleted below).
            exclusionReason: revertExclusion,
            autoApplied: false,
            matchStatus: newMatchStatus,
            matchConfirmedAt: null,
            matchConfirmedByUserId: null,
            approvedAt: null,
            approvedByUserId: null,
            // An open refund proposal pointed at the now-unlinked gift is moot —
            // clear it (the next sync re-raises it if the refund still applies to
            // a re-linked gift). An already-applied/dismissed refund is left as a
            // historical record.
            ...(locked.refundPropagationStatus === "proposed"
              ? {
                  refundPropagationStatus: "none" as const,
                  refundPropagationKind: null,
                  refundPropagationGiftId: null,
                  refundProposedAmount: null,
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(stripeStagedCharges.id, id))
          .returning();
        return row ?? null;
      });
    } catch (e) {
      if (e instanceof Error && e.message === NOT_FOUND) {
        return notFound(res, "stripe staged charge");
      }
      if (e instanceof Error && e.message === NOT_REVERTIBLE) {
        res.status(409).json({
          error: "not_revertible",
          message:
            "Only an auto-matched row or a row that minted/reconciled a gift can be reverted.",
        });
        return;
      }
      throw e;
    }
    if (cascadedQbStagedIds.length > 0) {
      req.log.warn(
        { stripeChargeId: id, cascadedQbStagedIds },
        "Stripe revert cascade-reset QuickBooks staged payment(s) to pending",
      );
    }
    void user;
    // The revert IS the undo — re-doing the original action is a fresh
    // decision made from the queue, so no undo pointer.
    await reconAudit(req, {
      action: "update",
      entityType: "stripe_staged_charge",
      entityId: id,
      summary: `Reverted the Stripe charge from ${payerLabel(reverted?.payerName)} (${fmtMoney(reverted?.grossAmount)}) back to the queue`,
      undo: null,
    });
    res.json(reverted);
  }),
);

// ─── POST /stripe-staged-charges/:id/confirm-refund ────────────────────────
// Human-confirm a proposed Stripe refund/chargeback (INV-13): reverse (archive)
// or reduce the linked gift, then re-derive the linked pledge + the gift's QB
// tie status. Guarded so only a `proposed` row applies (409 otherwise).
router.post(
  "/stripe-staged-charges/:id/confirm-refund",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);

    const result = await confirmRefundPropagation(id, user.id);
    switch (result.code) {
      case "not_found":
        return notFound(res, "stripe staged charge");
      case "not_proposed":
        res.status(409).json({
          error: "not_proposed",
          message: "No open refund proposal to confirm on this charge.",
        });
        return;
      case "no_linked_gift":
      case "gift_missing":
        res.status(409).json({
          error: "no_linked_gift",
          message: "The gift this refund targeted is no longer available.",
        });
        return;
      default:
        break;
    }

    // Refund application archives/reduces the linked gift — a money change
    // with no single-call inverse, so no undo pointer.
    const [confirmedCharge] = await db
      .select({
        payerName: stripeStagedCharges.payerName,
        grossAmount: stripeStagedCharges.grossAmount,
      })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, id));
    await reconAudit(req, {
      action: "update",
      entityType: "stripe_staged_charge",
      entityId: id,
      summary: `Applied the refund on the Stripe charge from ${payerLabel(confirmedCharge?.payerName)} (${fmtMoney(confirmedCharge?.grossAmount)}) to its linked gift`,
      undo: null,
    });
    const row = await withJoins(
      db.select(stagedSelect).from(stripeStagedCharges).$dynamic(),
    )
      .where(eq(stripeStagedCharges.id, id))
      .then((r) => r[0]);
    res.json(row ?? { id });
  }),
);

// ─── POST /stripe-staged-charges/:id/dismiss-refund ────────────────────────
// Human-dismiss a proposed refund/chargeback: leave the gift untouched, mark
// the proposal dismissed. The signature is retained so a re-sync won't re-raise
// the same refund (an escalation to a larger refund still re-raises).
router.post(
  "/stripe-staged-charges/:id/dismiss-refund",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);

    const result = await dismissRefundPropagation(id, user.id);
    if (result.code === "not_found") {
      return notFound(res, "stripe staged charge");
    }
    if (result.code === "not_proposed") {
      res.status(409).json({
        error: "not_proposed",
        message: "No open refund proposal to dismiss on this charge.",
      });
      return;
    }

    // Dismissal only marks the proposal — the gift was never touched, and the
    // retained signature intentionally stops a re-raise; no undo.
    const [dismissedCharge] = await db
      .select({
        payerName: stripeStagedCharges.payerName,
        grossAmount: stripeStagedCharges.grossAmount,
      })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, id));
    await reconAudit(req, {
      action: "update",
      entityType: "stripe_staged_charge",
      entityId: id,
      summary: `Dismissed the proposed refund on the Stripe charge from ${payerLabel(dismissedCharge?.payerName)} (${fmtMoney(dismissedCharge?.grossAmount)})`,
      undo: null,
    });
    const row = await withJoins(
      db.select(stagedSelect).from(stripeStagedCharges).$dynamic(),
    )
      .where(eq(stripeStagedCharges.id, id))
      .then((r) => r[0]);
    res.json(row ?? { id });
  }),
);

// ─── POST /stripe/sync ─────────────────────────────────────────────────────
router.post(
  "/stripe/sync",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await syncStripe();
      res.json(summary);
    } catch (e) {
      logger.error({ err: e }, "Stripe manual sync failed");
      res.status(502).json({
        error: "sync_failed",
        message: e instanceof Error ? e.message : "Stripe sync failed",
      });
    }
  }),
);

// ─── POST /stripe/rematch ──────────────────────────────────────────────────
router.post(
  "/stripe/rematch",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await rematchStripeCharges();
      req.log.info(
        { ran: summary.ran, scanned: summary.scanned, matched: summary.matched },
        "Stripe staged-charge rematch run",
      );
      res.json(summary);
    } catch (e) {
      logger.error({ err: e }, "Stripe rematch failed");
      res.status(502).json({
        error: "rematch_failed",
        message: e instanceof Error ? e.message : "Stripe rematch failed",
      });
    }
  }),
);

// ─── POST /stripe/reconciliation/propose-historical ────────────────────────
// One-time admin "stitch": re-run Stripe→QuickBooks payout-match proposals over
// ALL payouts, including prior-account rows the incremental sync never saw (it
// only proposes for payouts pulled in its own run). Proposals only — every match
// stays in a proposed/conflict state for a human to confirm; never mints or
// archives anything. Idempotent: re-running simply re-evaluates.
router.post(
  "/stripe/reconciliation/propose-historical",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const result = await proposePayoutMatches();
      if (!result.ran) {
        res.json({
          ran: false,
          payoutsScanned: 0,
          proposalsCreated: 0,
          conflictsFound: 0,
          alreadyResolved: 0,
          unmatched: 0,
          chargesScanned: 0,
          chargesRematched: 0,
          chargeTiesProposed: 0,
          chargeTiesCleared: 0,
        });
        return;
      }
      // Single-donation payouts have no deposit lump to settle against, so the
      // payout↔deposit pass above intentionally leaves them untied — their money
      // belongs at the charge grain. Run the donor-backfill rematch over ALL
      // still-pending/donor-less charges so those historical charges surface (with
      // a donor hint) in the per-charge review queue where a human ties them to a
      // gift. DONOR-ONLY — never mints or reconciles (proposal-only guarantee).
      const rematch = await rematchStripeCharges();
      // Step 3 — charge-grain QB tie proposals for "individually-booked"
      // payouts (the bookkeeper recorded one QB row per donation, so no
      // deposit lump exists for the payout↔deposit pass to find). Proposals
      // only — a human approves each tie on the Settlement report.
      const chargeTies = await proposeChargeQbTies();
      const [counts] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(stripePayouts);
      const total = counts?.total ?? 0;
      const scanned = result.evaluated;
      const summary = {
        ran: true,
        payoutsScanned: scanned,
        proposalsCreated: result.proposed,
        conflictsFound: result.conflicts,
        // Payouts not scanned are already in a confirmed/reconciled terminal state.
        alreadyResolved: Math.max(0, total - scanned),
        // Scanned payouts that ended with no QB-deposit candidate.
        unmatched: Math.max(0, scanned - result.proposed - result.conflicts),
        // Charge-grain donor backfill (step 2): charges examined and donor-hinted.
        chargesScanned: rematch.scanned,
        chargesRematched: rematch.matched,
        // Charge-grain QB tie proposals (step 3).
        chargeTiesProposed: chargeTies.ran ? chargeTies.proposed : 0,
        chargeTiesCleared: chargeTies.ran ? chargeTies.cleared : 0,
      };
      req.log.info(summary, "Historical Stripe→QB reconciliation proposal pass");
      res.json(summary);
    } catch (e) {
      logger.error(
        { err: e },
        "Historical Stripe reconciliation proposal failed",
      );
      res.status(502).json({
        error: "proposal_failed",
        message:
          e instanceof Error ? e.message : "Historical reconciliation failed",
      });
    }
  }),
);

// ─── GET /stripe/reconciliation/untied-diagnostic ──────────────────────────
// Read-only triage for finance: for every UNTIED positive Stripe payout (no
// settlement link), find the nearest penny-exact QuickBooks row at ANY date and
// report its type ('deposit' vs 'payment'), the date gap, and a suggested match
// grain. Purely diagnostic — surfaces where the money likely sits in QB so a
// human can confirm proposals and chase the genuine orphans. Writes nothing.
interface UntiedDiagnosticRow {
  payout_id: string;
  amount: string | null;
  arrival_date: string | null;
  charge_count: number | null;
  qb_entity_type: string | null;
  qb_id: string | null;
  qb_date_received: string | null;
  date_gap_days: number | null;
}
router.get(
  "/stripe/reconciliation/untied-diagnostic",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const result = await db.execute(sql`
      SELECT
        p.id AS payout_id,
        p.amount::text AS amount,
        to_char(p.arrival_date, 'YYYY-MM-DD') AS arrival_date,
        p.charge_count,
        m.qb_entity_type,
        m.qb_id,
        to_char(m.date_received, 'YYYY-MM-DD') AS qb_date_received,
        m.date_gap_days
      FROM stripe_payouts p
      LEFT JOIN settlement_links sl ON sl.payout_id = p.id
      LEFT JOIN LATERAL (
        SELECT
          sp.qb_entity_type,
          sp.id AS qb_id,
          sp.date_received,
          abs(sp.date_received - p.arrival_date)::int AS date_gap_days
        FROM staged_payments sp
        WHERE sp.exclusion_reason IS NULL
          AND abs(sp.amount - COALESCE(p.amount, p.net_total)) <= 0.01
        ORDER BY
          abs(sp.date_received - p.arrival_date) ASC NULLS LAST,
          (sp.qb_entity_type = 'deposit') DESC
        LIMIT 1
      ) m ON true
      WHERE sl.id IS NULL
        AND COALESCE(p.amount, p.net_total) > 0
      ORDER BY p.arrival_date DESC NULLS LAST
    `);
    const raw = result.rows as unknown as UntiedDiagnosticRow[];
    const rows = raw.map((r) => {
      const hasExactQbRow = r.qb_id != null;
      const singleCharge = (r.charge_count ?? 1) <= 1;
      const suggestedGrain: "deposit-lump" | "charge-payment" | "none" =
        !hasExactQbRow
          ? "none"
          : !singleCharge || r.qb_entity_type === "deposit"
            ? "deposit-lump"
            : "charge-payment";
      return {
        payoutId: r.payout_id,
        amount: r.amount,
        arrivalDate: r.arrival_date,
        chargeCount: r.charge_count,
        hasExactQbRow,
        qbEntityType: r.qb_entity_type,
        qbId: r.qb_id,
        qbDateReceived: r.qb_date_received,
        dateGapDays: r.date_gap_days,
        suggestedGrain,
      };
    });
    res.json({
      total: rows.length,
      withExactQbRow: rows.filter((r) => r.hasExactQbRow).length,
      deposits: rows.filter((r) => r.suggestedGrain === "deposit-lump").length,
      payments: rows.filter((r) => r.suggestedGrain === "charge-payment").length,
      orphans: rows.filter((r) => r.suggestedGrain === "none").length,
      rows,
    });
  }),
);

// ─── POST /stripe/resync-full ──────────────────────────────────────────────
// Admin-gated NON-destructive full re-pull. Lifts the per-account watermark
// floor to re-walk the entire payout back-catalogue (e.g. historical 2019–2021
// payouts the ongoing sync never pulled because its first run seeds the
// watermark to "now") and backfill the missing payout + charge records. Review
// state is preserved (the upsert refreshes only read-only Stripe facts). Runs in
// the background — the browser/proxy would time out long before a multi-minute
// re-walk finishes; the UI polls GET /stripe/resync-status.
router.post(
  "/stripe/resync-full",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const state = startStripeFullResync();
    req.log.info(
      { status: state.status },
      "Stripe full re-pull (background) requested",
    );
    res.json(state);
  }),
);

// ─── GET /stripe/resync-status ─────────────────────────────────────────────
// Admin-gated progress for the background full re-pull started above.
router.get(
  "/stripe/resync-status",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(getStripeFullResyncState());
  }),
);

// ─── GET /stripe/sync-status ───────────────────────────────────────────────
router.get(
  "/stripe/sync-status",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = await db.select().from(stripeSyncState);
    const state = rows[0] ?? null;
    res.json({
      configured: rows.length > 0,
      lastRunAt: state?.lastRunAt ?? null,
      lastRunStatus: state?.lastRunStatus ?? null,
      lastError: state?.lastError ?? null,
      consecutiveErrors: state?.consecutiveErrors ?? 0,
      payoutCreatedWatermark: state?.payoutCreatedWatermark ?? null,
    });
  }),
);

// ─── Stripe payout ↔ QuickBooks reconciliation queue ───────────────────────
// The proposal pass (stripeReconcile.ts) classifies each payout against the QB
// deposit lumps; humans confirm/revert here (stripeConfirm.ts). This queue lists
// payouts that need or have had a reconciliation decision. Under D4 a confirm
// stamps the gift's final amount and marks its QB/Stripe evidence `reconciled`
// (permanent — never archived or excluded); nothing changes until a human
// confirms — propose-then-confirm. The legacy confirmed_excluded/keep/replace
// statuses survive only to revert rows confirmed under the pre-D4 model.

type ReconQueue = "unmatched" | "proposed" | "conflict" | "confirmed" | "all";
const RECON_QUEUES = [
  "unmatched",
  "proposed",
  "conflict",
  "confirmed",
  "all",
] as const;
// Read-flip: recon queue buckets derive from the AUTHORITATIVE settlement link
// (leftJoined on the payout), not the legacy enum:
//   unmatched → no link · proposed → proposed link, no conflict gift ·
//   conflict → proposed link WITH a conflict gift · confirmed → confirmed link ·
//   all → any link. Every caller must leftJoin settlementLinks on payoutId.
function reconQueueWhere(queue: ReconQueue) {
  switch (queue) {
    case "unmatched":
      // Stray Stripe: a payout with no settlement link (found no QuickBooks
      // deposit candidate). These never appear in the active queues above.
      return isNull(settlementLinks.id);
    case "proposed":
      return and(
        eq(settlementLinks.lifecycle, "proposed"),
        isNull(settlementLinks.conflictGiftId),
      );
    case "conflict":
      return and(
        eq(settlementLinks.lifecycle, "proposed"),
        isNotNull(settlementLinks.conflictGiftId),
      );
    case "confirmed":
      return eq(settlementLinks.lifecycle, "confirmed");
    case "all":
      return isNotNull(settlementLinks.id);
  }
}

// The QB deposit currently relevant to the payout's state (matched once
// confirmed, else the proposed/conflicting candidate), and the already-approved
// gift a conflict would replace, joined read-only for display.
const activeDeposit = alias(stagedPayments, "active_deposit");
const conflictGift = alias(giftsAndPayments, "conflict_gift");
const conflictOrg = alias(organizations, "conflict_org");
const conflictHousehold = alias(households, "conflict_household");
const conflictPerson = alias(people, "conflict_person");

// The authoritative settlement state lives in settlement_links and is exposed
// via settlementLifecycle + the derived reconciliationLanes.
const payoutResponseColumns = getTableColumns(stripePayouts);

const reconSelect = {
  ...payoutResponseColumns,
  settlementLifecycle: settlementLinks.lifecycle,
  depositId: activeDeposit.id,
  depositAmount: activeDeposit.amount,
  depositDateReceived: activeDeposit.dateReceived,
  depositPayerName: activeDeposit.payerName,
  // Derived status for the ALIASED deposit row. The shared base-table
  // fragment can't be interpolated here (drizzle renders alias columns
  // unqualified inside sql``), so the SAME derivation comes from the
  // single-source alias-parameterized builder.
  depositStatus: sql<string>`${sql.raw(qbStatusCaseText("active_deposit"))}`.as(
    "deposit_status",
  ),
  conflictGiftAmount: conflictGift.amount,
  conflictGiftDate: conflictGift.dateReceived,
  conflictGiftArchivedAt: conflictGift.archivedAt,
  conflictGiftDonorName: sql<string | null>`
    COALESCE(
      ${conflictOrg.name},
      ${conflictHousehold.name},
      ${personDisplayNameSql(conflictPerson)}
    )
  `.as("conflict_gift_donor_name"),
};

// ─── GET /stripe-payouts/reconciliation ────────────────────────────────────
router.get(
  "/stripe-payouts/reconciliation",
  asyncHandler(async (req, res) => {
    const raw =
      typeof req.query["queue"] === "string" ? req.query["queue"] : "";
    const queue: ReconQueue = (RECON_QUEUES as readonly string[]).includes(raw)
      ? (raw as ReconQueue)
      : "proposed";
    const { limit, offset, page } = parsePagination(req.query);
    const where = reconQueueWhere(queue);

    const [rows, totalRow] = await Promise.all([
      db
        .select(reconSelect)
        .from(stripePayouts)
        .leftJoin(settlementLinks, eq(settlementLinks.payoutId, stripePayouts.id))
        .leftJoin(
          activeDeposit,
          eq(activeDeposit.id, settlementLinks.depositStagedPaymentId),
        )
        .leftJoin(conflictGift, eq(conflictGift.id, settlementLinks.conflictGiftId))
        .leftJoin(conflictOrg, eq(conflictOrg.id, conflictGift.organizationId))
        .leftJoin(
          conflictHousehold,
          eq(conflictHousehold.id, conflictGift.householdId),
        )
        .leftJoin(
          conflictPerson,
          eq(conflictPerson.id, conflictGift.individualGiverPersonId),
        )
        .where(where)
        .orderBy(desc(stripePayouts.arrivalDate), desc(stripePayouts.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(stripePayouts)
        .leftJoin(settlementLinks, eq(settlementLinks.payoutId, stripePayouts.id))
        .where(where)
        .then((r) => r[0]),
    ]);

    res.json({
      data: rows.map((row) => ({
        ...row,
        reconciliationLanes: derivePayoutLanes(
          row.settlementLifecycle ? { lifecycle: row.settlementLifecycle } : null,
        ),
      })),
      pagination: { page, limit, total: totalRow?.value ?? 0 },
    });
  }),
);

// Map a stripeConfirm discriminated result onto an HTTP response. not_found →
// 404; every other typed transition failure (stale state, charges booked) → 409.
// On success, first recompute the QB tie status of every gift whose ledger rows
// the §4.3 settlement-supersede recompute demoted/promoted inside the
// transition (post-commit, own connection — mirrors the other route tails).
async function respondReconResult(
  res: Response,
  result: ConfirmRevertResult,
): Promise<void> {
  if (result.ok) {
    res.json(result);
    return;
  }
  res
    .status(result.code === "not_found" ? 404 : 409)
    .json({ error: result.code, message: result.message });
}

// ─── POST /stripe-payouts/:id/confirm-exclude ──────────────────────────────
// proposed → confirmed_reconciled (D4): mark the pending QB deposit lump
// `reconciled` — permanent evidence, no longer excluded (processor_payout) or
// archived — and link it to this payout. (Route path is kept for client
// compatibility; the deposit is reconciled, not excluded.)
router.post(
  "/stripe-payouts/:id/confirm-exclude",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    await respondReconResult(
      res,
      await confirmPendingQbDeposit({ payoutId: paramId(req), userId: user.id }),
    );
  }),
);

// ─── POST /stripe-payouts/:id/confirm-keep ─────────────────────────────────
// conflict_approved → confirmed_reconciled (D4): the existing approved QB gift
// stands; we only record the payout linkage. Touches no gift or deposit.
router.post(
  "/stripe-payouts/:id/confirm-keep",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    await respondReconResult(
      res,
      await confirmKeepApprovedQbGift({ payoutId: paramId(req), userId: user.id }),
    );
  }),
);

// ─── POST /stripe-payouts/:id/confirm-replace ──────────────────────────────
// Retired under D4: the coarse QB-derived gift is never archived/replaced — a
// genuine coarse-vs-granular conflict returns manual_review_required (409).
// Route kept for client compatibility and to revert rows confirmed
// (confirmed_replace) under the pre-D4 model.
router.post(
  "/stripe-payouts/:id/confirm-replace",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    await respondReconResult(
      res,
      await confirmReplaceApprovedQbGift({
        payoutId: paramId(req),
        userId: user.id,
      }),
    );
  }),
);

// ─── POST /stripe-payouts/:id/revert-reconciliation ────────────────────────
// Undo a confirm back to its prior proposal state. A confirmed_replace revert is
// refused (409 charges_already_booked) once any of the payout's Stripe charges
// have been booked into a gift.
router.post(
  "/stripe-payouts/:id/revert-reconciliation",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    await respondReconResult(
      res,
      await revertPayoutQbConfirmation({
        payoutId: paramId(req),
        userId: user.id,
      }),
    );
  }),
);

export default router;
