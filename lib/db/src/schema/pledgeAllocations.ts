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
  pledgeAllocationStatusEnum,
  intendedUsageEnum,
  reimbursementTypeEnum,
  restrictionAxisEnum,
  opportunityConditionalEnum,
  opportunityConditionsMetEnum,
} from "./_enums";
import { opportunitiesAndPledges } from "./opportunitiesAndPledges";
import { entities } from "./entities";
import { fundableProjects } from "./fundableProjects";
import { schools } from "./schools";
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
  // FK to schools.id — the specific school this allocation's funds flow to.
  // Mirrors gift_allocations.schoolRecipientId. When set, the API forces
  // directToSchool=true to keep the two coherent. RESTRICT: a school can't be
  // deleted while allocations still point at it (money-trail line items).
  schoolRecipientId: text("school_recipient_id").references(() => schools.id, {
    onDelete: "restrict",
  }),
  // ── Restriction taxonomy (Task #449) ─────────────────────────────────────
  // Three independent axes capturing the donor's restriction INTENT, each one of
  // donor_restricted / wf_restricted / unrestricted. Mirrors gift_allocations.
  // NOT NULL default 'unrestricted'.
  regionalRestrictionType: restrictionAxisEnum("regional_restriction_type")
    .default("unrestricted")
    .notNull(),
  usageRestrictionType: restrictionAxisEnum("usage_restriction_type")
    .default("unrestricted")
    .notNull(),
  timeRestrictionType: restrictionAxisEnum("time_restriction_type")
    .default("unrestricted")
    .notNull(),
  // Direct vs indirect share on a reimbursable grant. Nullable = untagged
  // (normal money). DIRECT is excluded from goal analytics; null + indirect
  // both count. Never affects opportunity-status / pledge paid-amount
  // derivation (those keep summing ALL allocations). See _enums.ts. Renamed
  // from reimbursable_share (Task #449).
  reimbursementType: reimbursementTypeEnum("reimbursement_type"),
  status: pledgeAllocationStatusEnum("status"),
  // Scheduled (false, the default) vs contingent (true) future payment. Booking
  // treats each pledge year/tranche separately, so contingency is captured per
  // allocation. The free-text `conditions` below describes the contingency.
  contingent: boolean("contingent").default(false).notNull(),
  conditions: text("conditions"),
  // Per-row expected payment date (NOT tranched by grant year — a single fiscal
  // year can hold multiple payments). Allocations sharing an
  // expected_payment_date roll up into one "expected payment" with N
  // allocations. Drives overdue detection on committed/partially-paid pledges.
  // Nullable = unscheduled.
  expectedPaymentDate: date("expected_payment_date"),
  // ── Grant conditions, per-allocation (Task #449) ──────────────────────────
  // Moved down from the opportunity header (where money is actually booked per
  // year/tranche). The header now exposes a READ-ONLY derived rollup of these.
  // `conditional` mirrors opportunityConditionalEnum (nullable = unset);
  // `conditionsMet` mirrors opportunityConditionsMetEnum (default 'no').
  conditional: opportunityConditionalEnum("conditional"),
  conditionsMet: opportunityConditionsMetEnum("conditions_met")
    .default("no")
    .notNull(),
  notes: text("notes"),
  // Array of regions.id values. Array columns can't carry native FK
  // constraints; the API layer is responsible for validating writes.
  regionIds: text("region_ids").array(),
  // The donor's restriction language, verbatim. Still active.
  purposeVerbatim: text("purpose_verbatim"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("pledge_allocations_pledge_or_opportunity_id_idx").on(t.pledgeOrOpportunityId),
  index("pledge_allocations_entity_id_idx").on(t.entityId),
  index("pledge_allocations_fundable_project_id_idx").on(t.fundableProjectId),
  index("pledge_allocations_school_recipient_id_idx").on(t.schoolRecipientId),
  index("pledge_allocations_region_ids_gin_idx").using("gin", t.regionIds),
  index("pledge_allocations_grant_year_idx").on(t.grantYear),
  index("pledge_allocations_expected_payment_date_idx").on(t.expectedPaymentDate),
]);

export type PledgeAllocation = typeof pledgeAllocations.$inferSelect;
export type NewPledgeAllocation = typeof pledgeAllocations.$inferInsert;
