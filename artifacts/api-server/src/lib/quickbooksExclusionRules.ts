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
 *   8. earned_income           — fees-for-service / program revenue: the 4020
 *                                "Services - Earned Income" account OR a memo /
 *                                note that names it "earned income" / "service
 *                                income". Never a gift.
 *   9. fiscally_sponsored      — LEGACY (no longer applied). Money belonging to a
 *                                fiscally sponsored Wildflower entity (e.g.
 *                                "Embracing Equity") is NO LONGER excluded — it is
 *                                attributed to its entity (`detectEntity` →
 *                                entity_id) and kept in the review queue. The enum
 *                                value is retained only for historical rows.
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
 * wrongly hidden. The IDENTITY / TEXT rules (insurance, expensify, returned_wire,
 * expense_refund) intentionally BYPASS this guard — they identify money that is
 * categorically not a gift regardless of how the line is coded.
 *
 * Rules are applied in a deterministic order (see `classifyStagedPayment`):
 * zero_amount → guaranty (payer→earned_income) → loan_repayment (payer) →
 * insurance → expensify → returned_wire → note_payable → loan_proceeds →
 * loan_repayment (line) → guaranty (line→earned_income) → interest → tax_refund →
 * other_revenue → earned_income → expense_refund → membership. The first match
 * wins. (government_reimbursement and fiscally_sponsored are NO LONGER excluded —
 * they flow into the queue; see the notes in `classifyStagedPayment`.)
 */

