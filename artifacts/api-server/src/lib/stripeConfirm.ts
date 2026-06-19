import { db } from "@workspace/db";
import {
  giftsAndPayments,
  stagedPayments,
  stripePayouts,
  stripeStagedCharges,
} from "@workspace/db/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { candidateGiftId } from "./stripeReconcile";

/**
 * R4 — human-confirmed payout ↔ QuickBooks-deposit reconciliation transitions.
 *
 * The proposal pass (stripeReconcile.ts) only ever SUGGESTS a match (sets a
 * payout to `proposed` or `conflict_approved`). NOTHING is excluded, archived,
 * or relinked until a human confirms here. Every transition:
 *
 *   1. opens its own transaction,
 *   2. SELECT ... FOR UPDATE locks the payout + the QB deposit row (and the gift
 *      for REPLACE) so a concurrent proposal pass / approval can't race it,
 *   3. re-checks the prior state under the lock and bails with a typed error if
 *      it has drifted (maps to 409 in the route), and
 *   4. writes guarded UPDATEs (WHERE still pins the expected prior state) as a
 *      belt-and-suspenders against the rare lost-lock case.
 *
 * This mirrors the QuickBooks confirm/create-gift pattern in routes/quickbooks.ts
 * (tx + FOR UPDATE + guarded UPDATE). It deliberately does NOT take the global
 * Stripe sync advisory lock: a user-facing single-row confirm must not block
 * behind a multi-minute backfill, and the row locks + guarded writes already
 * guarantee correctness. A proposal pass that races a confirm self-heals on its
 * next run (a now-excluded/linked deposit drops out of its candidate set).
 *
 * CONFIRM-REPLACE intentionally does NOT mint gifts from the payout's Stripe
 * charges. Minting requires exactly-one donor per charge (Donor XOR) and would
 * have no provenance to safely undo on revert. Instead REPLACE archives the
 * coarse QB-derived lump gift and unblocks the charge queue; the operator then
 * approves each granular Stripe charge through the normal staged-charge flow
 * (which is gated only on `conflict_approved`, not `confirmed_replace`).
 */

export type ConfirmRevertKind =
  | "confirmed_excluded"
  | "confirmed_keep"
  | "confirmed_replace"
  | "reverted";

export type ConfirmRevertOk = {
  ok: true;
  kind: ConfirmRevertKind;
  payoutId: string;
  stagedPaymentId: string | null;
  /** Set by REPLACE: the QB-derived gift that was archived. */
  archivedGiftId?: string | null;
  /** Set by a REPLACE revert: the QB-derived gift that was unarchived. */
  restoredGiftId?: string | null;
};

export type ConfirmRevertErrorCode =
  | "not_found"
  | "invalid_transition"
  | "charges_already_booked";

export type ConfirmRevertErr = {
  ok: false;
  code: ConfirmRevertErrorCode;
  message: string;
};

export type ConfirmRevertResult = ConfirmRevertOk | ConfirmRevertErr;

export interface ConfirmRevertArgs {
  payoutId: string;
  /** App user id stamped as the confirmer (null for system callers). */
  userId: string | null;
}

