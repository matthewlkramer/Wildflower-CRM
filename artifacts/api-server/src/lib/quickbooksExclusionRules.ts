/**
 * Central, code-owned rules for auto-excluding "noise" QuickBooks payments from
 * the review queue. There is intentionally NO user-editable rules admin UI:
 * refining these values is a deliberate code change, reviewed like any other.
 *
 * Three kinds of incoming-money records a fundraiser never wants to turn into a
 * gift are filtered out (marked `excluded`, never deleted, always auditable):
 *
 *   1. zero_amount — amount is null or <= 0.
 *   2. loan        — school loan activity. Per the user, the only incoming money
 *                    from our schools is loans or membership fees; loans show up
 *                    as a loan account payer plus repayments and guaranty fees.
 *                    Detected by payer-name patterns.
 *   3. membership  — school membership dues. Detected by the REAL QuickBooks
 *                    marker (the Product/Service item and/or income account on
 *                    the transaction's — or, for invoice-applied Payments, the
 *                    linked Invoice's — line), NOT by a school-name heuristic.
 *
 * Rules are applied in a deterministic order (see `classifyStagedPayment`):
 * zero_amount → loan → membership. The first match wins.
 */

export type ExclusionReason = "zero_amount" | "loan" | "membership";

export interface ClassifierInput {
  amount: string | null;
  payerName: string | null;
  /** QB Product/Service item names from the txn / linked-invoice lines. */
  lineItemNames: string[] | null;
  /** Income / posting account names from the txn / linked-invoice lines. */
  lineAccountNames: string[] | null;
}

export interface ClassificationResult {
  excluded: boolean;
  reason: ExclusionReason | null;
}

/**
 * Payer-name patterns that mark a row as school LOAN activity. Case-insensitive.
 * Covers loan-account payments ("Loan - Snowdrop"), repayments
 * ("Dahlia Montessori Repayment") and guaranty fees ("Echinacea Guaranty Fee").
 * Word-boundary anchored so e.g. "Reloaning Co" or an unrelated "Repaymental"
 * token cannot match by accident.
 */
export const LOAN_PAYER_PATTERNS: readonly RegExp[] = [
  /\bloan\b/i,
  /\brepayment\b/i,
  /\bguaranty\s+fee\b/i,
];

/**
 * Confirmed QuickBooks MEMBERSHIP markers. A staged payment is excluded as
 * `membership` when any of its line item names OR income/posting account names
 * matches an entry here (case-insensitive, exact after trim).
 *
 * ⚠️ DISCOVERY REQUIRED — these must be confirmed against PRODUCTION data.
 * The dev workspace has no QuickBooks connection and the live token is encrypted
 * with the production SESSION_SECRET, so the real item/account coding can only be
 * read from the deployed environment. Until the marker is confirmed and added
 * here, the membership rule is INERT (it excludes nothing) — which is the safe
 * default: we never want to wrongly hide a real gift.
 *
 * To confirm: deploy this feature, run a read-only re-pull in production so the
 * staged rows are enriched with line detail, then inspect the distinct items /
 * income accounts appearing on real school payments (see the discovery query in
 * lib/db/migrations/0012-0013_quickbooks_exclusions_RUNBOOK.md). Add the exact
 * name(s) below and record the finding in that runbook.
 */
export const MEMBERSHIP_ITEM_NAMES: readonly string[] = [
  // e.g. "Membership Fee", "School Membership Dues" — TODO: confirm in prod.
];
export const MEMBERSHIP_ACCOUNT_NAMES: readonly string[] = [
  // e.g. "Membership Income", "Member Dues" — TODO: confirm in prod.
];

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function matchesAny(
  values: string[] | null,
  markers: readonly string[],
): boolean {
  if (!values || values.length === 0 || markers.length === 0) return false;
  const wanted = new Set(markers.map(normalize));
  return values.some((v) => wanted.has(normalize(v)));
}

/**
 * Pure noise classifier. Takes a normalized payment + its captured line detail
 * and returns whether it should be auto-excluded and why. Deterministic rule
 * order: zero_amount → loan → membership; first match wins.
 */
export function classifyStagedPayment(
  input: ClassifierInput,
): ClassificationResult {
  // 1. Zero / null amount.
  const n = input.amount == null ? null : Number(input.amount);
  if (n == null || Number.isNaN(n) || n <= 0) {
    return { excluded: true, reason: "zero_amount" };
  }

  // 2. Loan activity by payer name.
  const payer = input.payerName ?? "";
  if (payer && LOAN_PAYER_PATTERNS.some((re) => re.test(payer))) {
    return { excluded: true, reason: "loan" };
  }

  // 3. Membership by confirmed QB item / income-account marker.
  if (
    matchesAny(input.lineItemNames, MEMBERSHIP_ITEM_NAMES) ||
    matchesAny(input.lineAccountNames, MEMBERSHIP_ACCOUNT_NAMES)
  ) {
    return { excluded: true, reason: "membership" };
  }

  return { excluded: false, reason: null };
}
