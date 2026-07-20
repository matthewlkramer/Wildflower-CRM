import { type Request, type Response } from "express";
import { getAppUser } from "./appRequest";

// ─── Finance-role guard (workbench business rules §6.2 / §7.3) ──────────────
// Only finance-team members (or admins — admin ⊇ finance) may create, confirm,
// remove, replace, or unmatch ACCOUNTING relationships, or change QuickBooks
// treatment. Enforced-endpoint inventory (keep in sync when adding routes):
//
//   Settlement links (payout ↔ QB deposit):
//     POST /reconciliation/settlement-links/:payoutId/confirm
//     POST /reconciliation/settlement-links/:payoutId/reject
//     POST /reconciliation/bundle-proposals/:draftId/confirm
//     POST /reconciliation/bundles/:stagedPaymentId/confirm-ties
//     POST /stripe-payouts/:id/confirm-exclude
//     POST /stripe-payouts/:id/confirm-keep
//     POST /stripe-payouts/:id/confirm-replace
//     POST /stripe-payouts/:id/revert-reconciliation
//   Charge ↔ QB ties:
//     POST /reconciliation/payouts/:payoutId/charge-ties/confirm
//     POST /reconciliation/charges/:chargeId/qb-tie/reject
//     POST /reconciliation/charges/:chargeId/qb-tie/revert
//   QuickBooks treatment on staged payments:
//     POST /quickbooks/staged-payments/:id/exclude
//     POST /quickbooks/staged-payments/:id/re-include
//     POST /quickbooks/staged-payments/:id/set-coding
//     POST /quickbooks/staged-payments/group
//     POST /quickbooks/staged-payments/ungroup
//
// Deliberately OPEN to all team members (§7.3 non-finance list): donor
// identification (resolve / set-entity / set-funding-source), gift create &
// link/unmatch on the CRM side (reconcile, approve, create-gift, link-gift,
// unmatch, revert), Stripe-charge evidence review (exclude / re-include /
// refund flags), Donorbox review, bundle-proposal drafting (create / derive
// — proposing is open; confirming is not), and all reads.

export const FINANCE_REQUIRED_ERROR = "finance_role_required" as const;

export function viewerCanManageAccounting(req: Request): boolean {
  const me = getAppUser(req);
  return me?.role === "finance" || me?.role === "admin";
}

/**
 * Returns true when the caller may proceed; otherwise writes a structured 403
 * with a machine-readable reason code and returns false.
 */
export function requireFinance(req: Request, res: Response): boolean {
  if (viewerCanManageAccounting(req)) return true;
  res.status(403).json({
    error: FINANCE_REQUIRED_ERROR,
    message:
      "Only finance-team members can change accounting relationships or QuickBooks treatment.",
  });
  return false;
}
