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
 *                                by payer-name patterns, by the guaranty-revenue
 *                                income account / item, AND by a "loan" / "repayment"
 *                                marker on the LINE detail (item, account name,
 *                                description, memo) — e.g. the "Loans to Schools" /
 *                                "PPP Loan Received" balance-sheet accounts and
 *                                "… Repayment" deposit lines, which carry no
 *                                loan-account payer.
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
 *   9. fiscally_sponsored      — money belonging to a separate fiscally
 *                                sponsored project (e.g. "Embracing Equity")
 *                                that the org does NOT reconcile here. A
 *                                project-IDENTITY rule: matched by a project
 *                                marker (QuickBooks Class, payer, item, account,
 *                                or memo) anywhere on the row. Because the whole
 *                                payment belongs to the other project, this rule
 *                                is NOT subject to the donation-first guard.
 *  10. insurance               — COBRA / insurance-premium reimbursements (the
 *                                "COBRA" marker on the line — e.g. "COBRA TRUST
 *                                ACCT …", "… Cobra", posted to the "Benefit
 *                                Liability" account; also the BASIC administrator's
 *                                "BASICCOBRA"). An IDENTITY rule matched by the
 *                                marker anywhere on the row; never a gift, so NOT
 *                                subject to the donation-first guard.
 *  11. expense_refund          — refunds of the org's OWN expenses (vendor
 *                                overpayments, registration / training refunds,
 *                                ERC tax refunds, etc.): money coming back, not a
 *                                contribution. A TEXT rule matched by the word
 *                                "refund" anywhere on the row. Per the user every
 *                                such record is an expense refund, so this rule is
 *                                deliberately NOT subject to the donation-first
 *                                guard (some refunds, e.g. ERC, are miscoded in
 *                                QuickBooks to a donation income account).
 *  12. expensify               — Expensify expense-reimbursement activity. Any
 *                                record whose text contains "expensify" anywhere
 *                                is categorically not a gift. A TEXT rule matched
 *                                as a substring anywhere on the row; never a gift,
 *                                so NOT subject to the donation-first guard.
 *  13. returned_wire           — a wire transfer that was returned (money sent out
 *                                that bounced back), not an incoming contribution.
 *                                A TEXT rule matched by "returned wire"
 *                                (whitespace-tolerant) anywhere on the row; never
 *                                a gift, so NOT subject to the donation-first guard.
 *
 * DONATION-FIRST GUARD: the line-based rules (loan-by-guaranty, interest,
 * tax_refund, other_revenue, earned_income) never fire on a row that ALSO carries
 * a real donation line (a Donation item or a 4000/4100-series donation account),
 * so a deposit bundling a gift with a fee / interest / refund line is never
 * wrongly hidden. The IDENTITY / TEXT rules (fiscally_sponsored, insurance,
 * expensify, returned_wire, expense_refund) intentionally BYPASS this guard —
 * they identify money that is categorically not a gift regardless of how the line
 * is coded.
 *
 * Rules are applied in a deterministic order (see `classifyStagedPayment`):
 * zero_amount → loan (payer) → government_reimbursement → fiscally_sponsored →
 * insurance → expensify → returned_wire → loan (line/memo) → loan (guaranty line)
 * → interest → tax_refund → other_revenue → earned_income → expense_refund →
 * membership. The first match wins.
 */

export type ExclusionReason =
  | "zero_amount"
  | "loan"
  | "membership"
  | "interest"
  | "government_reimbursement"
  | "tax_refund"
  | "other_revenue"
  | "earned_income"
  | "fiscally_sponsored"
  | "insurance"
  | "expense_refund"
  | "expensify"
  | "returned_wire";

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
  /**
   * Per-line free-text description (deposit line Description, CustomerMemo).
   * Folded into the memo the `other_revenue` rule reads, since for per-line
   * deposit staging the noise wording often lives on the line, not the
   * deposit-level PrivateNote. Optional for backward compatibility.
   */
  lineDescription?: string | null;
  /**
   * QuickBooks Class names captured on the txn / deposit lines. Fiscally
   * sponsored projects are tracked by Class, so the `fiscally_sponsored` rule
   * reads these. Optional for backward compatibility.
   */
  lineClasses?: string[] | null;
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
 * Loan / repayment markers found on the LINE detail (item name, posting-account
 * name, line description, memo) rather than the payer. Many school loans arrive
 * with a generic or blank payer but a telltale line: the "Loans to Schools" /
 * "Loan Funds" / "PPP Loan Received" / "Note Payable" balance-sheet accounts, a
 * "LOAN REPAYMENT" item, or a "… Repayment" deposit description. Word-anchored
 * and plural-aware ("loan"/"loans") so "Reloaning" / "loaning" can't match by
 * accident. Folded into the `loan` reason and honored only on rows WITHOUT a
 * donation line (donation-first guard), so a gift bundled with a loan reference
 * is never hidden.
 */
