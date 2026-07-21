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
  designationTypeEnum,
  intendedUsageEnum,
  reimbursementTypeEnum,
  restrictionAxisEnum,
  schoolSupportTypeEnum,
} from "./_enums";
import { giftsAndPayments } from "./giftsAndPayments";
import { entities } from "./entities";
import { fundableProjects } from "./fundableProjects";
import { schools } from "./schools";
import { fiscalYears } from "./fiscalYears";
import { charters } from "./charters";

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
  intendedUsage: intendedUsageEnum("intended_usage"),
  // FK to fundable_projects; populated when intendedUsage = 'project'.
  fundableProjectId: text("fundable_project_id").references(
    () => fundableProjects.id,
    { onDelete: "restrict" },
  ),
  // ── Restriction taxonomy (Task #449) ─────────────────────────────────────
  // Three independent axes capturing the donor's restriction INTENT, each one
  // of donor_restricted / wf_restricted / unrestricted. Replaces the coarse
  // formal_* booleans. NOT NULL default 'unrestricted'.
  regionalRestrictionType: restrictionAxisEnum("regional_restriction_type")
    .default("unrestricted")
    .notNull(),
  otherRestrictionType: restrictionAxisEnum("other_restriction_type")
    .default("unrestricted")
    .notNull(),
  timeRestrictionType: restrictionAxisEnum("time_restriction_type")
    .default("unrestricted")
    .notNull(),
  // Direct vs indirect share on a reimbursable grant. Nullable = untagged
  // (normal money). DIRECT is excluded from goal analytics; null + indirect
  // both count. Never affects pledge paid-amount / opportunity-status
  // derivation (those keep summing ALL allocations). See _enums.ts. Renamed
  // from reimbursable_share (Task #449).
  reimbursementType: reimbursementTypeEnum("reimbursement_type"),
  // Per-allocation "counts toward fundraising goal" flag. When false this
  // allocation's money is excluded from the goal/received analytics rollups
  // (e.g. a government reimbursement that doesn't advance the fundraising
  // goal). This is the SOLE home of the goal-counting signal — it lives at the
  // allocation level, NOT on the gift header or the staged payment (both of
  // those columns are deprecated; see giftsAndPayments / stagedPayments).
  // Defaults true (ordinary money counts). For QuickBooks auto-created gifts the
  // flag is seeded from isGovernmentReimbursement; for manual gifts a fundraiser
  // sets it by hand. Never affects pledge paid-amount / opportunity-status
  // derivation (those keep summing ALL allocations).
  countsTowardGoal: boolean("counts_toward_goal").default(true).notNull(),
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
  // The donor's restriction language, VERBATIM — exact source language only
  // (grant letter, Donorbox designation, check memo). Plain-language summaries
  // belong in restrictionDescription instead.
  purposeVerbatim: text("purpose_verbatim"),
  // Optional plain-language summary of the restriction (e.g. "grants to
  // schools only"). Free text; never affects revenue coding.
  restrictionDescription: text("restriction_description"),
  // ── Human-reviewed dimensions (edited-tables import) ──────────────────────
  // The charter legal recipient this allocation is earmarked for (parallel to
  // schoolRecipientId, which points at an individual school site).
  charterRecipientId: text("charter_recipient_id").references(
    () => charters.id,
    { onDelete: "restrict" },
  ),
  // Money belonging to the Seed Fund initiative (cuts across entity/project).
  seedFund: boolean("seed_fund").notNull().default(false),
  // Startup vs ongoing support, for school-support allocations.
  schoolSupportType: schoolSupportTypeEnum("school_support_type"),
  // Per-scope-axis designation provenance: WHO chose each scope dimension and
  // how binding it is (see designationTypeEnum in _enums.ts). Nullable = the
  // axis carries no recorded intent. Target state: these REPLACE the legacy
  // regional/usage/time restriction axes above ("restricted" = any axis
  // donor_restricted); until that consolidation ships, the legacy axes stay
  // authoritative for revenue coding.
  schoolDesignationType: designationTypeEnum("school_designation_type"),
  entityDesignationType: designationTypeEnum("entity_designation_type"),
  regionalDesignationType: designationTypeEnum("regional_designation_type"),
  projectDesignationType: designationTypeEnum("project_designation_type"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("gift_allocations_charter_recipient_id_idx").on(t.charterRecipientId),
  index("gift_allocations_gift_id_idx").on(t.giftId),
  index("gift_allocations_entity_id_idx").on(t.entityId),
  index("gift_allocations_fundable_project_id_idx").on(t.fundableProjectId),
  index("gift_allocations_school_recipient_id_idx").on(t.schoolRecipientId),
  index("gift_allocations_region_ids_gin_idx").using("gin", t.regionIds),
  index("gift_allocations_grant_year_idx").on(t.grantYear),
]);

export type GiftAllocation = typeof giftAllocations.$inferSelect;
export type NewGiftAllocation = typeof giftAllocations.$inferInsert;