class TransitionError extends Error {
  constructor(
    public code: ConfirmRevertErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

/** Append a timestamped audit line to a gift's free-text `details` column. */
function appendAudit(existing: string | null, note: string, at: Date): string {
  const line = `[${at.toISOString()}] ${note}`;
  return existing && existing.length > 0 ? `${existing}\n${line}` : line;
}

async function runTransition(
  fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<ConfirmRevertOk>,
): Promise<ConfirmRevertResult> {
  try {
    return await db.transaction(fn);
  } catch (e) {
    if (e instanceof TransitionError) {
      return { ok: false, code: e.code, message: e.message };
    }
    throw e;
  }
}

// ─── CONFIRM-EXCLUDE (pending QB deposit) ──────────────────────────────────
// payout `proposed` → `confirmed_excluded`; the pending QB deposit lump is
// excluded (reason processor_payout) but KEPT + linked via matchedQbStagedPaymentId.
export function confirmPendingQbDeposit(
  args: ConfirmRevertArgs,
): Promise<ConfirmRevertResult> {
  const { payoutId, userId } = args;
  return runTransition(async (tx) => {
    const now = new Date();
    const payout = await tx
      .select()
      .from(stripePayouts)
      .where(eq(stripePayouts.id, payoutId))
      .for("update")
      .then((r) => r[0]);
    if (!payout) throw new TransitionError("not_found", "Payout not found.");
    if (payout.qbReconciliationStatus !== "proposed") {
      throw new TransitionError(
        "invalid_transition",
        "Only a proposed payout can be confirmed as excluded.",
      );
    }
    const depositId = payout.proposedQbStagedPaymentId;
    if (!depositId) {
      throw new TransitionError(
        "invalid_transition",
        "Payout has no proposed QuickBooks deposit to confirm.",
      );
    }
    const deposit = await tx
      .select()
      .from(stagedPayments)
      .where(eq(stagedPayments.id, depositId))
      .for("update")
      .then((r) => r[0]);
    if (!deposit) {
      throw new TransitionError("not_found", "Proposed QuickBooks deposit not found.");
    }
    if (deposit.qbEntityType !== "deposit" || deposit.status !== "pending") {
      throw new TransitionError(
        "invalid_transition",
        "The proposed QuickBooks deposit is no longer pending. Refresh and retry.",
      );
    }

    const excluded = await tx
      .update(stagedPayments)
      .set({
        status: "excluded",
        exclusionReason: "processor_payout",
        classificationSource: "manual",
        updatedAt: now,
      })
      .where(and(eq(stagedPayments.id, depositId), eq(stagedPayments.status, "pending")))
      .returning({ id: stagedPayments.id });
    if (!excluded.length) {
      throw new TransitionError(
        "invalid_transition",
        "The proposed QuickBooks deposit is no longer pending. Refresh and retry.",
      );
    }

    const updated = await tx
      .update(stripePayouts)
      .set({
        qbReconciliationStatus: "confirmed_excluded",
        matchedQbStagedPaymentId: depositId,
        proposedQbStagedPaymentId: null,
        qbReconciliationConfirmedByUserId: userId,
        qbReconciliationConfirmedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(stripePayouts.id, payoutId),
          eq(stripePayouts.qbReconciliationStatus, "proposed"),
        ),
      )
      .returning({ id: stripePayouts.id });
    if (!updated.length) {
      throw new TransitionError(
        "invalid_transition",
        "This payout is no longer proposed. Refresh and retry.",
      );
    }

    return {
      ok: true,
      kind: "confirmed_excluded",
      payoutId,
      stagedPaymentId: depositId,
    };
  });
}

// ─── CONFIRM-KEEP (approved QB deposit) ────────────────────────────────────
// payout `conflict_approved` → `confirmed_keep`. The QB deposit was already
// booked into a gift; KEEP records the linkage only and touches nothing else.
export function confirmKeepApprovedQbGift(
  args: ConfirmRevertArgs,
): Promise<ConfirmRevertResult> {
  const { payoutId, userId } = args;
  return runTransition(async (tx) => {
    const now = new Date();
    const payout = await tx
      .select()
      .from(stripePayouts)
      .where(eq(stripePayouts.id, payoutId))
      .for("update")
      .then((r) => r[0]);
    if (!payout) throw new TransitionError("not_found", "Payout not found.");
    if (payout.qbReconciliationStatus !== "conflict_approved") {
      throw new TransitionError(
        "invalid_transition",
        "Only a conflicting (already-approved) payout can be kept.",
      );
    }
    const depositId = payout.qbConflictStagedPaymentId;
    if (!depositId) {
      throw new TransitionError(
        "invalid_transition",
        "Payout has no conflicting QuickBooks deposit to keep.",
      );
    }
    const deposit = await tx
      .select()
      .from(stagedPayments)
      .where(eq(stagedPayments.id, depositId))
      .for("update")
      .then((r) => r[0]);
    if (!deposit) {
      throw new TransitionError("not_found", "Conflicting QuickBooks deposit not found.");
    }
    if (deposit.status !== "approved") {
      throw new TransitionError(
        "invalid_transition",
        "The conflicting QuickBooks deposit is no longer approved. Refresh and retry.",
      );
    }

    // Preserve qbConflictStagedPaymentId + qbConflictGiftId as revert/audit
    // pointers; the confirmed_keep status is not re-proposable so they are inert.
    const updated = await tx
      .update(stripePayouts)
      .set({
        qbReconciliationStatus: "confirmed_keep",
        matchedQbStagedPaymentId: depositId,
        proposedQbStagedPaymentId: null,
        qbReconciliationConfirmedByUserId: userId,
        qbReconciliationConfirmedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(stripePayouts.id, payoutId),
          eq(stripePayouts.qbReconciliationStatus, "conflict_approved"),
        ),
      )
      .returning({ id: stripePayouts.id });
    if (!updated.length) {
      throw new TransitionError(
        "invalid_transition",
        "This payout is no longer in conflict. Refresh and retry.",
      );
    }

    return {
      ok: true,
      kind: "confirmed_keep",
      payoutId,
      stagedPaymentId: depositId,
    };
  });
}

// ─── CONFIRM-REPLACE (approved QB deposit, explicit) ───────────────────────
// payout `conflict_approved` → `confirmed_replace`. Archives the coarse
// QB-derived lump gift (kept, never deleted; allocations preserved), excludes
// the QB deposit (processor_payout, kept + linked), and unblocks the Stripe
// charge queue so the operator can book granular per-donor gifts.
export function confirmReplaceApprovedQbGift(
  args: ConfirmRevertArgs,
): Promise<ConfirmRevertResult> {
  const { payoutId, userId } = args;
  return runTransition(async (tx) => {
    const now = new Date();
    const payout = await tx
      .select()
      .from(stripePayouts)
      .where(eq(stripePayouts.id, payoutId))
      .for("update")
      .then((r) => r[0]);
    if (!payout) throw new TransitionError("not_found", "Payout not found.");
    if (payout.qbReconciliationStatus !== "conflict_approved") {
      throw new TransitionError(
        "invalid_transition",
        "Only a conflicting (already-approved) payout can be replaced.",
      );
    }
    const depositId = payout.qbConflictStagedPaymentId;
    const conflictGiftId = payout.qbConflictGiftId;
    if (!depositId || !conflictGiftId) {
      throw new TransitionError(
        "invalid_transition",
        "Payout has no conflicting QuickBooks deposit + gift to replace.",
      );
    }
    const deposit = await tx
      .select()
      .from(stagedPayments)
      .where(eq(stagedPayments.id, depositId))
      .for("update")
      .then((r) => r[0]);
    if (!deposit) {
      throw new TransitionError("not_found", "Conflicting QuickBooks deposit not found.");
    }
    if (deposit.status !== "approved") {
      throw new TransitionError(
        "invalid_transition",
        "The conflicting QuickBooks deposit is no longer approved. Refresh and retry.",
      );
    }
    // The gift the deposit currently points at is authoritative; bail if it has
    // drifted from what we recorded at proposal time (stale → re-propose).
    const depositGiftId = candidateGiftId({
      matchedGiftId: deposit.matchedGiftId,
      createdGiftId: deposit.createdGiftId,
      groupReconciledGiftId: deposit.groupReconciledGiftId,
    });
    if (depositGiftId !== conflictGiftId) {
      throw new TransitionError(
        "invalid_transition",
        "The QuickBooks deposit's gift has changed since this match was proposed. Refresh and retry.",
      );
    }

    const gift = await tx
      .select()
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, conflictGiftId))
      .for("update")
      .then((r) => r[0]);
    if (!gift) {
      throw new TransitionError("not_found", "QuickBooks-derived gift not found.");
    }
    if (gift.archivedAt) {
      throw new TransitionError(
        "invalid_transition",
        "The QuickBooks-derived gift is already archived.",
      );
    }

    const archived = await tx
      .update(giftsAndPayments)
      .set({
        archivedAt: now,
        details: appendAudit(
          gift.details,
          `Archived by Stripe payout reconciliation (payout ${payoutId}); replaced by granular Stripe charge gifts.`,
          now,
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(giftsAndPayments.id, conflictGiftId),
          sql`${giftsAndPayments.archivedAt} IS NULL`,
        ),
      )
      .returning({ id: giftsAndPayments.id });
    if (!archived.length) {
      throw new TransitionError(
        "invalid_transition",
        "The QuickBooks-derived gift could not be archived. Refresh and retry.",
      );
    }

    const excluded = await tx
      .update(stagedPayments)
      .set({
        status: "excluded",
        exclusionReason: "processor_payout",
        classificationSource: "manual",
        updatedAt: now,
      })
      .where(and(eq(stagedPayments.id, depositId), eq(stagedPayments.status, "approved")))
      .returning({ id: stagedPayments.id });
    if (!excluded.length) {
      throw new TransitionError(
        "invalid_transition",
        "The conflicting QuickBooks deposit is no longer approved. Refresh and retry.",
      );
    }

    const updated = await tx
      .update(stripePayouts)
      .set({
        qbReconciliationStatus: "confirmed_replace",
        matchedQbStagedPaymentId: depositId,
        proposedQbStagedPaymentId: null,
        qbReconciliationConfirmedByUserId: userId,
        qbReconciliationConfirmedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(stripePayouts.id, payoutId),
          eq(stripePayouts.qbReconciliationStatus, "conflict_approved"),
        ),
      )
      .returning({ id: stripePayouts.id });
    if (!updated.length) {
      throw new TransitionError(
        "invalid_transition",
        "This payout is no longer in conflict. Refresh and retry.",
      );
    }

    return {
      ok: true,
      kind: "confirmed_replace",
      payoutId,
      stagedPaymentId: depositId,
      archivedGiftId: conflictGiftId,
    };
  });
}

// ─── REVERT (any confirmed state → back to proposal) ───────────────────────
// Undoes a confirm. The reverse target depends on the confirmed state:
//   confirmed_excluded → proposed         (deposit pending again)
//   confirmed_keep     → conflict_approved (deposit untouched)
//   confirmed_replace  → conflict_approved (deposit re-approved, gift unarchived)
// confirmed_replace revert is refused (charges_already_booked) once any of the
// payout's Stripe charges have been booked into a gift — the operator must
// revert those charge gifts first.
export function revertPayoutQbConfirmation(
  args: ConfirmRevertArgs,
): Promise<ConfirmRevertResult> {
  const { payoutId } = args;
  return runTransition(async (tx) => {
    const now = new Date();
    const payout = await tx
      .select()
      .from(stripePayouts)
      .where(eq(stripePayouts.id, payoutId))
      .for("update")
      .then((r) => r[0]);
    if (!payout) throw new TransitionError("not_found", "Payout not found.");

    const status = payout.qbReconciliationStatus;
    const depositId = payout.matchedQbStagedPaymentId;

    if (status === "confirmed_excluded") {
      if (!depositId) {
        throw new TransitionError("invalid_transition", "Payout has no linked deposit to revert.");
      }
      const deposit = await tx
        .select()
        .from(stagedPayments)
        .where(eq(stagedPayments.id, depositId))
        .for("update")
        .then((r) => r[0]);
      if (!deposit) throw new TransitionError("not_found", "Linked QuickBooks deposit not found.");
      const reincluded = await tx
        .update(stagedPayments)
        .set({
          status: "pending",
          exclusionReason: null,
          classificationSource: "manual",
          updatedAt: now,
        })
        .where(and(eq(stagedPayments.id, depositId), eq(stagedPayments.status, "excluded")))
        .returning({ id: stagedPayments.id });
      if (!reincluded.length) {
        throw new TransitionError(
          "invalid_transition",
          "The linked deposit is no longer excluded. Refresh and retry.",
        );
      }
      const updated = await tx
        .update(stripePayouts)
        .set({
          qbReconciliationStatus: "proposed",
          proposedQbStagedPaymentId: depositId,
          matchedQbStagedPaymentId: null,
          qbReconciliationConfirmedByUserId: null,
          qbReconciliationConfirmedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(stripePayouts.id, payoutId),
            eq(stripePayouts.qbReconciliationStatus, "confirmed_excluded"),
          ),
        )
        .returning({ id: stripePayouts.id });
      if (!updated.length) {
        throw new TransitionError("invalid_transition", "This payout has changed. Refresh and retry.");
      }
      return { ok: true, kind: "reverted", payoutId, stagedPaymentId: depositId };
    }

    if (status === "confirmed_keep") {
      if (!depositId) {
        throw new TransitionError("invalid_transition", "Payout has no linked deposit to revert.");
      }
      // KEEP touched nothing but the payout, so revert restores the payout only.
      const updated = await tx
        .update(stripePayouts)
        .set({
          qbReconciliationStatus: "conflict_approved",
          proposedQbStagedPaymentId: depositId,
          matchedQbStagedPaymentId: null,
          qbReconciliationConfirmedByUserId: null,
          qbReconciliationConfirmedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(stripePayouts.id, payoutId),
            eq(stripePayouts.qbReconciliationStatus, "confirmed_keep"),
          ),
        )
        .returning({ id: stripePayouts.id });
      if (!updated.length) {
        throw new TransitionError("invalid_transition", "This payout has changed. Refresh and retry.");
      }
      return { ok: true, kind: "reverted", payoutId, stagedPaymentId: depositId };
    }

    if (status === "confirmed_replace") {
      const conflictGiftId = payout.qbConflictGiftId;
      if (!depositId || !conflictGiftId) {
        throw new TransitionError(
          "invalid_transition",
          "Payout has no linked deposit + gift to revert.",
        );
      }
      // Refuse if any of this payout's Stripe charges have already been booked
      // into a gift — those gifts must be reverted through the charge flow first.
      const booked = await tx
        .select({ id: stripeStagedCharges.id })
        .from(stripeStagedCharges)
        .where(
          and(
            eq(stripeStagedCharges.stripePayoutId, payoutId),
            eq(stripeStagedCharges.status, "approved"),
            sql`(${stripeStagedCharges.createdGiftId} IS NOT NULL OR ${stripeStagedCharges.matchedGiftId} IS NOT NULL)`,
          ),
        )
        .limit(1);
      if (booked.length) {
        throw new TransitionError(
          "charges_already_booked",
          "Stripe charges from this payout have already been booked into gifts. Revert those charge gifts before reverting the replacement.",
        );
      }

      const deposit = await tx
        .select()
        .from(stagedPayments)
        .where(eq(stagedPayments.id, depositId))
        .for("update")
        .then((r) => r[0]);
      if (!deposit) throw new TransitionError("not_found", "Linked QuickBooks deposit not found.");

      const gift = await tx
        .select()
        .from(giftsAndPayments)
        .where(eq(giftsAndPayments.id, conflictGiftId))
        .for("update")
        .then((r) => r[0]);
      if (!gift) throw new TransitionError("not_found", "Archived QuickBooks-derived gift not found.");

      const reincluded = await tx
        .update(stagedPayments)
        .set({
          status: "approved",
          exclusionReason: null,
          classificationSource: "manual",
          updatedAt: now,
        })
        .where(and(eq(stagedPayments.id, depositId), eq(stagedPayments.status, "excluded")))
        .returning({ id: stagedPayments.id });
      if (!reincluded.length) {
        throw new TransitionError(
          "invalid_transition",
          "The linked deposit is no longer excluded. Refresh and retry.",
        );
      }

      const unarchived = await tx
        .update(giftsAndPayments)
        .set({
          archivedAt: null,
          details: appendAudit(
            gift.details,
            `Unarchived: Stripe payout reconciliation reverted (payout ${payoutId}).`,
            now,
          ),
          updatedAt: now,
        })
        .where(and(eq(giftsAndPayments.id, conflictGiftId), isNotNull(giftsAndPayments.archivedAt)))
        .returning({ id: giftsAndPayments.id });
      if (!unarchived.length) {
        throw new TransitionError(
          "invalid_transition",
          "The QuickBooks-derived gift is no longer archived. Refresh and retry.",
        );
      }

      const updated = await tx
        .update(stripePayouts)
        .set({
          qbReconciliationStatus: "conflict_approved",
          proposedQbStagedPaymentId: depositId,
          matchedQbStagedPaymentId: null,
          qbReconciliationConfirmedByUserId: null,
          qbReconciliationConfirmedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(stripePayouts.id, payoutId),
            eq(stripePayouts.qbReconciliationStatus, "confirmed_replace"),
          ),
        )
        .returning({ id: stripePayouts.id });
      if (!updated.length) {
        throw new TransitionError("invalid_transition", "This payout has changed. Refresh and retry.");
      }
      return {
        ok: true,
        kind: "reverted",
        payoutId,
        stagedPaymentId: depositId,
        restoredGiftId: conflictGiftId,
      };
    }

    throw new TransitionError(
      "invalid_transition",
      "This payout is not in a confirmed state and has nothing to revert.",
    );
  });
}