export const LOAN_LINE_TEXT_PATTERNS: readonly RegExp[] = [
  /\bloans?\b/i,
  /\brepayment\b/i,
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
 * Some QuickBooks exports emit these income accounts by their human NAME with no
 * leading account code (e.g. "Realized Gain/Loss on Investments", "Interest
 * Earned"), which the code-PREFIX match above can't see. Catch those by
 * case-insensitive account-NAME substring as well, so investment gain/loss and
 * bank interest are excluded whether or not QuickBooks prefixed the code.
 */
export const INTEREST_ACCOUNT_NAME_SUBSTRINGS: readonly string[] = [
  "realized gain/loss on investments",
  "interest earned",
];

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
 * FISCALLY SPONSORED PROJECT markers. Money belonging to a separate fiscally
 * sponsored project the org doesn't reconcile here. Fiscally sponsored projects
 * are tracked in QuickBooks by a Class, but the marker may also surface on the
 * payer, item, account, or memo — so the `fiscally_sponsored` rule looks for any
 * of these substrings (case-insensitive) ANYWHERE on the row. Add a project's
 * distinctive name here to exclude all of its incoming money.
 */
export const FISCALLY_SPONSORED_PROJECT_SUBSTRINGS: readonly string[] = [
  "embracing equity",
];

/**
 * INSURANCE / COBRA reimbursement markers. COBRA continuation-coverage premiums
 * the org collects and remits are never a gift. They surface with the word
 * "COBRA" somewhere on the row — e.g. "COBRA TRUST ACCT …", a "… Cobra"
 * description, or the BASIC administrator's contiguous "BASICCOBRA" token — and
 * post to the "Benefit Liability" account. An IDENTITY rule — matched as a
 * case-insensitive substring ANYWHERE on the row (payer, memo, line description,
 * item, account, Class), so it is robust to which field carries the marker.
 * "cobra" subsumes the older "basiccobra" token (it contains "cobra").
 */
export const INSURANCE_MARKER_SUBSTRINGS: readonly string[] = ["cobra"];

/**
 * EXPENSE-REFUND markers. Money refunded back to the org for its OWN expenses
 * (vendor overpayments, registration / training refunds, ERC tax refunds, etc.)
 * is not a contribution. Per the user, every record whose text contains the word
 * "refund" is an expense refund. A TEXT rule — matched ANYWHERE on the row,
 * word-START anchored (`\brefund`) so "refund / refunds / refunded" match but
 * "prefund" does not.
 */
export const EXPENSE_REFUND_TEXT_PATTERNS: readonly RegExp[] = [/\brefund/i];

/**
 * EXPENSIFY markers. Expensify is an expense-reimbursement service; any incoming
 * record whose text mentions "expensify" is reimbursement activity, never a gift.
 * A TEXT rule — matched as a case-insensitive SUBSTRING ANYWHERE on the row
 * (payer, memo, line description, item, account, Class). Identity rule, so it
 * ignores the donation-first guard.
 */
export const EXPENSIFY_MARKER_SUBSTRINGS: readonly string[] = ["expensify"];

/**
 * RETURNED-WIRE markers. A wire transfer the org SENT that bounced back is not an
 * incoming contribution. They surface with the phrase "returned wire" somewhere
 * on the row. A TEXT rule — matched ANYWHERE on the row, whitespace-tolerant
 * (`returned\s+wire`, so "returned  wire" / "RETURNED WIRE" match) but not stray
 * single tokens. Identity rule, so it ignores the donation-first guard.
 */
export const RETURNED_WIRE_TEXT_PATTERNS: readonly RegExp[] = [
  /returned\s+wire/i,
];

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
export function hasDonationLine(input: ClassifierInput): boolean {
  return (
    anyAccountCodeStartsWith(
      input.lineAccountNames,
      DONATION_ACCOUNT_CODE_PREFIXES,
    ) || anyIncludes(input.lineItemNames, DONATION_ITEM_SUBSTRINGS)
  );
}

/**
 * True if a row carries a loan / repayment marker on its LINE detail (item,
 * posting account, line description, or memo) — not the payer, which the step-2
 * payer rule already covers. Scans the same family of patterns used for the
 * payer, plural-aware, so balance-sheet loan accounts and "… Repayment" deposit
 * lines are caught. Honored only behind the donation-first guard.
 *
 * DELIBERATELY does NOT scan `lineClasses`. A QuickBooks Class is the org's own
 * categorization bucket and is NOT a safe loan marker: evaluated against real
 * prod data (2026-06-17), the only loan-bearing class that would catch the
 * reported class-only school-loan rows (the "…:Loans" bucket, e.g. the $75k
 * "Flor do Loto" deposit posted to "702 Grants to Schools") ALSO carries a
 * tracked $500k US Bank CDFI "loan_fund_investment" gift that a fundraiser
 * deliberately reconciled to an existing CRM gift. There is no class-level
 * signal that separates noise school-loan repayments from tracked loan-fund
 * investments, so auto-excluding by class would wrongly hide money the org
 * actively reviews. Class-only loan rows therefore stay a manual exclusion.
 * Full evaluation: lib/db/migrations/0043_quickbooks_loan_class_decision_RUNBOOK.md.
 * (The `fiscally_sponsored` rule DOES read classes, but only for an explicit,
 * curated project allowlist — never a broad loan-word match.)
 */
function isLoanLineOrText(input: ClassifierInput): boolean {
  if (LOAN_LINE_TEXT_PATTERNS.length === 0) return false;
  const hay = [
    input.rawReference,
    input.lineDescription ?? null,
    ...(input.lineItemNames ?? []),
    ...(input.lineAccountNames ?? []),
  ]
    .filter((s): s is string => !!s)
    .join(" ");
  return LOAN_LINE_TEXT_PATTERNS.some((re) => re.test(hay));
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
    ) ||
    anyIncludes(input.lineAccountNames, INTEREST_ACCOUNT_NAME_SUBSTRINGS) ||
    anyIncludes(input.lineItemNames, INTEREST_ITEM_SUBSTRINGS)
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
  const memo = [input.rawReference, input.lineDescription]
    .filter((s): s is string => !!s)
    .join(" ");
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
 * Every captured free-text field on a row, used by the IDENTITY / TEXT rules
 * (fiscally_sponsored, insurance, expense_refund) that scan the whole row rather
 * than a specific line account: the QuickBooks Class, payer name, item / account
 * names, line description, and memo.
 */
export function allTextFields(input: ClassifierInput): string[] {
  return [
    input.payerName,
    input.rawReference,
    input.lineDescription ?? null,
    ...(input.lineClasses ?? []),
    ...(input.lineItemNames ?? []),
    ...(input.lineAccountNames ?? []),
  ].filter((s): s is string => !!s);
}

/**
 * True if a row belongs to a fiscally sponsored project: a project marker
 * substring appears anywhere on the row. Project-identity rule, so it scans all
 * captured text (not just the line accounts) and ignores the donation-first guard.
 */
function isFiscallySponsoredProject(input: ClassifierInput): boolean {
  if (FISCALLY_SPONSORED_PROJECT_SUBSTRINGS.length === 0) return false;
  const needles = FISCALLY_SPONSORED_PROJECT_SUBSTRINGS.map(normalize);
  return allTextFields(input)
    .map(normalize)
    .some((h) => needles.some((n) => h.includes(n)));
}

/**
 * True if a row is a COBRA / insurance-premium reimbursement: an insurance
 * marker substring (e.g. "basiccobra") appears anywhere on the row. Identity
 * rule — never a gift, so it ignores the donation-first guard.
 */
function isInsuranceMarker(input: ClassifierInput): boolean {
  if (INSURANCE_MARKER_SUBSTRINGS.length === 0) return false;
  const needles = INSURANCE_MARKER_SUBSTRINGS.map(normalize);
  return allTextFields(input)
    .map(normalize)
    .some((h) => needles.some((n) => h.includes(n)));
}

/**
 * True if a row is a refund of the org's own expenses: the word "refund"
 * (word-start anchored) appears anywhere on the row. Per the user every such
 * record is an expense refund, not a contribution, so this rule ignores the
 * donation-first guard — some refunds (e.g. ERC tax refunds) are miscoded to a
 * donation income account in QuickBooks yet are still not gifts.
 */
function isExpenseRefund(input: ClassifierInput): boolean {
  if (EXPENSE_REFUND_TEXT_PATTERNS.length === 0) return false;
  const hay = allTextFields(input).join(" ");
  return EXPENSE_REFUND_TEXT_PATTERNS.some((re) => re.test(hay));
}

/**
 * True if a row is Expensify expense-reimbursement activity: the "expensify"
 * marker substring appears anywhere on the row. Identity rule — never a gift, so
 * it ignores the donation-first guard.
 */
function isExpensify(input: ClassifierInput): boolean {
  if (EXPENSIFY_MARKER_SUBSTRINGS.length === 0) return false;
  const needles = EXPENSIFY_MARKER_SUBSTRINGS.map(normalize);
  return allTextFields(input)
    .map(normalize)
    .some((h) => needles.some((n) => h.includes(n)));
}

/**
 * True if a row is a returned wire transfer: the phrase "returned wire"
 * (whitespace-tolerant) appears anywhere on the row. Identity rule — money sent
 * out that bounced back, never an incoming gift, so it ignores the donation-first
 * guard.
 */
function isReturnedWire(input: ClassifierInput): boolean {
  if (RETURNED_WIRE_TEXT_PATTERNS.length === 0) return false;
  const hay = allTextFields(input).join(" ");
  return RETURNED_WIRE_TEXT_PATTERNS.some((re) => re.test(hay));
}

/**
 * Pure noise classifier. Takes a normalized payment + its captured line detail
 * and returns whether it should be auto-excluded and why. Deterministic rule
 * order: zero_amount → loan (payer) → government_reimbursement →
 * fiscally_sponsored → insurance → expensify → returned_wire → loan (guaranty
 * line) → interest → tax_refund → other_revenue → earned_income → expense_refund →
 * membership; first match wins. The line-based rules honor the donation-first
 * guard; the identity / text rules (fiscally_sponsored, insurance, expensify,
 * returned_wire, expense_refund) intentionally bypass it.
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

  // 4. Fiscally sponsored project (e.g. "Embracing Equity"). Project-identity
  //    rule — the whole payment belongs to a separate project the org doesn't
  //    reconcile here, so it fires even on donation lines (BEFORE the donation
  //    guard) and scans every captured field (Class, payer, item, account, memo).
  if (isFiscallySponsoredProject(input)) {
    return { excluded: true, reason: "fiscally_sponsored" };
  }

  // 4b. Insurance / COBRA reimbursements (the "BASICCOBRA" marker). Identity
  //     rule — never a gift, so it fires BEFORE the donation guard and scans
  //     every captured field.
  if (isInsuranceMarker(input)) {
    return { excluded: true, reason: "insurance" };
  }

  // 4c. Expensify expense-reimbursement activity (the "expensify" marker).
  //     Identity rule — never a gift, fires BEFORE the donation guard.
  if (isExpensify(input)) {
    return { excluded: true, reason: "expensify" };
  }

  // 4d. Returned wire transfers (the "returned wire" marker): money the org sent
  //     that bounced back, not an incoming gift. Identity rule — fires BEFORE the
  //     donation guard.
  if (isReturnedWire(input)) {
    return { excluded: true, reason: "returned_wire" };
  }

  // The remaining line-based noise rules are suppressed when the row also carries
  // a real donation line, so a bundled gift is never wrongly hidden.
  const donation = hasDonationLine(input);

  // 5. Loan / repayment markers on the LINE detail (item, posting account,
  //    description, memo): the "Loans to Schools" / "PPP Loan Received" accounts,
  //    a "LOAN REPAYMENT" item, "… Repayment" deposit lines, etc. — school loan
  //    activity that arrives with a generic / blank payer.
  if (!donation && isLoanLineOrText(input)) {
    return { excluded: true, reason: "loan" };
  }

  // 6. Guaranty fees are loan activity (reason `loan`), detected on the line.
  if (!donation && isGuarantyLine(input)) {
    return { excluded: true, reason: "loan" };
  }

  // 7. Interest income.
  if (!donation && isInterestLine(input)) {
    return { excluded: true, reason: "interest" };
  }

  // 8. Tax / insurance refunds (unemployment tax, workers-comp refund, etc.).
  if (!donation && isTaxRefundLine(input)) {
    return { excluded: true, reason: "tax_refund" };
  }

  // 9. Other-Revenue (4030) clear non-gifts: credit-card rewards / bank-account
  //    activity recognised by memo. Narrow by design — see isOtherRevenueNonGift.
  if (!donation && isOtherRevenueNonGift(input)) {
    return { excluded: true, reason: "other_revenue" };
  }

  // 10. Earned income (4020 Services - Earned Income): fees-for-service, never a gift.
  if (!donation && isEarnedIncomeLine(input)) {
    return { excluded: true, reason: "earned_income" };
  }

  // 11. Expense refunds (the word "refund" anywhere on the row): money coming
  //     back, not a contribution. TEXT-identity rule — intentionally UNGUARDED
  //     (some refunds, e.g. ERC, are miscoded to a donation account yet are not
  //     gifts). Runs AFTER the specific guarded rules so a genuine tax/insurance
  //     refund keeps its more specific `tax_refund` label.
  if (isExpenseRefund(input)) {
    return { excluded: true, reason: "expense_refund" };
  }

  // 12. Membership by confirmed QB item / income-account marker.
  if (
    matchesAny(input.lineItemNames, MEMBERSHIP_ITEM_NAMES) ||
    matchesAny(input.lineAccountNames, MEMBERSHIP_ACCOUNT_NAMES)
  ) {
    return { excluded: true, reason: "membership" };
  }

  return { excluded: false, reason: null };
}
