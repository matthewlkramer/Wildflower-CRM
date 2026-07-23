import { Router, type IRouter } from "express";
import { requireFinance } from "../../lib/financeGuard";
import { db } from "@workspace/db";
import {
  reconciliationBundleDrafts,
  stripeStagedCharges,
  stagedPayments,
  stripePayouts,
  giftsAndPayments,
  paymentApplications,
} from "@workspace/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { asyncHandler, notFound, parseOrBadRequest, newId } from "../../lib/helpers";
import { getAppUser } from "../../lib/appRequest";
import { getViewer } from "../../lib/identityVisibility";
import {
  AssembleReconciliationBundleBody,
  GetReconciliationBundleParams,
  DeriveReconciliationBundleParams,
  DeriveReconciliationBundleBody,
  ConfirmReconciliationBundleParams,
  ConfirmReconciliationBundleBody,
  ConfirmSettlementLinkParams,
  ConfirmSettlementLinkBody,
} from "@workspace/api-zod";
import {
  assembleBundleProposal,
  mergeOverrides,
  type StoredBundleOverrides,
  type BundleOverridesInput,
  type DerivedBundle,
  type DonorRecordKind,
  type BundleAnchorType,
} from "../../lib/reconciliationBundleProposal";
import {
  ReconcileAbort,
  mintGiftInTx,
  linkGiftInTx,
  type Tx,
  type DonorXor,
} from "../../lib/reconciliationCommit";
import {
  createGiftFromChargeInTx,
  linkChargeToGiftInTx,
  createDonorRecordInTx,
  excludeChargeInTx,
  excludeStagedInTx,
} from "../../lib/reconciliationBundleCommit";
import { isSettlementLump } from "../../lib/settlementLump";
import {
  stagedStatusWhere,
  deriveStagedPaymentStatus,
} from "../../lib/derivedStatus";
import { donorOf, donorsMatch, type LinkDonor } from "../../lib/quickbooksLink";
import { applyDerivedOppFieldsMany } from "../../lib/pledgeStage";
import { applySettlementSupersedeMany } from "../../lib/settlementSupersede";

/**
 * Reactive "settlement bundle" reconciliation endpoints.
 *
 * A bundle is the COMPLETE proposed end-state for one settlement ANCHOR (a
 * Stripe payout and/or a QuickBooks deposit + all its charges), persisted as a
 * draft. The server is authoritative: the full proposal is always RE-DERIVED
 * from live CRM + processor state with the draft's stored human overrides
 * applied on top — overrides are never clobbered.
 *
 *   POST   /reconciliation/bundle-proposals            assemble (or load) by anchor
 *   GET    /reconciliation/bundle-proposals/:draftId   load + re-derive by id
 *   POST   /reconciliation/bundle-proposals/:draftId/derive   apply edits, re-derive
 *   POST   /reconciliation/bundle-proposals/:draftId/confirm  ATOMIC commit
 *
 * Confirm commits the whole bundle in ONE transaction via the SAME money-write
 * primitives used by the manual approve / reconcile paths (no parallel money
 * path), then runs the post-commit appliers (opportunity re-derive + gift↔QB
 * tie recompute). It is idempotent by (draftId, revision): a double-submit at
 * the committed revision replays the stored result instead of re-booking.
 */
const router: IRouter = Router();

type ConfirmRowOutcome =
  | "matched_gift"
  | "minted_gift"
  | "researched"
  | "excluded"
  | "skipped";

interface ConfirmResult {
  ok: true;
  draftId: string;
  revision: number;
  tieConfirmed: boolean;
  rows: Array<{
    rowKey: string;
    outcome: ConfirmRowOutcome;
    giftId?: string | null;
    createdDonorId?: string | null;
  }>;
  giftsCreated: number;
  giftsMatched: number;
  donorsCreated: number;
  alreadyConfirmed?: boolean;
}

/** Shape the API ReconciliationBundleProposal response from a draft + derived proposal. */
function toProposalResponse(
  draft: typeof reconciliationBundleDrafts.$inferSelect,
  proposal: DerivedBundle,
  stale: boolean,
) {
  return {
    draftId: draft.id,
    anchorType: proposal.anchorType,
    anchorId: proposal.anchorId,
    status: draft.status,
    revision: draft.revision,
    sourceFingerprint: proposal.sourceFingerprint,
    stale,
    tie: proposal.tie,
    rows: proposal.rows,
    summary: proposal.summary,
    generatedAt: new Date().toISOString(),
  };
}

