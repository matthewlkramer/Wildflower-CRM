import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  reconciliationBundleDrafts,
  stripeStagedCharges,
  stagedPayments,
  giftsAndPayments,
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
} from "@workspace/api-zod";
import {
  assembleBundleProposal,
  mergeOverrides,
  type StoredBundleOverrides,
  type BundleOverridesInput,
  type DerivedBundle,
  type DonorRecordKind,
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

    const existing = await db
      .select()
      .from(reconciliationBundleDrafts)
      .where(
        and(
          eq(reconciliationBundleDrafts.anchorType, body.anchorType),
          eq(reconciliationBundleDrafts.anchorId, body.anchorId),
        ),
      )
      .then((r) => r[0]);

    const overrides = (existing?.overrides ?? {}) as StoredBundleOverrides;
    const assembled = await assembleBundleProposal({
      anchorType: body.anchorType,
      anchorId: body.anchorId,
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
          anchorType: body.anchorType,
          anchorId: body.anchorId,
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

export default router;
