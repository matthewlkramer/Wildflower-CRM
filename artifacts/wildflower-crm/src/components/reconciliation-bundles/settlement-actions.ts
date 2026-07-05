// Shared approve / resolve helpers for the Settlement report card-first UI.
// Both the single-card controls and the bulk action bar drive the SAME atomic
// bundle path (assemble → optional tie derive → confirm) so approving one card
// and approving many are guaranteed to behave identically.
import type {
  BundleAnchor,
  useAssembleReconciliationBundle,
  useConfirmReconciliationBundle,
  useDeriveReconciliationBundle,
} from "@workspace/api-client-react";

type AssembleFn = ReturnType<typeof useAssembleReconciliationBundle>["mutateAsync"];
type DeriveFn = ReturnType<typeof useDeriveReconciliationBundle>["mutateAsync"];
type ConfirmFn = ReturnType<typeof useConfirmReconciliationBundle>["mutateAsync"];

export interface BundleActionFns {
  assemble: AssembleFn;
  derive: DeriveFn;
  confirm: ConfirmFn;
}

/** Outcome of an approve/resolve attempt that didn't fully book the money. */
export type ApproveOutcome = "approved" | "needs_review";

/**
 * Approve an already-proposed settlement anchor: assemble its persisted draft
 * and, when the server-derived summary is confirmable, run the atomic confirm
 * (the same double-booking-safe path the old bundle panel used). Returns
 * "needs_review" without confirming when the bundle has blockers or isn't ready,
 * so the caller can open the card for manual editing instead of forcing money.
 */
export async function approveAnchor(
  anchor: Pick<BundleAnchor, "anchorType" | "anchorId">,
  fns: BundleActionFns,
): Promise<ApproveOutcome> {
  const p = await fns.assemble({
    data: { anchorType: anchor.anchorType, anchorId: anchor.anchorId },
  });
  if (!p.summary.ready || p.summary.blockerCount > 0) return "needs_review";
  await fns.confirm({
    draftId: p.draftId,
    data: { expectedRevision: p.revision, allowWarnings: p.summary.warningCount > 0 },
  });
  return "approved";
}

/**
 * Resolve an anchor against a chosen counterpart, then approve. The payout is
 * always the canonical bundle anchor, so we assemble the payout, override its
 * tie to the chosen deposit (via /derive, persisted on the draft), and confirm
 * when ready. Works in both directions:
 *   • stripe_payout anchor  → counterpart is the QB deposit
 *   • qb_staged_payment anchor → counterpart is the Stripe payout
 * Returns the resolved payout id so the caller can open THAT anchor's card for
 * review when the bundle still needs manual attention.
 */
export async function resolveAndApprove(
  anchor: Pick<BundleAnchor, "anchorType" | "anchorId">,
  counterpartId: string,
  fns: BundleActionFns,
): Promise<{ outcome: ApproveOutcome; payoutId: string }> {
  const payoutId =
    anchor.anchorType === "stripe_payout" ? anchor.anchorId : counterpartId;
  const depositId =
    anchor.anchorType === "stripe_payout" ? counterpartId : anchor.anchorId;

  let p = await fns.assemble({
    data: { anchorType: "stripe_payout", anchorId: payoutId },
  });
  p = await fns.derive({
    draftId: p.draftId,
    data: { tie: { depositStagedPaymentId: depositId } },
  });
  if (p.summary.ready && p.summary.blockerCount === 0) {
    await fns.confirm({
      draftId: p.draftId,
      data: { expectedRevision: p.revision, allowWarnings: p.summary.warningCount > 0 },
    });
    return { outcome: "approved", payoutId };
  }
  return { outcome: "needs_review", payoutId };
}

/** True for a 409 conflict (the bundle changed under us — reload & retry). */
export function is409(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 409
  );
}