function donorXorFor(kind: DonorRecordKind, id: string): DonorXor {
  return {
    organizationId: kind === "organization" ? id : null,
    individualGiverPersonId: kind === "person" ? id : null,
    householdId: kind === "household" ? id : null,
  };
}

function createdDonorIdOf(d: DonorXor): string | null {
  return d.organizationId ?? d.individualGiverPersonId ?? d.householdId;
}

function lockCharge(tx: Tx, id: string) {
  return tx
    .select()
    .from(stripeStagedCharges)
    .where(eq(stripeStagedCharges.id, id))
    .for("update")
    .then((r) => r[0]);
}

function lockStaged(tx: Tx, id: string) {
  return tx
    .select()
    .from(stagedPayments)
    .where(eq(stagedPayments.id, id))
    .for("update")
    .then((r) => r[0]);
}

function lockGift(tx: Tx, id: string) {
  return tx
    .select()
    .from(giftsAndPayments)
    .where(eq(giftsAndPayments.id, id))
    .for("update")
    .then((r) => r[0]);
}

/**
 * Canonicalize a settlement anchor. A QuickBooks staged payment that a Stripe
 * payout references (matched / proposed / conflict) reconciles THROUGH the
 * payout's bundle — the payout is the per-charge GROSS source of truth — never
 * as standalone QB money. Rewriting the tied QB id to its payout keeps ONE
 * canonical draft per unit of money; assembling, deriving, or confirming the QB
 * id directly would double-book. Checks all THREE tie fields so a conflict tie
 * can't slip through. Applied at EVERY draft entry point (assemble/derive/
 * confirm), not just first assemble, so a draft created standalone BEFORE a tie
 * was added can't later be booked as pure-QB money.
 */
async function canonicalizeAnchor(
  conn: typeof db | Tx,
  anchorType: BundleAnchorType,
  anchorId: string,
): Promise<{ anchorType: BundleAnchorType; anchorId: string }> {
  if (anchorType !== "qb_staged_payment") return { anchorType, anchorId };
  // Authoritative source of the payout↔deposit tie is the pairing fact on the
  // QBO row (staged_payments.settled_stripe_payout_id).
  const tied = await conn
    .select({ id: stripePayouts.id })
    .from(stagedPayments)
    .innerJoin(
      stripePayouts,
      eq(stripePayouts.id, stagedPayments.settledStripePayoutId),
    )
    .where(eq(stagedPayments.id, anchorId))
    .then((r) => r[0]);
  return tied
    ? { anchorType: "stripe_payout" as const, anchorId: tied.id }
    : { anchorType, anchorId };
}

// ─── POST /reconciliation/bundle-proposals — assemble (or load) by anchor ───
router.post(
  "/reconciliation/bundle-proposals",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const body = parseOrBadRequest(AssembleReconciliationBundleBody, req.body, res);
    if (!body) return;
    const viewer = getViewer(req);

    // Canonicalize a tied QB anchor to its Stripe payout BEFORE any draft lookup
    // or create (see canonicalizeAnchor). Assembling the tied QB id directly
    // would mint a duplicate draft for the same money and risk a double-book.
    const { anchorType, anchorId } = await canonicalizeAnchor(
      db,
      body.anchorType,
      body.anchorId,
    );

    const existing = await db
      .select()
      .from(reconciliationBundleDrafts)
      .where(
        and(
          eq(reconciliationBundleDrafts.anchorType, anchorType),
          eq(reconciliationBundleDrafts.anchorId, anchorId),
        ),
      )
      .then((r) => r[0]);

    const overrides = (existing?.overrides ?? {}) as StoredBundleOverrides;
    const assembled = await assembleBundleProposal({
      anchorType,
      anchorId,
      overrides,
      viewer,
    });
    if (!assembled) {
      notFound(res, "settlement anchor");
      return;
    }
    const { proposal } = assembled;

    let draft: typeof reconciliationBundleDrafts.$inferSelect;
    if (!existing) {
      const inserted = await db
        .insert(reconciliationBundleDrafts)
        .values({
          id: newId(),
          anchorType,
          anchorId,
          overrides,
          derivedProposal: proposal,
          sourceFingerprint: proposal.sourceFingerprint,
        })
        .returning();
      draft = inserted[0]!;
    } else {
      // Refresh the cached snapshot + fingerprint; overrides / revision / status
      // are left untouched (assemble never edits or re-opens a draft).
      const updated = await db
        .update(reconciliationBundleDrafts)
        .set({
          derivedProposal: proposal,
          sourceFingerprint: proposal.sourceFingerprint,
          updatedAt: new Date(),
        })
        .where(eq(reconciliationBundleDrafts.id, existing.id))
        .returning();
      draft = updated[0]!;
    }

    res.json(toProposalResponse(draft, proposal, false));
  }),
);

