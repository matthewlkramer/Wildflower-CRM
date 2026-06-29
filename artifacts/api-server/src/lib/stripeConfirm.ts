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
 * A transaction handle, matching `db.transaction`'s callback argument. Exported
 * so callers (e.g. the settlement-bundle confirm) can fold the `*InTx`
 * transitions below into their OWN atomic transaction — the same committed
 * money-write primitives, never a parallel money path.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
 * D4 MODEL — the CRM gift is the single source of truth; Stripe charges/payouts
 * and QB staged rows are permanent reconciliation EVIDENCE, never a second gift
 * and never archived. Confirming a payout collapses to ONE terminal state,
 * `confirmed_reconciled`:
 *   - pending QB deposit  → deposit marked `reconciled` (NOT excluded; we no
 *     longer set exclusion_reason `processor_payout`). No gift exists to stamp.
 *   - approved/reconciled QB gift (conflict) → the existing gift is KEPT and the
 *     deposit is left untouched (already gift-linked terminal evidence); only the
 *     payout linkage is recorded, with qbConflictGiftId retained as the revert
 *     discriminator.
 * REPLACE is RETIRED: we never archive a gift to substitute per-charge Stripe
 * gifts. A genuine coarse-vs-granular conflict returns `manual_review_required`
 * (409) for a human to resolve out of band.
 *
 * Revert symmetry: a `confirmed_reconciled` payout reverts by its qbConflictGiftId
 * — NULL ⇒ it was a pending-deposit confirm (payout → `proposed`, deposit
 * `reconciled` → `pending`); SET ⇒ it was a keep confirm (payout →
 * `conflict_approved`, deposit left alone). Legacy confirmed_* branches are kept
 * for historical prod rows predating this model.
 */

export type ConfirmRevertKind = "confirmed_reconciled" | "reverted";

export type ConfirmRevertOk = {
  ok: true;
  kind: ConfirmRevertKind;
  payoutId: string;
  stagedPaymentId: string | null;
  /** Set by a legacy REPLACE revert: the QB-derived gift that was unarchived. */
  restoredGiftId?: string | null;
};

export type ConfirmRevertErrorCode =
  | "not_found"
  | "invalid_transition"
  | "charges_already_booked"
  | "manual_review_required";

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

export class TransitionError extends Error {
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
  fn: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ) => Promise<ConfirmRevertOk>,
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

// ─── CONFIRM (pending QB deposit) ──────────────────────────────────────────
// payout `proposed` → `confirmed_reconciled`; the pending QB deposit lump is
// marked `reconciled` (permanent payout-level evidence — NOT excluded, no
// processor_payout, no gift) and linked via matchedQbStagedPaymentId. The money
// is accounted for by the payout's separate per-charge Stripe gifts.
export function confirmPendingQbDeposit(
  args: ConfirmRevertArgs,
): Promise<ConfirmRevertResult> {
  return runTransition((tx) => confirmPendingQbDepositInTx(tx, args));
}

/**
 * Tx-safe core of {@link confirmPendingQbDeposit}: the guarded payout
 * `proposed` → `confirmed_reconciled` + deposit `pending` → `reconciled`
 * transition, runnable inside a caller-supplied transaction so the settlement
 * bundle confirm can fold the payout↔deposit tie into ONE atomic commit (no
 * parallel money path). Throws {@link TransitionError} on a drifted prior state;
 * the caller's transaction wrapper maps it (see {@link runTransition}).
 */
export async function confirmPendingQbDepositInTx(
  tx: Tx,
  args: ConfirmRevertArgs,
): Promise<ConfirmRevertOk> {
  const { payoutId, userId } = args;
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
    throw new TransitionError(
      "not_found",
      "Proposed QuickBooks deposit not found.",
    );
  }
  if (deposit.qbEntityType !== "deposit" || deposit.status !== "pending") {
    throw new TransitionError(
      "invalid_transition",
      "The proposed QuickBooks deposit is no longer pending. Refresh and retry.",
    );
  }

  const reconciled = await tx
    .update(stagedPayments)
    .set({
      status: "reconciled",
      classificationSource: "manual",
      updatedAt: now,
    })
    .where(
      and(
        eq(stagedPayments.id, depositId),
        eq(stagedPayments.status, "pending"),
      ),
    )
    .returning({ id: stagedPayments.id });
  if (!reconciled.length) {
    throw new TransitionError(
      "invalid_transition",
      "The proposed QuickBooks deposit is no longer pending. Refresh and retry.",
    );
  }

  const updated = await tx
    .update(stripePayouts)
    .set({
      qbReconciliationStatus: "confirmed_reconciled",
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
    kind: "confirmed_reconciled",
    payoutId,
    stagedPaymentId: depositId,
  };
}

