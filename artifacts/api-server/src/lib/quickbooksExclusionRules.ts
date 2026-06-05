/**
 * Central, code-owned rules for auto-excluding "noise" QuickBooks payments from
 * the review queue. There is intentionally NO user-editable rules admin UI:
 * refining these values is a deliberate code change, reviewed like any other.
 *
 * Several kinds of incoming-money records a fundraiser never wants to turn into a
 * gift are filtered out (marked `excluded`, never deleted, always auditable):
 *
 *   1. zero_amount             — amount is null or <= 0.
 *   2. loan                    — school loan activity. Per the user, the only
 *                                incoming money from our schools is loans or
 *                                membership fees; loans show up as a loan-account
 *                                payer plus repayments and guaranty fees. Detected
 *                                by payer-name patterns AND by the guaranty-revenue
 *                                income account / item on the line detail.
 *   3. government_reimbursement — government grant reimbursements. Detected by an
 *                                exact payer name (e.g. "CSP").
 *   4. interest                — bank / investment income. Detected by the
 *                                "Interest Earned" (4010) and "Realized Gain/Loss
 *                                on Investments" (4040) income accounts / the
 *                                "INTEREST" line item.
 *   5. tax_refund              — payroll-tax, tax and insurance refunds
 *                                (unemployment tax, workers-comp refund, tax
 *                                liability, ERC, etc.). Detected by the expense
 *                                account the refund posts back to (payroll taxes /
 *                                taxes / insurance).
 *   6. membership              — school membership dues. Detected by the REAL
 *                                QuickBooks marker (the Product/Service item and/or
 *                                income account on the transaction's — or, for
 *                                invoice-applied Payments, the linked Invoice's —
 *                                line), NOT by a school-name heuristic.
 *   7. other_revenue           — clear non-gifts posted to Other Revenue (4030):
 *                                credit-card rewards / bank-account activity
 *                                (matched by memo).
 *   8. earned_income           — fees-for-service / program revenue (4020
 *                                "Services - Earned Income"). Never a gift.
 *
 * DONATION-FIRST GUARD: the line-based rules (loan-by-guaranty, interest,
 * tax_refund) never fire on a row that ALSO carries a real donation line (a
 * Donation item or a 4000/4100-series donation account), so a deposit bundling a
 * gift with a fee / interest / refund line is never wrongly hidden.
 *
 * Rules are applied in a deterministic order (see `classifyStagedPayment`):
 * zero_amount → loan (payer) → government_reimbursement → loan (guaranty line) →
 * interest → tax_refund → other_revenue → earned_income → membership. The first
 * match wins.
 */

export type ExclusionReason =
  | "zero_amount"
  | "loan"
  | "membership"
  | "interest"
  | "government_reimbursement"
  | "tax_refund"
  | "other_revenue"
  | "earned_income";

export interface ClassifierInput {
  amount: string | null;
  payerName: string | null;
  /** QB Product/Service item names from the txn / linked-invoice lines. */
  lineItemNames: string[] | null;
  /** Income / posting account names from the txn / linked-invoice lines. */
  lineAccountNames: string[] | null;
  /**
   * Free-text memo / reference captured on the staged payment (PrivateNote,
   * deposit-account name, etc.). Used only by the narrow `other_revenue` rule
   * to recognise clear non-gift Other-Revenue noise (credit-card rewards,
   * bank-account activity) by their memo wording.
   */
  rawReference: string | null;
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
  // Confirmed in production: member Montessori schools pay their network
  // membership dues under the QuickBooks Product/Service item "School
  // Contributions" (recurring payments from each member school).
  "School Contributions",
];
export const MEMBERSHIP_ACCOUNT_NAMES: readonly string[] = [
  // No income/posting-account marker is needed — membership is identified by
  // the "School Contributions" line item above. Add account names here only if
  // a future membership coding can't be distinguished by item alone.
];

/**
 * Exact payer names (case-insensitive) whose incoming money is a GOVERNMENT
 * REIMBURSEMENT, not a gift. Confirmed in production: the funder "CSP" (a
 * government program) reimburses the org; every CSP payment is excluded.
 */
export const GOVERNMENT_REIMBURSEMENT_PAYERS: readonly string[] = ["CSP"];

