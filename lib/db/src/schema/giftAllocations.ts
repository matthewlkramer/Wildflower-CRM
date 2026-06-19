import {
  index,
  pgTable,
  text,
  timestamp,
  boolean,
  numeric,
  date,
} from "drizzle-orm/pg-core";
import {
  intendedUsageEnum,
  restrictionTypeEnum,
  deferredRevenueEnum,
} from "./_enums";
import { giftsAndPayments } from "./giftsAndPayments";
import { entities } from "./entities";
import { fundableProjects } from "./fundableProjects";
import { schools } from "./schools";
import { fiscalYears } from "./fiscalYears";

export const giftAllocations = pgTable("gift_allocations", {
  id: text("id").primaryKey(),
  // RESTRICT: allocations are money-trail line items. Deleting the parent
  // gift must explicitly clean up its allocations first.
  giftId: text("gift_id").references(() => giftsAndPayments.id, {
    onDelete: "restrict",
  }),
  subAmount: numeric("sub_amount", { precision: 14, scale: 2 }),
  // FK to fiscal_years.id (slug, e.g. 'fy2024'). The fiscal year this
  // portion of the gift gets booked to.
  grantYear: text("grant_year").references(() => fiscalYears.id, {
    onDelete: "restrict",
  }),
  // FK to entities.id — the fund entity this allocation lands in.
  entityId: text("entity_id").references(() => entities.id, {
    onDelete: "restrict",
  }),
  // Was this allocation explicitly restricted to a specific region by the
  // funder? (Independent of fund-use restriction.)
  formalRegionalRestriction: boolean("formal_regional_restriction")
    .default(false)
    .notNull(),
  intendedUsage: intendedUsageEnum("intended_usage"),
  // FK to fundable_projects; populated when intendedUsage = 'project'.
  fundableProjectId: text("fundable_project_id").references(
    () => fundableProjects.id,
    { onDelete: "restrict" },
  ),
  // Was this allocation explicitly restricted to a particular use (e.g.
  // gen_ops vs a named project) by the funder? Orthogonal to the regional
  // restriction above.
  formalFundUseRestriction: boolean("formal_fund_use_restriction")
    .default(false)
    .notNull(),
  // RESTRICT: see giftsAndPayments.schoolRecipientId rationale.
  schoolRecipientId: text("school_recipient_id").references(() => schools.id, {
    onDelete: "restrict",
  }),
  spendingStart: date("spending_start"),
  spendingEnd: date("spending_end"),
  // Array of regions.id values. Array columns can't carry native FK
  // constraints; API layer enforces.
  regionIds: text("region_ids").array(),
  // Denormalised human-readable label for the allocation's usage. Computed by
  // the `gift_allocations_display_usage_trg` trigger (see post-import-fixups
  // .sql) — never set this directly. Rules:
  //   - If schoolRecipientId is set → the school's short_name/name.
  //   - Else base label from intendedUsage:
  //       gen_ops → "Gen Ops", school_startup → "School Startup",
  //       growth → "Growth", teacher_training → "Teacher Training",
  //       project → fundable_projects.name (fallback "Project"),
  //       null → "".
  //   - If regionIds is non-empty (and not the school case) → append
  //     " - <region names>". Triggers on schools/regions/fundable_projects
  //     keep this in sync when names change.
  displayUsage: text("display_usage"),
  // ── Revenue-accounting / QuickBooks coding (CFO "Revenue Extractor") ──
  // Captured restriction taxonomy + supporting evidence. "unclear" is never
  // silently treated as unrestricted — it flags for review.
  restrictionType: restrictionTypeEnum("restriction_type"),
  restrictionEvidence: text("restriction_evidence"),
  purposeVerbatim: text("purpose_verbatim"),
  deferredRevenue: deferredRevenueEnum("deferred_revenue"),
  deferredRevenueReason: text("deferred_revenue_reason"),
  // Derived QBO coding SNAPSHOT — recomputed from the parent donor + restriction
  // + entity coding rules on each write (and on parent-donor change). Never edit
  // directly; set the *Override columns to override. Effective = override ?? derived.
  objectCode: text("object_code"),
  objectCodeOverride: text("object_code_override"),
  revenueLocation: text("revenue_location"),
  revenueLocationOverride: text("revenue_location_override"),
  revenueClass: text("revenue_class"),
  revenueClassOverride: text("revenue_class_override"),
  // Coding flags surfaced for human review (e.g. "restriction_unclear",
  // "location_default", "payer_type_assumed", "loan_no_revenue_account").
  codingFlags: text("coding_flags").array(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("gift_allocations_gift_id_idx").on(t.giftId),
  index("gift_allocations_entity_id_idx").on(t.entityId),
  index("gift_allocations_fundable_project_id_idx").on(t.fundableProjectId),
  index("gift_allocations_school_recipient_id_idx").on(t.schoolRecipientId),
  index("gift_allocations_region_ids_gin_idx").using("gin", t.regionIds),
  index("gift_allocations_grant_year_idx").on(t.grantYear),
]);

export type GiftAllocation = typeof giftAllocations.$inferSelect;
export type NewGiftAllocation = typeof giftAllocations.$inferInsert;