export type ExclusionReason =
  | "zero_amount"
  | "membership"
  | "interest"
  | "tax_refund"
  | "other_revenue"
  | "earned_income"
  | "insurance"
  | "expense_refund"
  | "expensify"
  | "returned_wire"
  | "loan_repayment"
  | "loan_proceeds"
  | "note_payable"
  | "miscoded_withdrawal"
  | "intercompany_transfer"
  | "other"
  | "processor_payout"
  // Legacy values: NO LONGER emitted by the classifier, but retained in the
  // union so historical rows + the manual exclude picker stay type-compatible.
  | "loan"
  | "government_reimbursement"
  | "fiscally_sponsored";

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
 * Payer-name patterns that mark a row as LOAN REPAYMENT activity — principal /
 * interest returning on a loan Wildflower MADE. Case-insensitive. Covers
 * loan-account payments ("Loan - Snowdrop") and repayments ("Dahlia Montessori
 * Repayment"). Word-boundary anchored so "Reloaning Co" or "Repaymental" can't
 * match by accident.
 *
 * NB the bare `\bloan\b` here is safe on the PAYER field specifically: loan-fund
 * CAPITAL investors are named foundations (e.g. "SpringPoint"), never "Loan …",
 * so this never sweeps a tracked loan-fund investment. (The LINE markers below
 * are deliberately narrowed for the same reason — see LOAN_REPAYMENT_LINE_*.)
 */
export const LOAN_REPAYMENT_PAYER_PATTERNS: readonly RegExp[] = [
  /\bloan\b/i,
  /\brepayment\b/i,
];

/**
 * Payer-name patterns marking a GUARANTY fee ("Echinacea Guaranty Fee"). Guaranty
 * fees are fee-for-service EARNED INCOME (not loan activity, not a gift), so they
 * fold into the `earned_income` reason. Payer-identity rule (never a gift).
 */
export const GUARANTY_PAYER_PATTERNS: readonly RegExp[] = [/\bguaranty\s+fee\b/i];

/**
 * LOAN REPAYMENT markers on the LINE detail (item, posting account, line
 * description, memo): principal/interest returning on loans Wildflower made.
 * DELIBERATELY NARROW — the old broad `\bloans?\b` match was retired because it
 * also swept tracked loan-FUND CAPITAL investments (money INTO the revolving loan
 * fund, which is a real gift posted to a contributions account). These specific
 * markers only catch the "Loans to Schools" asset account, an explicit "loan
 * repayment" item, or any "… Repayment" line — loan-fund capital posted to a
 * contributions account no longer matches and stays in the queue. Honored behind
 * the donation-first guard.
 */
export const LOAN_REPAYMENT_LINE_PATTERNS: readonly RegExp[] = [
  /loans to schools/i,
  /loan repayment/i,
  /\brepayment\b/i,
];

/**
 * LOAN PROCEEDS markers — borrowed funds coming IN (a liability, not income):
 * "PPP Loan Received", a "loan received" / "loan proceeds" line. Distinct from
 * repayment (money returning on loans we made) and from note_payable. Honored
 * behind the donation-first guard. Checked BEFORE loan_repayment so "PPP Loan
 * Received" lands here, not on a generic loan match.
 */
export const LOAN_PROCEEDS_LINE_PATTERNS: readonly RegExp[] = [
  /ppp loan/i,
  /loan received/i,
  /loan proceeds/i,
];

/**
 * NOTE PAYABLE markers — a liability booking on the "Note Payable(s)" balance-
 * sheet account, not a real cash gift. Honored behind the donation-first guard.
 */
export const NOTE_PAYABLE_LINE_PATTERNS: readonly RegExp[] = [
  /notes? payable/i,
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
 * GUARANTY-fee markers (folded into the `earned_income` reason — guaranty fees
 * are fee-for-service income, not loan activity and not a gift). The "Guaranty
 * Revenue" income account (code prefix) and item.
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
 * account code OR account NAME / memo phrase (see below); honors the
 * donation-first guard like the other line-based rules.
 */
export const EARNED_INCOME_ACCOUNT_CODE_PREFIXES: readonly string[] = ["4020"];
/**
 * Earned income is just as often identified by the account NAME or a free-text
 * memo as by the 4020 code. QuickBooks emits the same income account both WITH
 * and WITHOUT its leading code — "4020 Services - Earned Income" AND the bare
 * "Services - Earned Income" — so a code-prefix-only rule silently misses the
 * code-less variant (the dominant shape in the live queue); other deposits only
 * say "Service Income" / "Earned Income" in a memo / line description. Catch all
 * of these with a case-insensitive, word-anchored phrase, folded into the SAME
 * `earned_income` reason and the SAME donation-first guard. Word boundaries keep
 * "unearned income" from matching by accident. NB: the payer / customer NAME is
 * deliberately NOT matched — names like "DC Wildflower PCS - Service Revenue"
 * sit on real grants / donations. Lockstep: any change here must mirror the
 * `seed_earned_income` memo / line-description / account-name conditions in
 * quickbooksRules.ts AND the SQL backfill (TS `\b…\b` ⇄ Postgres `~* '\m…\M'`).
 */
export const EARNED_INCOME_PHRASE_PATTERNS: readonly RegExp[] = [
  /\bearned income\b/i,
  /\bservice income\b/i,
];

/**
 * ENTITY-ATTRIBUTION markers. Maps a distinctive marker substring to the
 * Wildflower legal `entities.id` (slug) the incoming money belongs to.
 *
 * Fiscally sponsored entities (e.g. "Embracing Equity") used to be auto-EXCLUDED
 * from the review queue. They no longer are: their money is now ATTRIBUTED to its
 * entity here and STAYS in the queue for a fundraiser to reconcile, surfaced via
 * the per-entity queue filter. `detectEntity` scans every captured text field
 * (Class, payer, item, account, memo) for these substrings (case-insensitive),
 * first match in declaration order wins.
 *
 * Attribution is non-destructive — a mis-attributed row is filed under the wrong
 * entity filter, never excluded — so the markers can be broader than an exclusion
 * marker. A NULL result (no marker) is treated as the default Wildflower
 * Foundation bucket by the queue filter, so the Foundation needs no marker here.
 *
 * ⚠️ BEST-GUESS markers — the dev workspace has no QuickBooks connection, so the
 * real QB Class names can't be read here. These mirror the historical
 * `fiscally_sponsored` substrings plus conservative, multi-word guesses for the
 * other entities; confirm them against production line detail and refine.
 * Deliberately NO marker for `charter` — "charter" appears in many legitimate
 * Foundation donor / school names, so auto-attributing it would mis-file real
 * gifts. Charter money is attributed manually until a safe marker is confirmed.
 *
 * Lockstep: any change here must mirror the SQL entity backfill in the migration
 * (TS substring ⇄ Postgres ILIKE '%…%' across the same text fields).
 */
export const ENTITY_MARKERS: readonly { entityId: string; markers: readonly string[] }[] = [
  { entityId: "embracing_equity", markers: ["embracing equity"] },
  { entityId: "black_wildflowers_fund", markers: ["black wildflower"] },
  { entityId: "tierra_indigena", markers: ["tierra indígena", "tierra indigena"] },
  {
    entityId: "observation_support_tech",
    markers: ["observant education", "observation support"],
  },
  { entityId: "rising_tide", markers: ["rising tide"] },
  // NOTE: "Sunlight" is intentionally NOT auto-attributed — it splits into two
  // entities (sunlight_debt / sunlight_grants) that a bare "sunlight" marker
  // can't disambiguate, so those rows stay unattributed (Foundation default) for
  // a fundraiser to file by hand. Add a disambiguating marker only once the real
  // QB Class names are confirmed against production.
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
function loanLineHaystack(input: ClassifierInput): string {
  return [
    input.rawReference,
    input.lineDescription ?? null,
    ...(input.lineItemNames ?? []),
    ...(input.lineAccountNames ?? []),
  ]
    .filter((s): s is string => !!s)
    .join(" ");
}

/** True if a row's LINE detail marks it as loan-repayment activity. */
function isLoanRepaymentLine(input: ClassifierInput): boolean {
  if (LOAN_REPAYMENT_LINE_PATTERNS.length === 0) return false;
  const hay = loanLineHaystack(input);
  return LOAN_REPAYMENT_LINE_PATTERNS.some((re) => re.test(hay));
}

/** True if a row's LINE detail marks it as loan PROCEEDS (borrowed funds in). */
function isLoanProceedsLine(input: ClassifierInput): boolean {
  if (LOAN_PROCEEDS_LINE_PATTERNS.length === 0) return false;
  const hay = loanLineHaystack(input);
  return LOAN_PROCEEDS_LINE_PATTERNS.some((re) => re.test(hay));
}

/** True if a row's LINE detail marks it as a Note Payable liability booking. */
function isNotePayableLine(input: ClassifierInput): boolean {
  if (NOTE_PAYABLE_LINE_PATTERNS.length === 0) return false;
  const hay = loanLineHaystack(input);
  return NOTE_PAYABLE_LINE_PATTERNS.some((re) => re.test(hay));
}

/**
 * True if a row is a GOVERNMENT REIMBURSEMENT (the exact "CSP" payer marker).
 * NOT an exclusion — this money flows into the review queue like any other. It is
 * a standalone detector (run alongside detectEntity / detectFundingSource at
 * ingest + reclassify); when a fundraiser records the row as a gift, the mint
 * seeds that gift's allocation with `counts_toward_goal = false` (real money, but
 * it doesn't advance the fundraising goal).
 */
export function isGovernmentReimbursement(input: ClassifierInput): boolean {
  return matchesAny(
    input.payerName ? [input.payerName] : null,
    GOVERNMENT_REIMBURSEMENT_PAYERS,
  );
}

/** True if a row matches the guaranty-fee (earned-income) markers. */
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

/**
 * True if a row is earned income / fees-for-service: coded to the "Services -
 * Earned Income" (4020) account, OR its account NAME, free-text memo, or line
 * description names it as "earned income" / "service income". Honors the
 * donation-first guard like the other line-based rules (the caller suppresses it
 * on a real donation line).
 */
function isEarnedIncomeLine(input: ClassifierInput): boolean {
  if (
    anyAccountCodeStartsWith(
      input.lineAccountNames,
      EARNED_INCOME_ACCOUNT_CODE_PREFIXES,
    )
  ) {
    return true;
  }
  const matchesPhrase = (field: string): boolean =>
    EARNED_INCOME_PHRASE_PATTERNS.some((re) => re.test(field));
  // Memo and line description are tested SEPARATELY (each is its own engine
  // condition) — a phrase split across those two fields is intentionally NOT a
  // match. Account names are tested JOINED by a space to mirror the engine's
  // regex behaviour for the multi-value line_account_name field
  // (`vals.join(" ")`) and the SQL backfill's array_to_string(...) clause. Keeps
  // the classifier ⇄ engine ⇄ SQL lockstep exact.
  if (
    [input.rawReference, input.lineDescription]
      .filter((s): s is string => !!s)
      .some(matchesPhrase)
  ) {
    return true;
  }
  const accountNames = (input.lineAccountNames ?? [])
    .filter((s): s is string => !!s)
    .join(" ");
  return accountNames.length > 0 && matchesPhrase(accountNames);
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
 * Attribute a staged payment to the Wildflower legal entity its money belongs to,
 * by scanning every captured text field (Class, payer, item, account, memo) for an
 * `ENTITY_MARKERS` substring (case-insensitive). Returns the entity slug of the
 * first marker that matches in declaration order, or null when none do (treated as
 * the default Wildflower Foundation bucket downstream).
 *
 * Pure and independent of the noise classifier — attribution is orthogonal to
 * exclusion. A row can be attributed to a fiscally sponsored entity AND still be
 * pending (or even excluded as zero_amount); entity is just a dimension on the row.
 */
export function detectEntity(input: ClassifierInput): string | null {
  const hay = allTextFields(input).map(normalize);
  if (hay.length === 0) return null;
  for (const { entityId, markers } of ENTITY_MARKERS) {
    const needles = markers.map(normalize);
    if (hay.some((h) => needles.some((n) => h.includes(n)))) return entityId;
  }
  return null;
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
 * order: zero_amount → guaranty (payer→earned_income) → loan_repayment (payer) →
 * insurance → expensify → returned_wire → note_payable → loan_proceeds →
 * loan_repayment (line) → guaranty (line→earned_income) → interest → tax_refund →
 * other_revenue → earned_income → expense_refund → membership; first match wins.
 * The line-based rules honor the donation-first guard; the identity / text rules
 * (insurance, expensify, returned_wire, expense_refund) intentionally bypass it.
 * government_reimbursement and fiscally_sponsored are NOT excluded here — they
 * flow into the queue (gov reimbursement is flagged by `isGovernmentReimbursement`
 * so its eventual gift mints with counts_toward_goal=false). Entity attribution
 * is handled separately by `detectEntity`, not here.
 */
export function classifyStagedPayment(
  input: ClassifierInput,
): ClassificationResult {
  // 1. Zero / null amount.
  const n = input.amount == null ? null : Number(input.amount);
  if (n == null || Number.isNaN(n) || n <= 0) {
    return { excluded: true, reason: "zero_amount" };
  }

  // 2. Guaranty fee by payer name → EARNED INCOME (fee-for-service, never a
  //    gift). Payer-identity rule — definitive, no donation guard. Checked before
  //    the loan-repayment payer rule (disjoint markers, but keeps intent clear).
  const payer = input.payerName ?? "";
  if (payer && GUARANTY_PAYER_PATTERNS.some((re) => re.test(payer))) {
    return { excluded: true, reason: "earned_income" };
  }

  // 3. Loan REPAYMENT by payer name (a loan account / "… Repayment" payer):
  //    principal/interest returning on a loan Wildflower made. Payer-identity.
  if (payer && LOAN_REPAYMENT_PAYER_PATTERNS.some((re) => re.test(payer))) {
    return { excluded: true, reason: "loan_repayment" };
  }

  // NOTE: GOVERNMENT REIMBURSEMENT (the "CSP" payer) is NO LONGER excluded here.
  // It is real money that flows into the queue like any other; a separate
  // `isGovernmentReimbursement` detector marks the row so the eventual gift is
  // minted with counts_toward_goal=false. (`government_reimbursement` is retained
  // as a legacy enum value for historical rows only.)
  //
  // NOTE: FISCALLY SPONSORED money is NO LONGER excluded here either. It is
  // attributed to its Wildflower entity via `detectEntity` (entity_id) and kept
  // in the review queue, surfaced via the "Fiscally-sponsored without
  // corresponding gift" worklist. (`fiscally_sponsored` is likewise legacy.)

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

  // 5a. NOTE PAYABLE liability booking ("Note Payable" account) — not real cash.
  //     Checked first so a "Note Payable" line never falls to a loan match.
  if (!donation && isNotePayableLine(input)) {
    return { excluded: true, reason: "note_payable" };
  }

  // 5b. LOAN PROCEEDS — borrowed funds in ("PPP Loan Received", "loan received").
  //     Checked before loan_repayment so "PPP Loan Received" lands here.
  if (!donation && isLoanProceedsLine(input)) {
    return { excluded: true, reason: "loan_proceeds" };
  }

  // 5c. LOAN REPAYMENT markers on the LINE detail: the "Loans to Schools" asset
  //     account, a "LOAN REPAYMENT" item, "… Repayment" deposit lines — principal
  //     / interest returning on loans Wildflower made. NARROW by design so
  //     tracked loan-FUND CAPITAL (posted to a contributions account) is NOT swept
  //     and stays in the queue.
  if (!donation && isLoanRepaymentLine(input)) {
    return { excluded: true, reason: "loan_repayment" };
  }

  // 6. Guaranty fees are EARNED INCOME (fee-for-service, never a gift), detected
  //    on the line.
  if (!donation && isGuarantyLine(input)) {
    return { excluded: true, reason: "earned_income" };
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
