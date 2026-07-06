import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  reconciliationBundleDrafts,
  stripeStagedCharges,
  stagedPayments,
  stripePayouts,
  giftsAndPayments,
  settlementLinks,
} from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
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
  RejectSettlementProposalParams,
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
import {
  confirmPendingQbDepositInTx,
  confirmKeepApprovedQbGiftInTx,
  TransitionError,
} from "../../lib/stripeConfirm";
import { donorOf, donorsMatch, type LinkDonor } from "../../lib/quickbooksLink";
import { applyDerivedOppFieldsMany } from "../../lib/pledgeStage";
import { applyGiftQbTieMany } from "../../lib/giftQbTie";
import {
  deleteSettlementLink,
  upsertSettlementLink,
} from "../../lib/settlementLink";
import { proposeSettlementLink } from "../../lib/settlementWriter";

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
  // Authoritative source of the payout↔deposit tie is settlement_links; its
  // deposit covers every lifecycle (proposed/confirmed and the conflict tie),
  // so this subsumes the legacy matched/proposed/qbConflict pointer OR.
  const tied = await conn
    .select({ id: stripePayouts.id })
    .from(settlementLinks)
    .innerJoin(stripePayouts, eq(stripePayouts.id, settlementLinks.payoutId))
    .where(eq(settlementLinks.depositStagedPaymentId, anchorId))
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

        // ── TIE FIRST: stamp the payout↔deposit reconciliation. ──
        let tieConfirmed = false;
        const tie = proposal.tie;
        if (tie && tie.action === "confirm_tie" && tie.payoutId) {
          if (tie.status === "proposed") {
            await confirmPendingQbDepositInTx(tx, {
              payoutId: tie.payoutId,
              userId,
            });
            tieConfirmed = true;
          } else if (tie.status === "conflict_approved") {
            await confirmKeepApprovedQbGiftInTx(tx, {
              payoutId: tie.payoutId,
              userId,
            });
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
              await createGiftFromChargeInTx(tx, {
                newGiftId,
                charge,
                donor: donorXor,
                paymentIntermediaryId: dp.paymentIntermediaryId ?? null,
                userId,
                auditReq: req,
              });
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
                group: null,
                userId,
                auditReq: req,
              });
              pledgeRederiveIds.push(mintRes.opportunityIdToRederive);
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
      if (e instanceof TransitionError) {
        res
          .status(409)
          .json({ error: "tie_transition", message: e.message });
        return;
      }
      throw e;
    }

    if (!committed) return;

    // Post-commit appliers (skipped on an idempotent replay — nothing booked).
    if (!committed.alreadyConfirmed) {
      await applyDerivedOppFieldsMany(...pledgeRederiveIds);
      await applyGiftQbTieMany(...giftTieIds);
    }

    res.json(committed);
  }),
);

// ─── POST /reconciliation/settlement-links/:payoutId/reject ──────────────────
// Dismiss a PROPOSED payout↔deposit tie: delete the proposed settlement link so
// the Settlement report shows the payout as an un-proposed orphan again. Money is
// untouched (nothing excluded, no gift minted). A CONFIRMED link is never rejected
// here (revert is a separate path) → 409. No proposed link → no-op success.
router.post(
  "/reconciliation/settlement-links/:payoutId/reject",
  asyncHandler(async (req, res) => {
    const params = parseOrBadRequest(
      RejectSettlementProposalParams,
      req.params,
      res,
    );
    if (!params) return;

    const link = await db
      .select({ lifecycle: settlementLinks.lifecycle })
      .from(settlementLinks)
      .where(eq(settlementLinks.payoutId, params.payoutId))
      .then((r) => r[0]);

    if (!link) {
      res.json({ rejected: false });
      return;
    }
    if (link.lifecycle === "confirmed") {
      res.status(409).json({
        error: "settlement_confirmed",
        message: "This settlement tie is confirmed; use revert, not reject.",
      });
      return;
    }

    await deleteSettlementLink(db, params.payoutId);
    res.json({ rejected: true });
  }),
);