// ─── CONFIRM-KEEP (approved/reconciled QB deposit) ─────────────────────────
// payout `conflict_approved` → `confirmed_reconciled`. The QB deposit was already
// booked into a gift (status `approved` for legacy rows, `reconciled` going
// forward); that gift is the authoritative record and is KEPT. We record the
// payout linkage ONLY and touch neither the deposit nor the gift. qbConflictGiftId
// is retained as the revert discriminator (a non-null value means "keep" on revert).
export function confirmKeepApprovedQbGift(
  args: ConfirmRevertArgs,
): Promise<ConfirmRevertResult> {
  return runTransition((tx) => confirmKeepApprovedQbGiftInTx(tx, args));
}

/**
 * Tx-safe core of {@link confirmKeepApprovedQbGift}: the guarded payout
 * `conflict_approved` → `confirmed_reconciled` linkage-only transition (the
 * already-booked deposit + gift are KEPT untouched as terminal evidence),
 * runnable inside a caller-supplied transaction so the settlement bundle confirm
 * can fold the payout↔deposit tie into ONE atomic commit. Throws
 * {@link TransitionError} on a drifted prior state.
 */
export async function confirmKeepApprovedQbGiftInTx(
  tx: Tx,
  args: ConfirmRevertArgs,
): Promise<ConfirmRevertOk> {
  const { payoutId, userId } = args;
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
    throw new TransitionError(
      "not_found",
      "Conflicting QuickBooks deposit not found.",
    );
  }
  if (deposit.status !== "approved" && deposit.status !== "reconciled") {
    throw new TransitionError(
      "invalid_transition",
      "The conflicting QuickBooks deposit is no longer booked into a gift. Refresh and retry.",
    );
  }

  // Touch neither the deposit nor the gift — they are already terminal evidence.
  // Preserve qbConflictStagedPaymentId + qbConflictGiftId as revert/audit
  // pointers (qbConflictGiftId being set is the revert discriminator for "keep").
  const updated = await tx
    .update(stripePayouts)
    .set({
      qbReconciliationStatus: "confirmed_reconciled",
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
    kind: "confirmed_reconciled",
    payoutId,
    stagedPaymentId: depositId,
  };
}

// ─── CONFIRM-REPLACE — RETIRED (D4) ────────────────────────────────────────
// In the D4 model the CRM gift is the single source of truth and we NEVER
// archive a gift to substitute per-charge Stripe gifts. A genuine coarse-QB-lump
// vs granular-Stripe-charges conflict is a real bookkeeping discrepancy that a
// human must resolve out of band, so this path now returns a typed
// `manual_review_required` error (mapped to HTTP 409 by the route) instead of
// mutating any gift/deposit. The signature is kept so the route + tests compile;
// `userId` is unused now.
export function confirmReplaceApprovedQbGift(
  args: ConfirmRevertArgs,
): Promise<ConfirmRevertResult> {
  void args;
  return Promise.resolve({
    ok: false,
    code: "manual_review_required",
    message:
      "Replacing a QuickBooks-derived gift with per-charge Stripe gifts is no longer automated. The CRM gift is the source of truth; resolve this coarse-vs-granular conflict manually.",
  });
}

