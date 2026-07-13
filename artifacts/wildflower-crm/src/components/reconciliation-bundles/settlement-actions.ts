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

/**
 * The machine-readable `error` code from an ApiError's parsed 409 body
 * (`{ error, message }`), or null. Not every 409 is transient drift: the
 * confirm endpoint returns `deposit_not_booked` (an approved deposit with no
 * provable booking) and `deposit_unconfirmable` (the QB row can never back a
 * settlement — not a lump, or resolved elsewhere) as PERMANENT rejections,
 * which must not be presented as "the settlement changed — try again".
 */
export function apiErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const code = (data as { error?: unknown }).error;
  return typeof code === "string" ? code : null;
}

/**
 * True when a 409's error code marks a PERMANENT rejection — retrying can
 * never succeed, so the card renders a destructive "couldn't approve" toast
 * instead of the transient "changed — refreshed" drift toast.
 */
export function isPermanentSettlementError(err: unknown): boolean {
  const code = apiErrorCode(err);
  return code === "deposit_not_booked" || code === "deposit_unconfirmable";
}

/** The human-readable `message` from an ApiError's parsed body, or null. */
export function apiErrorMessage(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const message = (data as { message?: unknown }).message;
  return typeof message === "string" && message.trim() !== "" ? message : null;
}