// ─── POST /reconciliation/settlement-links/:payoutId/confirm ─────────────────
// Confirm the Plane-1 payout↔deposit settlement tie ONLY (docs/reconciliation-
// design.md §4.3/§4.4) — decoupled from the Plane-2 per-charge → gift booking the
// Gift report owns. This is what lets a "linked" (proposed) settlement approve in
// ONE click: we never re-derive the whole per-charge bundle here, so a charge that
// still needs a donor/gift decision no longer blocks confirming the settlement.
//
// Money-safety: confirming stamps the deposit `reconciled`, which IS the double-
// count guard — the coarse deposit can never also credit donors on top of the
// individual per-charge Stripe gifts. Charges keep being credited via the Gift
// report, exactly once.
//
// State machine (mirrors the tie step the bundle confirm used, minus the bundle):
//   • proposed, no conflict gift → confirmPendingQbDepositInTx (deposit → reconciled)
//   • proposed + conflict gift   → confirmKeepApprovedQbGiftInTx (keep the gift)
//   • already confirmed          → idempotent success
//   • no link + body deposit     → propose the tie, then confirm (Resolve, both dirs)
//   • no link + no deposit       → 400
router.post(
  "/reconciliation/settlement-links/:payoutId/confirm",
  asyncHandler(async (req, res) => {
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

    const userId = user.id;
    const payoutId = params.payoutId;
    const pickedDepositId = body.depositStagedPaymentId ?? null;

    try {
      const result = await db.transaction(async (tx) => {
        // Lock the payout so the link read + path decision stay consistent with
        // the confirm primitives (which re-lock the same row FOR UPDATE).
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

        const link = await tx
          .select({
            lifecycle: settlementLinks.lifecycle,
            conflictGiftId: settlementLinks.conflictGiftId,
            depositStagedPaymentId: settlementLinks.depositStagedPaymentId,
          })
          .from(settlementLinks)
          .where(eq(settlementLinks.payoutId, payoutId))
          .then((r) => r[0] ?? null);

        // Already settled — idempotent success (never re-book).
        if (link?.lifecycle === "confirmed") {
          return {
            confirmed: true,
            kind: "already_confirmed" as const,
            payoutId,
            depositStagedPaymentId: link.depositStagedPaymentId,
          };
        }

        // A proposed tie exists → confirm it on its current shape.
        if (link?.lifecycle === "proposed") {
          if (link.conflictGiftId) {
            const r = await confirmKeepApprovedQbGiftInTx(tx, {
              payoutId,
              userId,
            });
            return {
              confirmed: true,
              kind: "conflict_kept" as const,
              payoutId,
              depositStagedPaymentId: r.stagedPaymentId,
            };
          }
          const r = await confirmPendingQbDepositInTx(tx, { payoutId, userId });
          return {
            confirmed: true,
            kind: "confirmed_reconciled" as const,
            payoutId,
            depositStagedPaymentId: r.stagedPaymentId,
          };
        }

        // No settlement link at all → Resolve: propose the caller's chosen
        // payout↔deposit tie, then confirm it in the same transaction.
        if (!pickedDepositId) {
          throw new ReconcileAbort(400, {
            error: "no_deposit",
            message:
              "This payout has no proposed deposit. Pick a QuickBooks deposit to tie before confirming.",
          });
        }
        const deposit = await tx
          .select({
            id: stagedPayments.id,
            qbEntityType: stagedPayments.qbEntityType,
            status: stagedPayments.status,
            sourceGroupId: stagedPayments.sourceGroupId,
          })
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
        if (deposit.qbEntityType !== "deposit" || deposit.status !== "pending") {
          throw new ReconcileAbort(409, {
            error: "deposit_ineligible",
            message:
              "The chosen QuickBooks deposit is no longer an open deposit. Refresh and retry.",
          });
        }
        if (deposit.sourceGroupId) {
          throw new ReconcileAbort(409, {
            error: "deposit_grouped",
            message:
              "The chosen deposit belongs to a payment group and can't be settled directly.",
          });
        }
        // Exclusivity: a deposit may back only one payout's settlement.
        const otherLink = await tx
          .select({ id: settlementLinks.id })
          .from(settlementLinks)
          .where(eq(settlementLinks.depositStagedPaymentId, pickedDepositId))
          .then((r) => r[0]);
        if (otherLink) {
          throw new ReconcileAbort(409, {
            error: "deposit_already_tied",
            message:
              "The chosen deposit is already tied to another payout. Refresh and retry.",
          });
        }

        await upsertSettlementLink(
          tx,
          payoutId,
          proposeSettlementLink(pickedDepositId, null),
        );
        const r = await confirmPendingQbDepositInTx(tx, { payoutId, userId });
        return {
          confirmed: true,
          kind: "confirmed_reconciled" as const,
          payoutId,
          depositStagedPaymentId: r.stagedPaymentId,
        };
      });
      res.json(result);
    } catch (e) {
      if (e instanceof ReconcileAbort) {
        res.status(e.httpStatus).json(e.payload);
        return;
      }
      if (e instanceof TransitionError) {
        res
          .status(409)
          .json({ error: "tie_transition", message: e.message });
        return;
      }
      throw e;
    }
  }),
);

export default router;
