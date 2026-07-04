import { db } from "@workspace/db";
import {
  settlementLinks,
  stagedPayments,
  stripePayouts,
} from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { candidateGiftId } from "./stripeReconcile";
import { payoutStatusFromLink, upsertSettlementLink } from "./settlementLink";
import {
  confirmSettlementLink,
  proposeSettlementLink,
  reverseSettlementLink,
} from "./settlementWriter";

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
 * Revert symmetry: a `confirmed_reconciled` payout reverts by its settlement
 * link's conflict-gift discriminator — NULL ⇒ it was a pending-deposit confirm
 * (payout → `proposed`, deposit `reconciled` → `pending`); SET ⇒ it was a keep
 * confirm (payout → `conflict_approved`, deposit left alone).
 *
 * Phase-6: every gate/branch below derives state from `settlement_links` (via
 * `payoutStatusFromLink` + the link's deposit/conflict pointers), NOT the legacy
 * `qb_reconciliation_status` + pointer columns. Those columns are still WRITTEN in
 * lockstep (reverseSettlementLink) as the optimistic-lock guard + mirror until a
 * later drop task; they are no longer READ for branching. The retired legacy
 * 7-value confirmed_* sub-states (zero in prod, unproducible by the authoritative
 * writer) have no revert branch and degrade to `invalid_transition`.
 */

export type ConfirmRevertKind = "confirmed_reconciled" | "reverted";

export type ConfirmRevertOk = {
  ok: true;
  kind: ConfirmRevertKind;
  payoutId: string;
  stagedPaymentId: string | null;
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

/**
 * Read the authoritative settlement link for a payout inside a transaction. The
 * caller has already SELECT...FOR UPDATE'd the payout row, which serializes every
 * confirm/revert writer, so the 1:1 link (`sl_<payoutId>`) needs no separate lock.
 * Returns null for an unmatched payout (no link); `payoutStatusFromLink` maps that
 * to `unmatched`.
 */
async function readSettlementLink(tx: Tx, payoutId: string) {
  return tx
    .select()
    .from(settlementLinks)
    .where(eq(settlementLinks.payoutId, payoutId))
    .then((r) => r[0] ?? null);
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
  const priorLink = await readSettlementLink(tx, payoutId);
  if (payoutStatusFromLink(priorLink) !== "proposed") {
    throw new TransitionError(
      "invalid_transition",
      "Only a proposed payout can be confirmed as excluded.",
    );
  }
  const depositId = priorLink?.depositStagedPaymentId ?? null;
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

  // Phase-4 authoritative write: express the confirm as the settlement link we
  // want, then reverse-derive the legacy enum + pointer columns from it. The
  // conflict gift is carried through from the prior settlement link (null in every
  // legal `proposed` state) so a stale pointer is preserved byte-identically,
  // never cleared.
  const link = confirmSettlementLink({
    depositStagedPaymentId: depositId,
    conflictGiftId: priorLink?.conflictGiftId ?? null,
    confirmedByUserId: userId,
    confirmedAt: now,
  });
  const updated = await tx
    .update(stripePayouts)
    .set({
      ...reverseSettlementLink(link),
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
  await upsertSettlementLink(tx, payoutId, link);

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
  const priorLink = await readSettlementLink(tx, payoutId);
  if (payoutStatusFromLink(priorLink) !== "conflict_approved") {
    throw new TransitionError(
      "invalid_transition",
      "Only a conflicting (already-approved) payout can be kept.",
    );
  }
  const depositId = priorLink?.depositStagedPaymentId ?? null;
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

  // Money-safety: a keep preserves the deposit's gift as the single source of
  // truth, so downstream per-charge mint guards skip it. We MUST therefore know
  // WHICH gift that is, and it must still be the gift the deposit is booked into.
  // A well-formed conflict records this at propose time
  // (qbConflictGiftId = candidateGiftId(deposit)); a null value is a
  // legacy/malformed row and a mismatch is post-propose drift — in either case
  // we cannot prove a per-charge gift wouldn't double-book it, so we refuse the
  // keep instead of risking it. This also guards the legacy standalone
  // confirm-keep route, which never passes through the bundle re-derive gate.
  const keptGiftId = priorLink?.conflictGiftId ?? null;
  if (!keptGiftId) {
    throw new TransitionError(
      "invalid_transition",
      "This conflicting payout has no recorded gift to keep. Resolve it in QuickBooks review before confirming.",
    );
  }
  if (candidateGiftId(deposit) !== keptGiftId) {
    throw new TransitionError(
      "invalid_transition",
      "The conflicting QuickBooks deposit's gift changed since this conflict was detected. Refresh and retry.",
    );
  }

  // Touch neither the deposit nor the gift — they are already terminal evidence.
  // Preserve qbConflictStagedPaymentId + qbConflictGiftId as revert/audit
  // pointers (qbConflictGiftId being set is the revert discriminator for "keep").
  // Phase-4 authoritative write: a confirmed link carrying the kept gift as its
  // discriminator. reverse-deriving it re-writes qbConflictStagedPaymentId +
  // qbConflictGiftId to (deposit, keptGiftId) — identical to the prior conflict
  // state's retained values (guarded above), so the legacy columns stay
  // byte-identical while the link becomes authoritative.
  const link = confirmSettlementLink({
    depositStagedPaymentId: depositId,
    conflictGiftId: keptGiftId,
    confirmedByUserId: userId,
    confirmedAt: now,
  });
  const updated = await tx
    .update(stripePayouts)
    .set({
      ...reverseSettlementLink(link),
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
  await upsertSettlementLink(tx, payoutId, link);

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

// ─── REVERT (confirmed_reconciled → back to proposal) ──────────────────────
// Undoes a confirm. State is DERIVED from the settlement link (Phase-6), so the
// only revertable state is D4 `confirmed_reconciled`; it routes by the link's
// conflict-gift discriminator:
//   conflictGiftId NULL → proposed          (deposit `reconciled` → `pending`)
//   conflictGiftId SET  → conflict_approved (deposit left untouched)
// Any other state has nothing to revert → invalid_transition. The retired legacy
// confirmed_excluded/keep/replace sub-states (zero in prod, unproducible by the
// authoritative writer) are not distinguishable from the link and are no longer
// handled.
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

    const priorLink = await readSettlementLink(tx, payoutId);
    const status = payoutStatusFromLink(priorLink);
    const depositId = priorLink?.depositStagedPaymentId ?? null;

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
      if (priorLink?.conflictGiftId) {
        // Phase-4 authoritative write: revert to a proposed link carrying the
        // kept gift (legacy `conflict_approved`); reverse-deriving it restores the
        // proposed + conflict pointers = (deposit, deposit, keptGift) identically.
        const link = proposeSettlementLink(depositId, priorLink.conflictGiftId);
        const updated = await tx
          .update(stripePayouts)
          .set({
            ...reverseSettlementLink(link),
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
        await upsertSettlementLink(tx, payoutId, link);
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
      // Phase-4 authoritative write: revert to a clean proposed link (no conflict
      // gift); reverse-deriving it clears the confirm/conflict pointers = the
      // legacy `proposed` state identically.
      const link = proposeSettlementLink(depositId, null);
      const updated = await tx
        .update(stripePayouts)
        .set({
          ...reverseSettlementLink(link),
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
      await upsertSettlementLink(tx, payoutId, link);
      return {
        ok: true,
        kind: "reverted",
        payoutId,
        stagedPaymentId: depositId,
      };
    }

    throw new TransitionError(
      "invalid_transition",
      "This payout is not in a confirmed state and has nothing to revert.",
    );
  });
}