// ─── GET /reconciliation/bundle-proposals/:draftId — load + re-derive ───────
router.get(
  "/reconciliation/bundle-proposals/:draftId",
  asyncHandler(async (req, res) => {
    const params = parseOrBadRequest(
      GetReconciliationBundleParams,
      req.params,
      res,
    );
    if (!params) return;
    const viewer = getViewer(req);

    const draft = await db
      .select()
      .from(reconciliationBundleDrafts)
      .where(eq(reconciliationBundleDrafts.id, params.draftId))
      .then((r) => r[0]);
    if (!draft) {
      notFound(res, "bundle draft");
      return;
    }

    const overrides = (draft.overrides ?? {}) as StoredBundleOverrides;
    const assembled = await assembleBundleProposal({
      anchorType: draft.anchorType,
      anchorId: draft.anchorId,
      overrides,
      viewer,
    });
    if (!assembled) {
      notFound(res, "settlement anchor");
      return;
    }
    const { proposal } = assembled;
    const stale =
      draft.sourceFingerprint != null &&
      proposal.sourceFingerprint !== draft.sourceFingerprint;

    res.json(toProposalResponse(draft, proposal, stale));
  }),
);

// ─── POST /reconciliation/bundle-proposals/:draftId/derive — edit + re-derive ─
router.post(
  "/reconciliation/bundle-proposals/:draftId/derive",
  asyncHandler(async (req, res) => {
    const params = parseOrBadRequest(
      DeriveReconciliationBundleParams,
      req.params,
      res,
    );
    if (!params) return;
    const body = parseOrBadRequest(
      DeriveReconciliationBundleBody,
      req.body,
      res,
    );
    if (!body) return;
    const viewer = getViewer(req);

    const draft = await db
      .select()
      .from(reconciliationBundleDrafts)
      .where(eq(reconciliationBundleDrafts.id, params.draftId))
      .then((r) => r[0]);
    if (!draft) {
      notFound(res, "bundle draft");
      return;
    }
    if (draft.status !== "open") {
      res.status(409).json({
        error: "not_open",
        message: "This bundle is already confirmed; no further edits.",
      });
      return;
    }

    // Money-safety: refuse a standalone QB draft whose deposit a Stripe payout
    // now claims — it must be reconciled THROUGH the payout bundle, not edited
    // toward a pure-QB confirm. Re-assembling against the payout reaches its
    // canonical draft.
    const canonical = await canonicalizeAnchor(
      db,
      draft.anchorType,
      draft.anchorId,
    );
    if (
      canonical.anchorType !== draft.anchorType ||
      canonical.anchorId !== draft.anchorId
    ) {
      res.status(409).json({
        error: "anchor_superseded",
        message:
          "A Stripe payout now claims this deposit; reconcile it through the payout bundle.",
      });
      return;
    }

    const merged = mergeOverrides(
      (draft.overrides ?? {}) as StoredBundleOverrides,
      body as BundleOverridesInput,
    );
    const assembled = await assembleBundleProposal({
      anchorType: draft.anchorType,
      anchorId: draft.anchorId,
      overrides: merged,
      viewer,
    });
    if (!assembled) {
      notFound(res, "settlement anchor");
      return;
    }
    const { proposal } = assembled;

    // Optimistic concurrency: bump revision only if no other derive raced us.
    const updated = await db
      .update(reconciliationBundleDrafts)
      .set({
        overrides: merged,
        derivedProposal: proposal,
        sourceFingerprint: proposal.sourceFingerprint,
        revision: draft.revision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(reconciliationBundleDrafts.id, draft.id),
          eq(reconciliationBundleDrafts.revision, draft.revision),
        ),
      )
      .returning();
    if (updated.length === 0) {
      res.status(409).json({
        error: "revision_conflict",
        message: "This bundle changed while you were editing. Reload and retry.",
      });
      return;
    }

    res.json(toProposalResponse(updated[0]!, proposal, false));
  }),
);

