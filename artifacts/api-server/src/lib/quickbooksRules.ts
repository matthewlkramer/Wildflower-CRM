import {
  type ClassifierInput,
  type ExclusionReason,
  hasDonationLine,
  allTextFields,
} from "./quickbooksExclusionRules";

/**
 * Admin-editable QuickBooks handling-rule ENGINE.
 *
 * The hardcoded `classifyStagedPayment` classifier (quickbooksExclusionRules.ts)
 * stays intact and still drives the manual `reclassifyStagedPayments` maintenance
 * path. This engine is the INGEST-time replacement: the `quickbooks_handling_rules`
 * table is seeded (see SEED_RULES) to reproduce the classifier exactly, and admins
 * can then add / edit / reorder rules without a code change. Rule edits affect only
 * NEW incoming payments.
 *
 * A `fidelity` test asserts `evaluateRules(SEED_RULES)` agrees with
 * `classifyStagedPayment` over a representative fixture set, so the seed can never
 * silently diverge from today's behavior.
 */

export const RULE_CONDITION_FIELDS = [
  "payer_name",
  "line_item_name",
  "line_account_name",
  "memo_reference",
  "line_description",
  "qb_class",
  "any_text",
  "amount",
] as const;
export type RuleConditionField = (typeof RULE_CONDITION_FIELDS)[number];

export const RULE_CONDITION_MODES = [
  "contains",
  "exact",
  "prefix",
  "regex",
  "lte",
] as const;
export type RuleConditionMode = (typeof RULE_CONDITION_MODES)[number];

export interface RuleCondition {
  field: RuleConditionField;
  mode: RuleConditionMode;
  value: string;
}

export const RULE_MATCH_LOGICS = ["any", "all"] as const;
export type RuleMatchLogic = (typeof RULE_MATCH_LOGICS)[number];

export const RULE_ACTIONS = ["exclude", "auto_create_approve"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

/**
 * Engine-shaped rule (the subset of the DB row the evaluator reads). The DB row
 * carries the same fields plus name / timestamps.
 */
export interface EngineRule {
  id: string;
  enabled: boolean;
  priority: number;
  action: RuleAction;
  exclusionReason: ExclusionReason | null;
  donationGuard: boolean;
  matchLogic: RuleMatchLogic;
  conditions: RuleCondition[];
  targetOrganizationId: string | null;
  targetIntendedUsage: string | null;
  targetFundableProjectId: string | null;
}

export type RuleEvalResult =
  | { action: "exclude"; reason: ExclusionReason; ruleId: string; ruleName?: string }
  | {
      action: "auto_create_approve";
      ruleId: string;
      ruleName?: string;
      targetOrganizationId: string | null;
      targetIntendedUsage: string | null;
      targetFundableProjectId: string | null;
    };

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** Raw (un-normalized) values captured for a condition field. */
function fieldValues(input: ClassifierInput, field: RuleConditionField): string[] {
  switch (field) {
    case "payer_name":
      return input.payerName ? [input.payerName] : [];
    case "line_item_name":
      return (input.lineItemNames ?? []).filter((s): s is string => !!s);
    case "line_account_name":
      return (input.lineAccountNames ?? []).filter((s): s is string => !!s);
    case "memo_reference":
      return input.rawReference ? [input.rawReference] : [];
    case "line_description":
      return input.lineDescription ? [input.lineDescription] : [];
    case "qb_class":
      return (input.lineClasses ?? []).filter((s): s is string => !!s);
    case "any_text":
      return allTextFields(input);
    case "amount":
      return input.amount != null ? [input.amount] : [];
  }
}

/**
 * Evaluate one condition against the payment.
 *
 * - `lte` (amount only): a null / unparseable amount MATCHES (mirrors the
 *   classifier treating null / "n/a" / <=0 as zero_amount); otherwise numeric <=.
 * - `regex`: tested case-insensitively against the field's RAW values joined by a
 *   space — mirrors the classifier's `…join(" ")` text rules. An invalid pattern
 *   never matches.
 * - `contains` / `exact` / `prefix`: tested per-value on normalized
 *   (trim+lowercase) strings, matching the classifier's `matchesAny` /
 *   `anyIncludes` helpers.
 */
function conditionMatches(input: ClassifierInput, cond: RuleCondition): boolean {
  if (cond.mode === "lte") {
    const raw = input.amount;
    if (raw == null) return true;
    const n = Number(raw);
    if (Number.isNaN(n)) return true;
    return n <= Number(cond.value);
  }

  const vals = fieldValues(input, cond.field);
  if (vals.length === 0) return false;

  if (cond.mode === "regex") {
    let re: RegExp;
    try {
      re = new RegExp(cond.value, "i");
    } catch {
      return false;
    }
    return re.test(vals.join(" "));
  }

  const needle = normalize(cond.value);
  return vals.some((v) => {
    const hay = normalize(v);
    if (cond.mode === "exact") return hay === needle;
    if (cond.mode === "prefix") return hay.startsWith(needle);
    return hay.includes(needle); // contains
  });
}

function ruleMatches(
  input: ClassifierInput,
  rule: EngineRule,
  donationLine: boolean,
): boolean {
  // Donation-first guard: a guarded rule never fires on a row that also carries a
  // real donation line, so a bundled gift is never wrongly hidden.
  if (rule.donationGuard && donationLine) return false;
  if (rule.conditions.length === 0) return false;
  const test = (c: RuleCondition) => conditionMatches(input, c);
  return rule.matchLogic === "all"
    ? rule.conditions.every(test)
    : rule.conditions.some(test);
}

/**
 * Run the editable rule set against a staged payment. Rules are evaluated in
 * ascending `priority` order; the FIRST enabled rule that matches wins (mirrors
 * the deterministic classifier order). Returns null when nothing matches.
 */
export function evaluateRules(
  rules: EngineRule[],
  input: ClassifierInput,
): RuleEvalResult | null {
  const donationLine = hasDonationLine(input);
  const ordered = rules
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority);

  for (const rule of ordered) {
    if (!ruleMatches(input, rule, donationLine)) continue;
    if (rule.action === "exclude") {
      // A misconfigured exclude rule with no reason is treated as a no-op so it
      // can never silently drop a payment with a null reason.
      if (!rule.exclusionReason) continue;
      return { action: "exclude", reason: rule.exclusionReason, ruleId: rule.id };
    }
    return {
      action: "auto_create_approve",
      ruleId: rule.id,
      targetOrganizationId: rule.targetOrganizationId,
      targetIntendedUsage: rule.targetIntendedUsage,
      targetFundableProjectId: rule.targetFundableProjectId,
    };
  }
  return null;
}