// ─── REVERT (any confirmed state → back to proposal) ───────────────────────
// Undoes a confirm. The reverse target depends on the confirmed state:
//   confirmed_excluded → proposed         (deposit pending again)
//   confirmed_keep     → conflict_approved (deposit untouched)         [legacy]
//   confirmed_replace  → conflict_approved (deposit re-approved, gift unarchived) [legacy]
// D4 confirmed_reconciled reverts by its qbConflictGiftId discriminator:
//   qbConflictGiftId NULL → proposed          (deposit `reconciled` → `pending`)
//   qbConflictGiftId SET  → conflict_approved (deposit left untouched)
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

    // ── D4 primary revert: confirmed_reconciled ──────────────────────────────
    if (status === "confirmed_reconciled") {
      if (!depositId) {
        throw new TransitionError(
          "invalid_transition",
          "Payout has no linked deposit to revert.",
        );
      }
      // qbConflictGiftId set ⇒ this was a KEEP confirm of an already-booked gift:
      // the deposit + gift were never touched, so revert restores the payout to
      // conflict_approved and leaves the deposit alone.
      if (payout.qbConflictGiftId) {
        const updated = await tx
          .update(stripePayouts)
          .set({
            qbReconciliationStatus: "conflict_approved",
            proposedQbStagedPaymentId: depositId,
            qbConflictStagedPaymentId: depositId,
            matchedQbStagedPaymentId: null,
            qbReconciliationConfirmedByUserId: null,
            qbReconciliationConfirmedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(stripePayouts.id, payoutId),
              eq(stripePayouts.qbReconciliationStatus, "confirmed_reconciled"),
            ),
          )
          .returning({ id: stripePayouts.id });
        if (!updated.length) {
          throw new TransitionError(
            "invalid_transition",
            "This payout has changed. Refresh and retry.",
          );
        }
        return {
          ok: true,
          kind: "reverted",
          payoutId,
          stagedPaymentId: depositId,
        };
      }

      // qbConflictGiftId null ⇒ this was a pending-deposit confirm: the deposit
      // was marked `reconciled`. Revert it back to `pending` and the payout to
      // `proposed`.
      const deposit = await tx
        .select()
        .from(stagedPayments)
        .where(eq(stagedPayments.id, depositId))
        .for("update")
        .then((r) => r[0]);
      if (!deposit)
        throw new TransitionError(
          "not_found",
          "Linked QuickBooks deposit not found.",
        );
      const reverted = await tx
        .update(stagedPayments)
        .set({
          status: "pending",
          classificationSource: "manual",
          updatedAt: now,
        })
        .where(
          and(
            eq(stagedPayments.id, depositId),
            eq(stagedPayments.status, "reconciled"),
          ),
        )
        .returning({ id: stagedPayments.id });
      if (!reverted.length) {
        throw new TransitionError(
          "invalid_transition",
          "The linked deposit is no longer reconciled. Refresh and retry.",
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
            eq(stripePayouts.qbReconciliationStatus, "confirmed_reconciled"),
          ),
        )
        .returning({ id: stripePayouts.id });
      if (!updated.length) {
        throw new TransitionError(
          "invalid_transition",
          "This payout has changed. Refresh and retry.",
        );
      }
      return {
        ok: true,
        kind: "reverted",
        payoutId,
        stagedPaymentId: depositId,
      };
    }

    if (status === "confirmed_excluded") {
      if (!depositId) {
        throw new TransitionError(
          "invalid_transition",
          "Payout has no linked deposit to revert.",
        );
      }
      const deposit = await tx
        .select()
        .from(stagedPayments)
        .where(eq(stagedPayments.id, depositId))
        .for("update")
        .then((r) => r[0]);
      if (!deposit)
        throw new TransitionError(
          "not_found",
          "Linked QuickBooks deposit not found.",
        );
      const reincluded = await tx
        .update(stagedPayments)
        .set({
          status: "pending",
          exclusionReason: null,
          classificationSource: "manual",
          updatedAt: now,
        })
        .where(
          and(
            eq(stagedPayments.id, depositId),
            eq(stagedPayments.status, "excluded"),
          ),
        )
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
        throw new TransitionError(
          "invalid_transition",
          "This payout has changed. Refresh and retry.",
        );
      }
      return {
        ok: true,
        kind: "reverted",
        payoutId,
        stagedPaymentId: depositId,
      };
    }

    if (status === "confirmed_keep") {
      if (!depositId) {
        throw new TransitionError(
          "invalid_transition",
          "Payout has no linked deposit to revert.",
        );
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
        throw new TransitionError(
          "invalid_transition",
          "This payout has changed. Refresh and retry.",
        );
      }
      return {
        ok: true,
        kind: "reverted",
        payoutId,
        stagedPaymentId: depositId,
      };
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
      if (!deposit)
        throw new TransitionError(
          "not_found",
          "Linked QuickBooks deposit not found.",
        );

      const gift = await tx
        .select()
        .from(giftsAndPayments)
        .where(eq(giftsAndPayments.id, conflictGiftId))
        .for("update")
        .then((r) => r[0]);
      if (!gift)
        throw new TransitionError(
          "not_found",
          "Archived QuickBooks-derived gift not found.",
        );

      const reincluded = await tx
        .update(stagedPayments)
        .set({
          status: "approved",
          exclusionReason: null,
          classificationSource: "manual",
          updatedAt: now,
        })
        .where(
          and(
            eq(stagedPayments.id, depositId),
            eq(stagedPayments.status, "excluded"),
          ),
        )
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
        .where(
          and(
            eq(giftsAndPayments.id, conflictGiftId),
            isNotNull(giftsAndPayments.archivedAt),
          ),
        )
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
        throw new TransitionError(
          "invalid_transition",
          "This payout has changed. Refresh and retry.",
        );
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
