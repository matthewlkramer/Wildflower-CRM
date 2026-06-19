import {
  index,
  pgTable,
  text,
  timestamp,
  boolean,
  numeric,
} from "drizzle-orm/pg-core";
import {
  pledgeAllocationStatusEnum,
  intendedUsageEnum,
  restrictionTypeEnum,
  deferredRevenueEnum,
} from "./_enums";
import { opportunitiesAndPledges } from "./opportunitiesAndPledges";
import { entities } from "./entities";
import { fundableProjects } from "./fundableProjects";
import { fiscalYears } from "./fiscalYears";

export const pledgeAllocations = pgTable("pledge_allocations", {
  id: text("id").primaryKey(),
  // RESTRICT: allocations are money-trail line items. Deleting the parent
  // pledge must explicitly clean up its allocations first.
  pledgeOrOpportunityId: text("pledge_or_opportunity_id").references(
    () => opportunitiesAndPledges.id,
    { onDelete: "restrict" },
  ),
  subAmount: numeric("sub_amount", { precision: 14, scale: 2 }),
  // FK to fiscal_years.id (slug, e.g. 'fy2024'). Single fiscal year per
  // allocation; multi-year grants get one allocation row per year. All
  // scope (entity / year / region / intended_usage / fundable_project) is
  // carried here on the allocation rather than at the parent opportunity
  // level — the parent is header-only.
  grantYear: text("grant_year").references(() => fiscalYears.id, {
    onDelete: "restrict",
  }),
  entityId: text("entity_id").references(() => entities.id, {
    onDelete: "restrict",
  }),
  intendedUsage: intendedUsageEnum("intended_usage"),
  // FK to fundable_projects; populated when intendedUsage = 'project'.
  fundableProjectId: text("fundable_project_id").references(
    () => fundableProjects.id,
    { onDelete: "restrict" },
  ),
  directToSchool: boolean("direct_to_school").default(false).notNull(),
  // Whether this allocation is FORMALLY restricted by the grant letter (true)
  // vs. just our documented understanding of the donor's intent (false). The
  // gift_allocations equivalent is split into regional + fund-use booleans; at
  // the opportunity/pledge stage a single flag is sufficient.
  formallyRestricted: boolean("formally_restricted").default(false).notNull(),
  status: pledgeAllocationStatusEnum("status"),
  // Scheduled (false, the default) vs contingent (true) future payment. The
  // opportunity-level `conditional` enum is header-only; booking treats each
  // pledge year/tranche separately, so contingency is captured per allocation.
  // The free-text `conditions` below describes the contingency when set.
  contingent: boolean("contingent").default(false).notNull(),
  conditions: text("conditions"),
  notes: text("notes"),
  // Array of regions.id values. Array columns can't carry native FK
  // constraints; the API layer is responsible for validating writes.
  regionIds: text("region_ids").array(),
  // ── Revenue-accounting / QuickBooks coding (CFO "Revenue Extractor") ──
  // See gift_allocations for column semantics. Captured at the pledge stage so
  // coding intent is recorded before any cash arrives.
  restrictionType: restrictionTypeEnum("restriction_type"),
  restrictionEvidence: text("restriction_evidence"),
  purposeVerbatim: text("purpose_verbatim"),
  deferredRevenue: deferredRevenueEnum("deferred_revenue"),
  deferredRevenueReason: text("deferred_revenue_reason"),
  // Derived QBO coding SNAPSHOT (override via *Override columns).
  objectCode: text("object_code"),
  objectCodeOverride: text("object_code_override"),
  revenueLocation: text("revenue_location"),
  revenueLocationOverride: text("revenue_location_override"),
  revenueClass: text("revenue_class"),
  revenueClassOverride: text("revenue_class_override"),
  codingFlags: text("coding_flags").array(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("pledge_allocations_pledge_or_opportunity_id_idx").on(t.pledgeOrOpportunityId),
  index("pledge_allocations_entity_id_idx").on(t.entityId),
  index("pledge_allocations_fundable_project_id_idx").on(t.fundableProjectId),
  index("pledge_allocations_region_ids_gin_idx").using("gin", t.regionIds),
  index("pledge_allocations_grant_year_idx").on(t.grantYear),
]);

export type PledgeAllocation = typeof pledgeAllocations.$inferSelect;
export type NewPledgeAllocation = typeof pledgeAllocations.$inferInsert;