// ─── POST /reconciliation/bundle-proposals/:draftId/confirm — ATOMIC commit ──
router.post(
  "/reconciliation/bundle-proposals/:draftId/confirm",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = parseOrBadRequest(
      ConfirmReconciliationBundleParams,
      req.params,
      res,
    );
    if (!params) return;
    const body = parseOrBadRequest(
      ConfirmReconciliationBundleBody,
      req.body,
      res,
    );
    if (!body) return;

    const viewer = getViewer(req);
    const userId = user.id;
    const expectedRevision = body.expectedRevision ?? null;
    const allowWarnings = body.allowWarnings ?? false;

    // Ids to re-derive / recompute AFTER the single commit (post-commit appliers
    // run outside the transaction, mirroring the manual reconcile primitives).
    const pledgeRederiveIds: Array<string | null> = [];
    const giftTieIds: string[] = [];

    let committed: ConfirmResult | null = null;
    try {
      committed = await db.transaction(async (tx) => {
        const draft = await tx
          .select()
          .from(reconciliationBundleDrafts)
          .where(eq(reconciliationBundleDrafts.id, params.draftId))
          .for("update")
          .then((r) => r[0]);
        if (!draft) {
          throw new ReconcileAbort(404, {
            error: "not_found",
            message: "Bundle draft not found.",
          });
        }

        // Idempotent replay: a double-submit at the committed revision returns
        // the stored result instead of re-booking the money.
        if (draft.status === "confirmed") {
          if (expectedRevision == null || expectedRevision === draft.revision) {
            const prior = (draft.confirmResult ?? null) as ConfirmResult | null;
            if (prior) return { ...prior, alreadyConfirmed: true };
            throw new ReconcileAbort(409, {
              error: "already_confirmed",
              message: "This bundle was already confirmed.",
            });
          }
          throw new ReconcileAbort(409, {
            error: "revision_mismatch",
            message:
              "This bundle was already confirmed at a different revision.",
            revision: draft.revision,
          });
        }
        if (draft.status === "superseded") {
          throw new ReconcileAbort(409, {
            error: "superseded",
            message:
              "This bundle was superseded by a source change. Reload and retry.",
          });
        }
        if (expectedRevision != null && expectedRevision !== draft.revision) {
          throw new ReconcileAbort(409, {
            error: "revision_mismatch",
            message:
              "This bundle changed since you loaded it. Re-derive and retry.",
            revision: draft.revision,
          });
        }

        // Money-safety: a standalone QB draft created BEFORE a Stripe payout tie
        // was added must NOT confirm as pure-QB money — the payout is now the
        // canonical anchor for that money. Refuse so the client re-assembles
        // against the payout bundle (under the draft lock, so the check is
        // consistent with the commit that follows).
        const canonical = await canonicalizeAnchor(
          tx,
          draft.anchorType,
          draft.anchorId,
        );
        if (
          canonical.anchorType !== draft.anchorType ||
          canonical.anchorId !== draft.anchorId
        ) {
          throw new ReconcileAbort(409, {
            error: "anchor_superseded",
            message:
              "A Stripe payout now claims this deposit; reconcile it through the payout bundle.",
          });
        }

        // Re-derive the whole bundle from current DB (under the draft lock).
        const overrides = (draft.overrides ?? {}) as StoredBundleOverrides;
        const assembled = await assembleBundleProposal({
          anchorType: draft.anchorType,
          anchorId: draft.anchorId,
          overrides,
          viewer,
          conn: tx,
        });
        if (!assembled) {
          throw new ReconcileAbort(404, {
            error: "anchor_gone",
            message: "The settlement anchor no longer exists.",
          });
        }
        const { proposal, commit } = assembled;

        // Drift guard: refuse if the underlying money changed since last derive.
        if (
          draft.sourceFingerprint != null &&
          proposal.sourceFingerprint !== draft.sourceFingerprint
        ) {
          throw new ReconcileAbort(409, {
            error: "stale",
            message:
              "The underlying money changed since this bundle was derived. Re-derive and retry.",
          });
        }
        // Consistency gates.
        if (proposal.summary.blockerCount > 0) {
          throw new ReconcileAbort(409, {
            error: "blockers",
            message: "Resolve the blocking warnings before confirming.",
          });
        }
        if (!proposal.summary.ready) {
          throw new ReconcileAbort(409, {
            error: "not_ready",
            message:
              "Some rows still need a donor or gift decision before confirming.",
          });
        }
        if (proposal.summary.warningCount > 0 && !allowWarnings) {
          throw new ReconcileAbort(409, {
            error: "warnings",
            message:
              "This bundle has warnings. Confirm with allowWarnings to proceed.",
          });
        }

        // ── TIE FIRST: stamp the payout↔deposit pairing fact (fill-only —
        // never repoints an existing pairing; a payout backs at most one QBO
        // lump via the partial unique index). §4.3 supersede then demotes the
        // deposit's coarse counted QB rows so SUM readers never double-count.
        let tieConfirmed = false;
        const tie = proposal.tie;
        if (
          tie &&
          tie.action === "confirm_tie" &&
          tie.payoutId &&
          tie.depositStagedPaymentId
        ) {
          const paired = await tx
            .update(stagedPayments)
            .set({
              settledStripePayoutId: tie.payoutId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(stagedPayments.id, tie.depositStagedPaymentId),
                isNull(stagedPayments.settledStripePayoutId),
                sql`NOT EXISTS (
                  SELECT 1 FROM staged_payments t
                  WHERE t.settled_stripe_payout_id = ${tie.payoutId}
                )`,
              ),
            )
            .returning({ id: stagedPayments.id });
          if (paired.length > 0) {
            giftTieIds.push(
              ...(await applySettlementSupersedeMany(tx, [
                tie.depositStagedPaymentId,
              ])),
            );
            tieConfirmed = true;
          }
        }

        // ── COMMIT ROWS via the shared money-write primitives. ──
        const resultRows: ConfirmResult["rows"] = [];
        let giftsCreated = 0;
        let giftsMatched = 0;
        let donorsCreated = 0;

        for (const row of commit) {
          // Already booked elsewhere — confirm skips it (no double-book).
          if (row.alreadyCommitted) {
            resultRows.push({
              rowKey: row.rowKey,
              outcome: "skipped",
              giftId: row.gift.giftId ?? null,
            });
            continue;
          }

          const gk = row.gift.kind;

          if (gk === "research") {
            resultRows.push({ rowKey: row.rowKey, outcome: "researched" });
            continue;
          }

          if (gk === "exclude") {
            const reason = row.gift.exclusionReason ?? "other";
            if (row.stripeChargeId) {
              await excludeChargeInTx(tx, {
                chargeId: row.stripeChargeId,
                exclusionReason: reason,
                userId,
              });
            } else if (row.stagedPaymentId) {
              await excludeStagedInTx(tx, {
                stagedPaymentId: row.stagedPaymentId,
                exclusionReason: reason,
                userId,
              });
            }
            resultRows.push({ rowKey: row.rowKey, outcome: "excluded" });
            continue;
          }

          if (gk === "mint") {
            let donorXor: DonorXor;
            let createdDonorId: string | null = null;
            const dp = row.donor;
            if (dp.kind === "new" && dp.newDonor) {
              donorXor = await createDonorRecordInTx(tx, {
                draft: dp.newDonor,
                userId,
              });
              createdDonorId = createdDonorIdOf(donorXor);
              donorsCreated++;
            } else if (dp.kind === "existing" && dp.donorId && dp.donorKind) {
              donorXor = donorXorFor(dp.donorKind, dp.donorId);
            } else {
              throw new ReconcileAbort(409, {
                error: "donor_required",
                message: `Row ${row.rowKey} needs a donor before it can be confirmed.`,
              });
            }

            const newGiftId = newId();
            if (row.stripeChargeId) {
              const charge = await lockCharge(tx, row.stripeChargeId);
              if (!charge) {
                throw new ReconcileAbort(409, {
                  error: "charge_gone",
                  message: `Stripe charge for row ${row.rowKey} no longer exists.`,
                });
              }
              const chargeMintRes = await createGiftFromChargeInTx(tx, {
                newGiftId,
                charge,
                donor: donorXor,
                paymentIntermediaryId: dp.paymentIntermediaryId ?? null,
                userId,
                auditReq: req,
              });
              giftTieIds.push(...chargeMintRes.supersedeGiftIds);
            } else if (row.stagedPaymentId) {
              const staged = await lockStaged(tx, row.stagedPaymentId);
              if (!staged) {
                throw new ReconcileAbort(409, {
                  error: "staged_gone",
                  message: `Staged payment for row ${row.rowKey} no longer exists.`,
                });
              }
              const mintRes = await mintGiftInTx(tx, {
                newGiftId,
                staged,
                stagedPaymentId: row.stagedPaymentId,
                donor: donorXor,
                charge: null,
                opp: null,
                opportunityId: null,
                evidenceAmount: row.gift.mintDraft?.amount ?? row.amount,
                paymentIntermediaryId: dp.paymentIntermediaryId ?? null,
                convert: false,
                outcome: "bundle_mint",
                userId,
                auditReq: req,
              });
              pledgeRederiveIds.push(mintRes.opportunityIdToRederive);
              giftTieIds.push(...mintRes.rederiveGiftIds);
            } else {
              throw new ReconcileAbort(409, {
                error: "no_source",
                message: `Row ${row.rowKey} has no source to mint from.`,
              });
            }
            giftsCreated++;
            giftTieIds.push(newGiftId);
            resultRows.push({
              rowKey: row.rowKey,
              outcome: "minted_gift",
              giftId: newGiftId,
              createdDonorId,
            });
            continue;
          }

          // gk === "match": link an existing gift (Stripe GROSS wins for charges).
          const giftId = row.gift.giftId;
          if (!giftId) {
            throw new ReconcileAbort(409, {
              error: "gift_required",
              message: `Row ${row.rowKey} is set to match but has no gift selected.`,
            });
          }
          const gift = await lockGift(tx, giftId);
          if (!gift) {
            throw new ReconcileAbort(409, {
              error: "gift_gone",
              message: `Gift ${giftId} for row ${row.rowKey} no longer exists.`,
            });
          }

          const giftDonor = donorOf(gift);
          let effectiveGiftDonor: LinkDonor = giftDonor;
          let donorSwitching = false;
          let createdDonorId: string | null = null;
          const dp = row.donor;
          if (dp.kind === "new" && dp.newDonor) {
            const created = await createDonorRecordInTx(tx, {
              draft: dp.newDonor,
              userId,
            });
            effectiveGiftDonor = created;
            donorSwitching = true;
            createdDonorId = createdDonorIdOf(created);
            donorsCreated++;
          } else if (dp.kind === "existing" && dp.donorId && dp.donorKind) {
            const chosen = donorXorFor(dp.donorKind, dp.donorId);
            if (!donorsMatch(giftDonor, chosen)) {
              effectiveGiftDonor = chosen;
              donorSwitching = true;
            }
          }

          if (row.stripeChargeId) {
            const charge = await lockCharge(tx, row.stripeChargeId);
            if (!charge) {
              throw new ReconcileAbort(409, {
                error: "charge_gone",
                message: `Stripe charge for row ${row.rowKey} no longer exists.`,
              });
            }
            const linkRes = await linkChargeToGiftInTx(tx, {
              charge,
              gift,
              giftId,
              effectiveGiftDonor,
              donorSwitching,
              userId,
              auditReq: req,
            });
            pledgeRederiveIds.push(...linkRes.rederivePledgeIds);
            giftTieIds.push(...linkRes.supersedeGiftIds);
          } else if (row.stagedPaymentId) {
            const staged = await lockStaged(tx, row.stagedPaymentId);
            if (!staged) {
              throw new ReconcileAbort(409, {
                error: "staged_gone",
                message: `Staged payment for row ${row.rowKey} no longer exists.`,
              });
            }
            const linkRes = await linkGiftInTx(tx, {
              staged,
              stagedPaymentId: row.stagedPaymentId,
              gift,
              giftId,
              opp: null,
              charge: null,
              evidenceAmount: row.amount,
              effectiveGiftDonor,
              donorSwitching,
              userId,
              auditReq: req,
            });
            pledgeRederiveIds.push(...linkRes.rederivePledgeIds);
            giftTieIds.push(...linkRes.rederiveGiftIds);
          } else {
            throw new ReconcileAbort(409, {
              error: "no_source",
              message: `Row ${row.rowKey} has no source to match.`,
            });
          }
          giftsMatched++;
          giftTieIds.push(giftId);
          resultRows.push({
            rowKey: row.rowKey,
            outcome: "matched_gift",
            giftId,
            createdDonorId,
          });
        }

        const result: ConfirmResult = {
          ok: true,
          draftId: draft.id,
          revision: draft.revision,
          tieConfirmed,
          rows: resultRows,
          giftsCreated,
          giftsMatched,
          donorsCreated,
        };

        await tx
          .update(reconciliationBundleDrafts)
          .set({
            status: "confirmed",
            confirmedByUserId: userId,
            confirmedAt: new Date(),
            confirmResult: result,
            derivedProposal: proposal,
            updatedAt: new Date(),
          })
          .where(eq(reconciliationBundleDrafts.id, draft.id));

        return result;
      });
    } catch (e) {
      if (e instanceof ReconcileAbort) {
        res.status(e.httpStatus).json(e.payload);
        return;
      }
      throw e;
    }

    if (!committed) return;

    // Post-commit appliers (skipped on an idempotent replay — nothing booked).
    if (!committed.alreadyConfirmed) {
      await applyDerivedOppFieldsMany(...pledgeRederiveIds);
    }

    res.json(committed);
  }),
);