const G = true; // donationGuard on
const N = false; // donationGuard off

/**
 * Canonical seed — reproduces `classifyStagedPayment` exactly for the INGEST path,
 * plus the first `auto_create_approve` rule (AmazonSmile). Evaluation order is the
 * deterministic classifier order, encoded as ascending `priority` (steps of 10 so
 * future rules can slot between). `targetOrganizationId` for AmazonSmile is
 * resolved by name at seed time (migration / seed helper), so it is null here.
 *
 * Lockstep: this is the source of truth for the migration seed SQL and the
 * fidelity test. Any classifier change must be mirrored here AND in the migration.
 */
export const SEED_RULES: EngineRule[] = [
  {
    id: "seed_zero_amount",
    enabled: true,
    priority: 10,
    action: "exclude",
    exclusionReason: "zero_amount",
    donationGuard: N,
    matchLogic: "any",
    conditions: [{ field: "amount", mode: "lte", value: "0" }],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_amazonsmile",
    enabled: true,
    priority: 20,
    action: "auto_create_approve",
    exclusionReason: null,
    donationGuard: N,
    matchLogic: "any",
    // Matches the program's markers anywhere on the row: the payer "Amazon Smile"
    // (a space), the contiguous "AmazonSmile" token, and the remittance memo token
    // "AmazonSmil" (no trailing 'e', e.g. "… AmazonSmil 2303 …"), which covers
    // rows whose payer is blank. Mirrors the historical 0035 backfill markers.
    conditions: [{ field: "any_text", mode: "regex", value: "amazon\\s*smil" }],
    targetOrganizationId: null,
    targetIntendedUsage: "gen_ops",
    targetFundableProjectId: null,
  },
  {
    id: "seed_loan_payer",
    enabled: true,
    priority: 30,
    action: "exclude",
    exclusionReason: "loan",
    donationGuard: N,
    matchLogic: "any",
    conditions: [
      { field: "payer_name", mode: "regex", value: "\\bloan\\b" },
      { field: "payer_name", mode: "regex", value: "\\brepayment\\b" },
      { field: "payer_name", mode: "regex", value: "\\bguaranty\\s+fee\\b" },
    ],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_government_reimbursement",
    enabled: true,
    priority: 40,
    action: "exclude",
    exclusionReason: "government_reimbursement",
    donationGuard: N,
    matchLogic: "any",
    conditions: [{ field: "payer_name", mode: "exact", value: "CSP" }],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_fiscally_sponsored",
    enabled: true,
    priority: 50,
    action: "exclude",
    exclusionReason: "fiscally_sponsored",
    donationGuard: N,
    matchLogic: "any",
    conditions: [
      { field: "any_text", mode: "contains", value: "embracing equity" },
    ],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_insurance",
    enabled: true,
    priority: 60,
    action: "exclude",
    exclusionReason: "insurance",
    donationGuard: N,
    matchLogic: "any",
    conditions: [{ field: "any_text", mode: "contains", value: "cobra" }],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_expensify",
    enabled: true,
    priority: 70,
    action: "exclude",
    exclusionReason: "expensify",
    donationGuard: N,
    matchLogic: "any",
    conditions: [{ field: "any_text", mode: "contains", value: "expensify" }],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_returned_wire",
    enabled: true,
    priority: 80,
    action: "exclude",
    exclusionReason: "returned_wire",
    donationGuard: N,
    matchLogic: "any",
    conditions: [
      { field: "any_text", mode: "regex", value: "returned\\s+wire" },
    ],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_loan_line",
    enabled: true,
    priority: 90,
    action: "exclude",
    exclusionReason: "loan",
    donationGuard: G,
    matchLogic: "any",
    conditions: [
      { field: "memo_reference", mode: "regex", value: "\\bloans?\\b|\\brepayment\\b" },
      { field: "line_description", mode: "regex", value: "\\bloans?\\b|\\brepayment\\b" },
      { field: "line_item_name", mode: "regex", value: "\\bloans?\\b|\\brepayment\\b" },
      { field: "line_account_name", mode: "regex", value: "\\bloans?\\b|\\brepayment\\b" },
    ],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_guaranty",
    enabled: true,
    priority: 100,
    action: "exclude",
    exclusionReason: "loan",
    donationGuard: G,
    matchLogic: "any",
    conditions: [
      { field: "line_account_name", mode: "prefix", value: "4102" },
      { field: "line_item_name", mode: "contains", value: "guaranty" },
    ],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_interest",
    enabled: true,
    priority: 110,
    action: "exclude",
    exclusionReason: "interest",
    donationGuard: G,
    matchLogic: "any",
    conditions: [
      { field: "line_account_name", mode: "prefix", value: "4010" },
      { field: "line_account_name", mode: "prefix", value: "4040" },
      {
        field: "line_account_name",
        mode: "contains",
        value: "realized gain/loss on investments",
      },
      { field: "line_account_name", mode: "contains", value: "interest earned" },
      { field: "line_item_name", mode: "contains", value: "interest" },
    ],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_tax_refund",
    enabled: true,
    priority: 120,
    action: "exclude",
    exclusionReason: "tax_refund",
    donationGuard: G,
    matchLogic: "any",
    conditions: [
      { field: "line_account_name", mode: "prefix", value: "7010.4" },
      { field: "line_account_name", mode: "prefix", value: "7020" },
      { field: "line_account_name", mode: "prefix", value: "7006" },
    ],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_other_revenue_memo",
    enabled: true,
    priority: 130,
    action: "exclude",
    exclusionReason: "other_revenue",
    donationGuard: G,
    matchLogic: "all",
    conditions: [
      { field: "line_account_name", mode: "prefix", value: "4030" },
      {
        field: "memo_reference",
        mode: "regex",
        value: "\\brewards?\\b|\\bbusiness checking\\b",
      },
    ],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_other_revenue_desc",
    enabled: true,
    priority: 140,
    action: "exclude",
    exclusionReason: "other_revenue",
    donationGuard: G,
    matchLogic: "all",
    conditions: [
      { field: "line_account_name", mode: "prefix", value: "4030" },
      {
        field: "line_description",
        mode: "regex",
        value: "\\brewards?\\b|\\bbusiness checking\\b",
      },
    ],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_earned_income",
    enabled: true,
    priority: 150,
    action: "exclude",
    exclusionReason: "earned_income",
    donationGuard: G,
    matchLogic: "any",
    conditions: [
      { field: "line_account_name", mode: "prefix", value: "4020" },
      {
        field: "memo_reference",
        mode: "regex",
        value: "\\bearned income\\b|\\bservice income\\b",
      },
      {
        field: "line_description",
        mode: "regex",
        value: "\\bearned income\\b|\\bservice income\\b",
      },
      {
        field: "line_account_name",
        mode: "regex",
        value: "\\bearned income\\b|\\bservice income\\b",
      },
    ],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_expense_refund",
    enabled: true,
    priority: 160,
    action: "exclude",
    exclusionReason: "expense_refund",
    donationGuard: N,
    matchLogic: "any",
    conditions: [{ field: "any_text", mode: "regex", value: "\\brefund" }],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
  {
    id: "seed_membership",
    enabled: true,
    priority: 170,
    action: "exclude",
    exclusionReason: "membership",
    donationGuard: N,
    matchLogic: "any",
    conditions: [
      { field: "line_item_name", mode: "exact", value: "School Contributions" },
    ],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
  },
];
