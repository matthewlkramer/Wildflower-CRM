// Shared helpers for the Settlement report card-first UI.
//
// The Settlement report is Plane 1 ONLY (docs/reconciliation-design.md §4.3/§4.4):
// it confirms the payout↔deposit tie and nothing else. Per-charge → gift booking
// (Plane 2) is owned by the Gift report, so "approving" a settlement is a single
// call to the dedicated settlement-link confirm endpoint — no bundle assemble /
// derive / per-charge editor. These helpers just compute the confirm arguments and
// classify a conflict.
import type { BundleAnchor } from "@workspace/api-client-react";

/**
 * The `{ payoutId, depositStagedPaymentId }` a Resolve pick confirms. The confirm
 * endpoint is always keyed by the payout, so the direction depends on the anchor:
 *   • stripe_payout anchor      → the payout is the anchor, the pick is the deposit
 *   • qb_staged_payment anchor  → the pick is the payout, the anchor is the deposit
 */
export function resolveConfirmArgs(
  anchor: Pick<BundleAnchor, "anchorType" | "anchorId">,
  counterpartId: string,
): { payoutId: string; depositStagedPaymentId: string } {
  return anchor.anchorType === "stripe_payout"
    ? { payoutId: anchor.anchorId, depositStagedPaymentId: counterpartId }
    : { payoutId: counterpartId, depositStagedPaymentId: anchor.anchorId };
}

/** True for a 409 conflict (the tie changed under us — reload & retry). */
export function is409(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 409
  );
}