/**
 * INTEREST / investment-income markers — the "Interest Earned" (4010) and
 * "Realized Gain/Loss on Investments" (4040) income accounts (matched by the
 * leading QuickBooks account-code prefix, robust to description edits) and the
 * "INTEREST" line item. Both are non-gift investment income, grouped under the
 * single `interest` reason (4040 deposits carry an "Interest Earned" memo).
 */
export const INTEREST_ACCOUNT_CODE_PREFIXES: readonly string[] = [
  "4010",
  "4040",
];
export const INTEREST_ITEM_SUBSTRINGS: readonly string[] = ["interest"];

/**
 * GUARANTY-fee markers (folded into the `loan` reason — guaranty fees are loan
 * activity). The "Guaranty Revenue" income account (code prefix) and item.
 */
export const GUARANTY_ACCOUNT_CODE_PREFIXES: readonly string[] = ["4102"];
export const GUARANTY_ITEM_SUBSTRINGS: readonly string[] = ["guaranty"];

/**
 * TAX / INSURANCE-refund markers. Refunds (unemployment tax, workers-comp,
 * tax liability, ERC, etc.) post back to the expense account they came from;
 * matched by that account's QuickBooks code prefix (payroll taxes / taxes /
 * insurance). Grouped under one `tax_refund` reason.
 */
export const TAX_REFUND_ACCOUNT_CODE_PREFIXES: readonly string[] = [
  "7010.4", // Payroll:3.Benefits:Payroll Taxes
  "7020", // All Other Expenditures:Taxes
  "7006", // All Other Expenditures:Insurance
];

/**
 * OTHER-REVENUE non-gift markers. The "Other Revenue" income account (code
 * prefix 4030) is a grab-bag bucket: mostly non-gift noise (credit-card
 * rewards, bank-account activity), but a real donation is occasionally
 * miscoded here. Per the user's decision we exclude ONLY the clear non-gifts —
 * a row posted to 4030 whose memo reads like credit-card rewards or a
 * bank-account transfer — and leave everything else (legal settlements,
 * refunds, unidentified deposits, miscoded gifts) in the queue to review.
 * Matched on the memo so the narrow, well-understood cases are removed without
 * blanket-hiding the bucket.
 */
export const OTHER_REVENUE_ACCOUNT_CODE_PREFIXES: readonly string[] = ["4030"];
export const OTHER_REVENUE_NONGIFT_MEMO_PATTERNS: readonly RegExp[] = [
  /\brewards?\b/i, // "Credit card rewards", "WF rewards", "Wells Rewards"
  /\bbusiness checking\b/i, // "BUSINESS CHECKING (XXXXXX 8945)" bank activity
];

/**
 * EARNED-INCOME markers — the "Services - Earned Income" income account (code
 * prefix 4020). Fees-for-service / program revenue, never a gift. Matched by
 * account code; honors the donation-first guard like the other line-based rules.
 */
export const EARNED_INCOME_ACCOUNT_CODE_PREFIXES: readonly string[] = ["4020"];

/**
 * DONATION-line markers used by the donation-first guard: a Donation item or a
 * 4000/4100-series donation income account. When present, the line-based noise
 * rules are suppressed so a bundled gift is never hidden.
 */
export const DONATION_ACCOUNT_CODE_PREFIXES: readonly string[] = [
  "4000",
  "4100",
];
export const DONATION_ITEM_SUBSTRINGS: readonly string[] = ["donation"];

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

/** True if any account name starts with one of the QB account-code prefixes. */
function anyAccountCodeStartsWith(
  accounts: string[] | null,
  prefixes: readonly string[],
): boolean {
  if (!accounts || accounts.length === 0 || prefixes.length === 0) return false;
  const wanted = prefixes.map(normalize);
  return accounts.some((a) => {
    const code = normalize(a);
    return wanted.some((p) => code.startsWith(p));
  });
}

/** True if any value contains one of the (case-insensitive) substrings. */
function anyIncludes(
  values: string[] | null,
  needles: readonly string[],
): boolean {
  if (!values || values.length === 0 || needles.length === 0) return false;
  const wanted = needles.map(normalize);
  return values.some((v) => {
    const hay = normalize(v);
    return wanted.some((needle) => hay.includes(needle));
  });
}

/** True if a row carries a real donation line (donation-first guard). */
function hasDonationLine(input: ClassifierInput): boolean {
  return (
    anyAccountCodeStartsWith(
      input.lineAccountNames,
      DONATION_ACCOUNT_CODE_PREFIXES,
    ) || anyIncludes(input.lineItemNames, DONATION_ITEM_SUBSTRINGS)
  );
}