// ─── POST /reconciliation/settlement-links/:payoutId/confirm ─────────────────
// Record the Plane-1 payout↔deposit pairing FACT (docs/reconciliation-design.md
// §4.3/§4.4) — decoupled from the Plane-2 per-charge → gift booking the Gift
// report owns. The proposed/confirmed lifecycle is retired: the deterministic
// accounting recompute pairs most payouts automatically; this route is the
// human escape hatch for the ambiguous remainder. The write is FILL-ONLY —
// it never repoints an existing pairing (revert = fix in QuickBooks; the
// accounting sidecar surfaces mismatches as correction_needed).
//
// Money-safety: after pairing, §4.3 supersede demotes the deposit's coarse
// counted QB rows so the lump can never also credit donors on top of the
// individual per-charge Stripe gifts.
router.post(
  "/reconciliation/settlement-links/:payoutId/confirm",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = parseOrBadRequest(
      ConfirmSettlementLinkParams,
      req.params,
      res,
    );
    if (!params) return;
    const body = parseOrBadRequest(ConfirmSettlementLinkBody, req.body, res);
    if (!body) return;

    const payoutId = params.payoutId;
    const pickedDepositId = body.depositStagedPaymentId ?? null;

    try {
      const result = await db.transaction(async (tx) => {
        // Lock the payout so the pairing read + decision stay consistent.
        const payout = await tx
          .select({ id: stripePayouts.id })
          .from(stripePayouts)
          .where(eq(stripePayouts.id, payoutId))
          .for("update")
          .then((r) => r[0]);
        if (!payout) {
          throw new ReconcileAbort(404, {
            error: "not_found",
            message: "Payout not found.",
          });
        }

        // Already paired — idempotent success (never re-book). If the caller
        // picked a DIFFERENT deposit than the paired one, we still return
        // success with the ACTUAL depositStagedPaymentId — the UI can detect
        // the mismatch from the response; a pairing is never repointed here.
        const existing = await tx
          .select({ id: stagedPayments.id })
          .from(stagedPayments)
          .where(eq(stagedPayments.settledStripePayoutId, payoutId))
          .then((r) => r[0]);
        if (existing) {
          return {
            confirmed: true,
            kind: "already_confirmed" as const,
            payoutId,
            depositStagedPaymentId: existing.id,
          };
        }

        if (!pickedDepositId) {
          throw new ReconcileAbort(400, {
            error: "no_deposit",
            message:
              "This payout has no paired deposit. Pick a QuickBooks deposit to pair before confirming.",
          });
        }
        const deposit = await tx
          .select()
          .from(stagedPayments)
          .where(eq(stagedPayments.id, pickedDepositId))
          .for("update")
          .then((r) => r[0]);
        if (!deposit) {
          throw new ReconcileAbort(404, {
            error: "deposit_not_found",
            message: "The chosen QuickBooks deposit no longer exists.",
          });
        }
        // Lump eligibility (settlementLump.ts): a deposit-typed row OR a
        // mis-typed net lump with a stripe/misc signal. A donor-name payment
        // row is PERMANENTLY ineligible (charge grain), not transient drift.
        if (!isSettlementLump(deposit)) {
          throw new ReconcileAbort(409, {
            error: "deposit_unconfirmable",
            message:
              "The chosen QuickBooks row is an individual donor payment, not a Stripe settlement lump — it can't back this settlement. Match it at the charge grain instead.",
          });
        }
        // Exclusivity: a deposit backs at most one payout's settlement.
        if (deposit.settledStripePayoutId) {
          throw new ReconcileAbort(409, {
            error: "deposit_unconfirmable",
            message:
              "This QuickBooks deposit is already reconciled against a different Stripe payout, so it can't back this settlement too. Pick a different deposit.",
          });
        }

        // Derive the deposit's status from facts: its counted ledger rows (the
        // sole gift-link source) — the pairing-elsewhere case was rejected
        // above, so hasConfirmedSettlementLink is false here.
        const hasCountedLedgerRows = await tx
          .select({ id: paymentApplications.id })
          .from(paymentApplications)
          .where(
            and(
              eq(paymentApplications.paymentId, pickedDepositId),
              eq(paymentApplications.linkRole, "counted"),
            ),
          )
          .limit(1)
          .then((r) => r.length > 0);
        const depositStatus = deriveStagedPaymentStatus({
          ...deposit,
          hasCountedApplication: hasCountedLedgerRows,
        });

        // Deliberate human override for an excluded lump: the picker labels
        // excluded rows (never hides them) and lets a second click assert
        // "this IS the payout's money" — clear the exclusion and pin
        // classification_source='manual' so the re-runnable classifier never
        // re-excludes it, under the FOR UPDATE lock already held.
        if (
          body.overrideExclusion &&
          depositStatus === "excluded" &&
          deposit.exclusionReason != null
        ) {
          await tx
            .update(stagedPayments)
            .set({
              exclusionReason: null,
              classificationSource: "manual",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(stagedPayments.id, pickedDepositId),
                stagedStatusWhere.excluded,
              ),
            );
        } else if (depositStatus === "excluded") {
          // Say exactly WHICH terminal state blocks the confirm — the card
          // toast surfaces this message verbatim.
          const reason = deposit.exclusionReason
            ? ` (${String(deposit.exclusionReason).replace(/_/g, " ")})`
            : "";
          throw new ReconcileAbort(409, {
            error: "deposit_unconfirmable",
            message: `This QuickBooks payment was excluded from review${reason}, so it can't back a settlement. If it was excluded by mistake, un-exclude it in Finance Reconciliation first, then retry.`,
          });
        } else if (depositStatus === "match_proposed") {
          throw new ReconcileAbort(409, {
            error: "deposit_unconfirmable",
            message:
              "This QuickBooks deposit has an auto-proposed gift match still awaiting review. Confirm or reject that match in Finance Reconciliation first, then retry the settlement.",
          });
        }

        // Fill-only pairing write; the partial unique index is the
        // belt-and-suspenders against a racing pairing of the same payout.
        const paired = await tx
          .update(stagedPayments)
          .set({
            settledStripePayoutId: payoutId,
            classificationSource: "manual",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(stagedPayments.id, pickedDepositId),
              isNull(stagedPayments.settledStripePayoutId),
            ),
          )
          .returning({ id: stagedPayments.id });
        if (!paired.length) {
          throw new ReconcileAbort(409, {
            error: "deposit_unconfirmable",
            message:
              "This QuickBooks deposit was just paired elsewhere. Refresh and retry.",
          });
        }

        // §4.3 supersede: the deposit's coarse counted QB rows may now be
        // covered by the payout's per-charge counted Stripe rows — recompute
        // in-tx so SUM readers never see the same dollars twice.
        await applySettlementSupersedeMany(tx, [pickedDepositId]);

        return {
          confirmed: true,
          // A deposit that already booked its own money takes the
          // linkage-only arm (the pairing is evidence; the booking stands).
          kind: hasCountedLedgerRows
            ? ("confirmed_linkage_only" as const)
            : ("confirmed_reconciled" as const),
          payoutId,
          depositStagedPaymentId: pickedDepositId,
        };
      });
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
