import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import {
  quickbooksRuleActionEnum,
  stagedPaymentExclusionReasonEnum,
  intendedUsageEnum,
} from "./_enums";
import { organizations } from "./organizations";
import { fundableProjects } from "./fundableProjects";

/**
 * Admin-editable rules that classify / auto-handle incoming QuickBooks staged
 * payments at INGEST time. Replaces the previously code-only "noise" exclusion
 * list for the sync path: the seed reproduces today's behavior exactly, and
 * admins can add / edit / reorder / enable / delete rules without a code change.
 *
 * Two actions (see quickbooks_rule_action):
 *   - `exclude`             — mark the row excluded with one of the existing
 *                             staged_payment_exclusion_reason categories.
 *   - `auto_create_approve` — mint a gift (donor = targetOrganizationId), add an
 *                             allocation (targetIntendedUsage / targetFundableProjectId),
 *                             match the staged row to that gift, and land it in
 *                             the auto (approved + auto-applied) queue.
 *
 * Rules are evaluated in ascending `priority` order; the FIRST enabled rule that
 * matches wins (mirrors the deterministic code-classifier order). Editing rules
 * affects only NEW incoming payments — queued rows are never reclassified.
 *
 * ── Matching model ──────────────────────────────────────────────────────────
 * `matchLogic` ('any' | 'all') combines the `conditions` array. Each condition is
 *   { field, mode, value }:
 *     field: payer_name | line_item_name | line_account_name | memo_reference |
 *            line_description | qb_class | any_text | amount
 *     mode:  contains | exact | prefix | regex | lte
 * `donationGuard` true suppresses the rule when the row carries a real donation
 * line (so a gift bundled with a fee/interest/refund line is never hidden) —
 * mirrors the code classifier's donation-first guard for line-based reasons.
 */
export const quickbooksHandlingRules = pgTable(
  "quickbooks_handling_rules",
  {
    id: text("id").primaryKey(),
    // Human-readable label shown in the admin UI (e.g. "AmazonSmile",
    // "Loan activity (payer)").
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // Ascending evaluation order; first matching enabled rule wins.
    priority: integer("priority").notNull(),
    action: quickbooksRuleActionEnum("action").notNull(),
    // Required when action='exclude'. Reuses the established reason taxonomy.
    exclusionReason: stagedPaymentExclusionReasonEnum("exclusion_reason"),
    // When true, the rule is suppressed on rows that carry a real donation line.
    donationGuard: boolean("donation_guard").notNull().default(false),
    // 'any' (OR) or 'all' (AND) across `conditions`.
    matchLogic: text("match_logic").notNull().default("any"),
    // Array of { field, mode, value }. Validated in the API layer (Zod).
    conditions: jsonb("conditions").notNull().default([]),
    // ── auto_create_approve targets ──
    // Donor for the minted gift (Donor XOR via organization_id).
    targetOrganizationId: text("target_organization_id").references(
      () => organizations.id,
    ),
    // Allocation intended usage (e.g. 'gen_ops' for GenOps).
    targetIntendedUsage: intendedUsageEnum("target_intended_usage"),
    // Specific fundable project, only when targetIntendedUsage='project'.
    targetFundableProjectId: text("target_fundable_project_id").references(
      () => fundableProjects.id,
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("quickbooks_handling_rules_priority_idx").on(t.priority)],
);

export type QuickbooksHandlingRule = typeof quickbooksHandlingRules.$inferSelect;
export type NewQuickbooksHandlingRule =
  typeof quickbooksHandlingRules.$inferInsert;
