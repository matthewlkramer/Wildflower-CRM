import { db } from "@workspace/db";
import {
  paymentApplications,
  settlementLinks,
  stagedPayments,
  stripePayouts,
} from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { candidateGiftId } from "./stripeReconcile";
import { isSettlementLump } from "./settlementLump";
import {
  payoutStatusFromLink,
  transitionSettlementLink,
} from "./settlementLink";
import {
  confirmSettlementLink,
  proposeSettlementLink,
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
 *   4. writes a guarded UPDATE on `settlement_links` (WHERE still pins the
 *      expected prior lifecycle, via `transitionSettlementLink`) as a
 *      belt-and-suspenders against the rare lost-lock case, then mirrors the
 *      legacy `stripe_payouts` columns UNGUARDED.
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
 * Write-flip complete: every gate/branch AND the optimistic-lock guard below
 * derive state from `settlement_links` (via `payoutStatusFromLink` +
 * `transitionSettlementLink`). The legacy `qb_reconciliation_status` + pointer
 * mirror columns are no longer written (the dual-write was removed) and have been
 * dropped; NO confirm/revert logic reads or guards on them. The retired legacy
 * 7-value confirmed_* sub-states (zero in prod, unproducible by the authoritative
 * writer) have no revert branch and degrade to `invalid_transition`.
 */

export type ConfirmRevertKind =
  | "confirmed_reconciled"
  // Linkage-only confirm: the QB deposit was ALREADY booked (legacy `approved`,
  // e.g. a split whose money lives in counted payment_applications rows), so the
  // confirm stamped the settlement link only and left the deposit untouched.
  | "confirmed_linkage_only"
  | "reverted";

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
  | "manual_review_required"
  // Permanent (not drift): the proposed deposit is `approved` but carries NO
  // provable booking (no counted ledger rows, no gift on any of its 3 gift-link
  // columns) — a linkage-only confirm can't prove the money is accounted for.
  | "deposit_not_booked"
  // Permanent (not drift): the proposed QB row can never back this settlement —
  // either it is not a settlement lump at all (a donor-name payment row belongs
  // at the charge grain), or it was meanwhile resolved elsewhere (excluded,
  // rejected, split, or reconciled against another payout). Retrying will never
  // succeed; the card UI renders this destructively instead of "refresh & retry".
  | "deposit_unconfirmable";

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
// processor_payout, no gift) and tied to the payout via a confirmed settlement
// link (its deposit_staged_payment_id). The money is accounted for by the
// payout's separate per-charge Stripe gifts.
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
  // Lump eligibility — the SHARED predicate the proposal pass uses
  // (settlementLump.ts): a true deposit-typed row OR a bookkeeper mis-typed
  // net lump carrying a stripe/misc signal. A donor-name payment row is NOT a
  // lump (it belongs at the charge grain) and can never back this settlement —
  // a PERMANENT rejection, not drift.
  if (!isSettlementLump(deposit)) {
    throw new TransitionError(
      "deposit_unconfirmable",
      "The proposed QuickBooks row is an individual donor payment, not a Stripe settlement lump — it can't back this settlement. Match it at the charge grain instead.",
    );
  }

  // ── Linkage-only confirm: the deposit is ALREADY booked (legacy `approved`).
  // Proposing a tie against an approved deposit is legitimate — the human still
  // wants the payout↔deposit evidence recorded — but the deposit is terminal and
  // must NOT be touched. Money-safety gate: only allow this when the deposit's
  // money is provably accounted for — a gift on one of its 3 gift-link columns,
  // or counted `payment_applications` ledger rows (the legacy-SPLIT shape, which
  // carries none of the 3 columns; mirrors the "resolved has 4 forms" predicate).
  // Otherwise there is no proof the lump was ever credited anywhere, so refuse
  // with a DISTINCT permanent error (not the generic drift message).
  if (deposit.status === "approved") {
    const linkedGiftId =
      deposit.matchedGiftId ??
      deposit.createdGiftId ??
      deposit.groupReconciledGiftId ??
      null;
    const hasCountedLedgerRows = linkedGiftId
      ? true
      : await tx
          .select({ id: paymentApplications.id })
          .from(paymentApplications)
          .where(
            and(
              eq(paymentApplications.paymentId, depositId),
              eq(paymentApplications.linkRole, "counted"),
            ),
          )
          .limit(1)
          .then((r) => r.length > 0);
    if (!linkedGiftId && !hasCountedLedgerRows) {
      throw new TransitionError(
        "deposit_not_booked",
        "This QuickBooks deposit is marked approved but has no record of where its money was booked, so the settlement can't be confirmed safely. Resolve the deposit in QuickBooks review first.",
      );
    }

    // Touch nothing but the link — the deposit stays `approved` terminal
    // evidence; its gifts already carry the money exactly once.
    const link = confirmSettlementLink({
      depositStagedPaymentId: depositId,
      conflictGiftId: priorLink?.conflictGiftId ?? null,
      confirmedByUserId: userId,
      confirmedAt: now,
    });
    const advanced = await transitionSettlementLink(
      tx,
      payoutId,
      "proposed",
      link,
    );
    if (!advanced) {
      throw new TransitionError(
        "invalid_transition",
        "This payout is no longer proposed. Refresh and retry.",
      );
    }
    return {
      ok: true,
      kind: "confirmed_linkage_only",
      payoutId,
      stagedPaymentId: depositId,
    };
  }

  if (deposit.status !== "pending") {
    // Reaches here only for excluded / rejected / reconciled (approved was
    // handled above): the row was PERMANENTLY resolved elsewhere — excluded or
    // rejected in QuickBooks review, split, or reconciled against another
    // payout. Refreshing can never make this confirmable.
    throw new TransitionError(
      "deposit_unconfirmable",
      "The proposed QuickBooks deposit was already resolved elsewhere (excluded, rejected, or reconciled), so this settlement can't be approved. Reject the proposal or pick a different deposit.",
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
  const advanced = await transitionSettlementLink(
    tx,
    payoutId,
    "proposed",
    link,
  );
  if (!advanced) {
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
  // Authoritative write: a confirmed settlement link carrying the kept gift as
  // its `conflictGiftId` — the revert-of-keep discriminator the revert path reads
  // to route a "keep" back to conflict_approved.
  const link = confirmSettlementLink({
    depositStagedPaymentId: depositId,
    conflictGiftId: keptGiftId,
    confirmedByUserId: userId,
    confirmedAt: now,
  });
  const advanced = await transitionSettlementLink(
    tx,
    payoutId,
    "conflict_approved",
    link,
  );
  if (!advanced) {
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
        // Authoritative write: revert to a proposed link carrying the kept gift
        // (legacy `conflict_approved`).
        const link = proposeSettlementLink(depositId, priorLink.conflictGiftId);
        const advanced = await transitionSettlementLink(
          tx,
          payoutId,
          "confirmed_reconciled",
          link,
        );
        if (!advanced) {
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
      // A linkage-only confirm (deposit already `approved` when confirmed) never
      // touched the deposit — revert must not touch it either (NEVER flip an
      // approved deposit to pending). Route the link back to proposed only.
      if (deposit.status === "approved") {
        const link = proposeSettlementLink(depositId, null);
        const advanced = await transitionSettlementLink(
          tx,
          payoutId,
          "confirmed_reconciled",
          link,
        );
        if (!advanced) {
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
      const advanced = await transitionSettlementLink(
        tx,
        payoutId,
        "confirmed_reconciled",
        link,
      );
      if (!advanced) {
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

    throw new TransitionError(
      "invalid_transition",
      "This payout is not in a confirmed state and has nothing to revert.",
    );
  });
}