/** True if a row matches the guaranty-fee (loan) markers. */
function isGuarantyLine(input: ClassifierInput): boolean {
  return (
    anyAccountCodeStartsWith(
      input.lineAccountNames,
      GUARANTY_ACCOUNT_CODE_PREFIXES,
    ) || anyIncludes(input.lineItemNames, GUARANTY_ITEM_SUBSTRINGS)
  );
}

/** True if a row matches the interest-income markers. */
function isInterestLine(input: ClassifierInput): boolean {
  return (
    anyAccountCodeStartsWith(
      input.lineAccountNames,
      INTEREST_ACCOUNT_CODE_PREFIXES,
    ) || anyIncludes(input.lineItemNames, INTEREST_ITEM_SUBSTRINGS)
  );
}

/** True if a row matches the tax / insurance-refund markers. */
function isTaxRefundLine(input: ClassifierInput): boolean {
  return anyAccountCodeStartsWith(
    input.lineAccountNames,
    TAX_REFUND_ACCOUNT_CODE_PREFIXES,
  );
}

/**
 * True for a clear non-gift posted to the Other-Revenue (4030) account: the row
 * is coded to 4030 AND its memo reads like credit-card rewards or bank-account
 * activity. Deliberately narrow — anything else coded to 4030 stays in the queue.
 */
function isOtherRevenueNonGift(input: ClassifierInput): boolean {
  if (
    !anyAccountCodeStartsWith(
      input.lineAccountNames,
      OTHER_REVENUE_ACCOUNT_CODE_PREFIXES,
    )
  ) {
    return false;
  }
  const memo = input.rawReference ?? "";
  return OTHER_REVENUE_NONGIFT_MEMO_PATTERNS.some((re) => re.test(memo));
}

/** True if a row is coded to the "Services - Earned Income" (4020) account. */
function isEarnedIncomeLine(input: ClassifierInput): boolean {
  return anyAccountCodeStartsWith(
    input.lineAccountNames,
    EARNED_INCOME_ACCOUNT_CODE_PREFIXES,
  );
}

/**
 * Pure noise classifier. Takes a normalized payment + its captured line detail
 * and returns whether it should be auto-excluded and why. Deterministic rule
 * order: zero_amount → loan (payer) → government_reimbursement →
 * loan (guaranty line) → interest → tax_refund → other_revenue →
 * earned_income → membership; first match wins.
 * The line-based rules honor the donation-first guard.
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

  // 3. Government reimbursement by exact payer name (e.g. "CSP"). Payer-identity
  //    rule — definitive, no donation guard.
  if (
    matchesAny(
      input.payerName ? [input.payerName] : null,
      GOVERNMENT_REIMBURSEMENT_PAYERS,
    )
  ) {
    return { excluded: true, reason: "government_reimbursement" };
  }

  // The remaining line-based noise rules are suppressed when the row also carries
  // a real donation line, so a bundled gift is never wrongly hidden.
  const donation = hasDonationLine(input);

  // 4. Guaranty fees are loan activity (reason `loan`), detected on the line.
  if (!donation && isGuarantyLine(input)) {
    return { excluded: true, reason: "loan" };
  }

  // 5. Interest income.
  if (!donation && isInterestLine(input)) {
    return { excluded: true, reason: "interest" };
  }

  // 6. Tax / insurance refunds (unemployment tax, workers-comp refund, etc.).
  if (!donation && isTaxRefundLine(input)) {
    return { excluded: true, reason: "tax_refund" };
  }

  // 7. Other-Revenue (4030) clear non-gifts: credit-card rewards / bank-account
  //    activity recognised by memo. Narrow by design — see isOtherRevenueNonGift.
  if (!donation && isOtherRevenueNonGift(input)) {
    return { excluded: true, reason: "other_revenue" };
  }

  // 8. Earned income (4020 Services - Earned Income): fees-for-service, never a gift.
  if (!donation && isEarnedIncomeLine(input)) {
    return { excluded: true, reason: "earned_income" };
  }

  // 9. Membership by confirmed QB item / income-account marker.
  if (
    matchesAny(input.lineItemNames, MEMBERSHIP_ITEM_NAMES) ||
    matchesAny(input.lineAccountNames, MEMBERSHIP_ACCOUNT_NAMES)
  ) {
    return { excluded: true, reason: "membership" };
  }

  return { excluded: false, reason: null };
}
