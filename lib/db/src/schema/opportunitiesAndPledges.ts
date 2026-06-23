import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  numeric,
  date,
} from "drizzle-orm/pg-core";
import {
  opportunityStatusEnum,
  opportunityLossTypeEnum,
  opportunityTypeEnum,
  opportunityStageEnum,
  opportunityConditionalEnum,
  opportunityConditionsMetEnum,
  fundraisingCategoryEnum,
  loanOrGrantEnum,
} from "./_enums";
import { organizations } from "./organizations";
import { people } from "./people";
import { users } from "./users";
import { households } from "./households";

// Header-only row for an opportunity / pledge. All scope (which fund
// entities, which fiscal years, which regions, which intended usages /
// fundable projects, and per-line sub-amounts) lives one level down in
// `pledge_allocations`. Every opportunity should have at least one
// pledge_allocations row even while the conversation is still fuzzy —
// during early talks those rows carry status='working' and act as the
// scratch pad; once a funder commits they flip to 'committed' /
// 'committed_with_conditions'; once the money lands they flip to
// 'superseded_by_gift' and the corresponding gift_allocations rows
// become the canonical record. This keeps a single shape across the
// opportunity → pledge → payment lifecycle instead of duplicating scope
// fields at every level.
//
// ─── status vs loss_type ──────────────────────────────────────────────
// `status` is FULLY CALCULATED (never set directly by users) from
// stage + payments + loss_type. `loss_type` is the only user-settable
// override: null while the row is open/pledge/cash_in; set to
// 'dormant' or 'lost' to pull the row out of the funnel. When loss_type
// is set, status mirrors it; otherwise status derives from stage +
// payments. See deriveOppFields / applyDerivedOppFields in the API.
//
// ─── Column validity by status ────────────────────────────────────────
// The same row is used across two lifecycle phases (opportunity, then
// pledge), and `status` is the discriminator. Different columns are
// expected to be populated in each phase; the table does NOT enforce
// this — it's a convention, documented here and in replit.md, that
// the UI and API are expected to honor.
//
//   status='open'   (live opportunity — fundraising conversation in flight)
//     EXPECTED: ask_amount, type, stage, win_probability,
//               projected_close_date, application_deadline, owner_user_id,
//               primary_contact_person_id, conditional, conditions
//     IGNORED : awarded_amount, actual_completion_date, conditions_met,
//               loss_reason
//
//   status='pledge' (organization committed; money may or may not be in)
//     EXPECTED: awarded_amount, conditional, conditions, conditions_met,
//               payment_details, grant_letter_url (foundation grants)
//     IGNORED : win_probability, projected_close_date, loss_reason
//
//   status='cash_in' (fully paid — sum of payments >= awarded, or stage=cash_in)
//     EXPECTED: awarded_amount, actual_completion_date
//     IGNORED : win_probability, loss_reason
//
//   status='lost'  (declined / withdrawn — sticky user override)
//     EXPECTED: loss_reason, actual_completion_date (date of decline)
//     IGNORED : awarded_amount, conditions_met, win_probability, stage
//
//   status='dormant' (paused — sticky user override)
//     EXPECTED: whatever was captured before it went quiet (treat as a
//               frozen snapshot of the opportunity-phase fields)
//     IGNORED : awarded_amount, actual_completion_date, conditions_met
//
// `was_pledge` (boolean, sticky-true) records that this row was ever a
// pledge, regardless of current status. Auto-flipped true when stage
// reaches conditional/verbal/written, when a grant letter is uploaded,
// or when a user manually checks the box. Never auto-flipped false.
//
// Partial indexes below match the two hot read paths: "open pipeline"
// (filter by status='open', sorted by projected_close_date, often
// scoped by organization) and "cash-in grants in a given period" (filter by
// status='cash_in', sorted by actual_completion_date).
export const opportunitiesAndPledges = pgTable("opportunities_and_pledges", {
  id: text("id").primaryKey(),
  name: text("name"),
  // RESTRICT: the organization is the giver of record on this opportunity/pledge.
  // Deleting them must explicitly clean up dependent rows first.
  organizationId: text("organization_id").references(() => organizations.id, {
    onDelete: "restrict",
  }),
  askAmount: numeric("ask_amount", { precision: 14, scale: 2 }),
  awardedAmount: numeric("awarded_amount", { precision: 14, scale: 2 }),
  // Persisted derived rollup: SUM of linked non-archived gift amounts (gifts
  // whose opportunity_id = this row). Recomputed by applyDerivedOppFields on
  // every payment link/amount/archive mutation. Surfaced as the API
  // `paidAmount` field and drives the cash_in status derivation (paid≥awarded).
  paid: numeric("paid", { precision: 14, scale: 2 }).notNull().default("0"),
  // Fundraising category — designates whether this opportunity/pledge is a
  // revenue commitment or a loan-fund capital (principal) commitment. Kept
  // independent of `status` (which is calculated) and of donor type. Default
  // 'revenue' so all existing opps are non-destructively treated as revenue.
  // The dashboard/projections split open + committed money by this column.
  fundraisingCategory: fundraisingCategoryEnum("fundraising_category")
    .notNull()
    .default("revenue"),
  // Authoritative loan-vs-grant flag (see loanOrGrantEnum). Backfilled from
  // fundraisingCategory (revenue→grant, loan_capital→loan) and dual-written on
  // every create/patch during the transition. Becomes the single read source
  // (replacing fundraisingCategory in dashboard/projections/goals) once the
  // parity-gated read cutover lands. Default 'grant' (non-destructive).
  loanOrGrant: loanOrGrantEnum("loan_or_grant").notNull().default("grant"),
  type: opportunityTypeEnum("type"),
  conditional: opportunityConditionalEnum("conditional"),
  conditions: text("conditions"),
  // Tri-state: 'no' | 'partial' | 'yes'. Was a boolean (true→'yes', false→'no').
  conditionsMet: opportunityConditionsMetEnum("conditions_met")
    .default("no")
    .notNull(),
  // RESTRICT: the individual giver is part of the money-trail record.
  individualGiverPersonId: text("individual_giver_person_id").references(
    () => people.id,
    { onDelete: "restrict" },
  ),
  // RESTRICT: a household giver (joint checking / joint card) is part of the
  // money-trail record. Convention: exactly one of {organizationId,
  // individualGiverPersonId, householdId} is set per row.
  householdId: text("household_id").references(() => households.id, {
    onDelete: "restrict",
  }),
  // SET NULL: an advisor is a soft relationship; if the person record is
  // removed, the opportunity survives without an advisor pointer.
  individualAdvisorPersonId: text("individual_advisor_person_id").references(
    () => people.id,
    { onDelete: "set null" },
  ),
  // Self-referential FK to the *original* opportunity that this row matches.
  // Convention: the matching gift's match_id points at the original gift's id.
  // SET NULL: removing the original shouldn't cascade-delete the match record.
  matchId: text("match_id").references(
    (): AnyPgColumn => opportunitiesAndPledges.id,
    { onDelete: "set null" },
  ),
  // FULLY CALCULATED — derived server-side from stage + payments +
  // loss_type on every write (see applyDerivedOppFields). Not a
  // user-writable field.
  status: opportunityStatusEnum("status"),
  // User-set override. Null while open/pledge/cash_in; 'dormant' or
  // 'lost' pulls the row out of the funnel. When set, `status` mirrors
  // it. The only settable half of the old status overload.
  lossType: opportunityLossTypeEnum("loss_type"),
  // RESTRICT + archive workflow on users (see users.archivedAt).
  ownerUserId: text("owner_user_id").references(() => users.id, {
    onDelete: "restrict",
  }),
  projectedCloseDate: date("projected_close_date"),
  actualCompletionDate: date("actual_completion_date"),
  winProbability: numeric("win_probability", { precision: 5, scale: 4 }),
  stage: opportunityStageEnum("stage"),
  lossReason: text("loss_reason"),
  applicationDeadline: date("application_deadline"),
  paymentDetails: text("payment_details"),
  usageNotes: text("usage_notes"),
  // Legacy integer pledge ID inherited from Copper. Not a FK; preserved for
  // cross-reference back to the prior CRM.
  copperPledgeId: text("copper_pledge_id"),
  // Sticky-true commitment flag (renamed from was_pledge): the funder has
  // made a written commitment. Latched true when a grant letter is uploaded,
  // when a user explicitly marks the commitment, or (for legacy/imported
  // rows) when the stage is a legacy commitment value. Never auto-flipped
  // back to false. Drives the calculated `status` (→ 'pledge') and the
  // Pledges page filter so historical pledges remain visible after payment.
  writtenPledge: boolean("written_pledge").default(false).notNull(),
  // Grant letter (foundation pledge documentation). Lives in object
  // storage; only the URL is stored. Uploading flips written_pledge=true.
  grantLetterUrl: text("grant_letter_url"),
  grantLetterFilename: text("grant_letter_filename"),
  // ISO-string mode so the OpenAPI-typed string flows through without
  // coercion in route handlers; reads as the same ISO string the
  // generated client expects.
  grantLetterUploadedAt: timestamp("grant_letter_uploaded_at", { mode: "string" }),
  // SET NULL: primary contact is a soft pointer.
  primaryContactPersonId: text("primary_contact_person_id").references(
    () => people.id,
    { onDelete: "set null" },
  ),
  createdAtFromAirtable: timestamp("created_at_from_airtable"),
  updatedAtFromAirtable: timestamp("updated_at_from_airtable"),
  // Soft-delete: non-null = archived (hidden from non-admins). Separate from
  // the calculated `status` and the `lossType` override; never set by them.
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("opportunities_and_pledges_organization_id_idx").on(t.organizationId),
  index("opportunities_and_pledges_individual_giver_person_id_idx").on(t.individualGiverPersonId),
  index("opportunities_and_pledges_household_id_idx").on(t.householdId),
  index("opportunities_and_pledges_individual_advisor_person_id_idx").on(t.individualAdvisorPersonId),
  index("opportunities_and_pledges_match_id_idx").on(t.matchId),
  index("opportunities_and_pledges_owner_user_id_idx").on(t.ownerUserId),
  index("opportunities_and_pledges_primary_contact_person_id_idx").on(t.primaryContactPersonId),
  index("opportunities_and_pledges_archived_at_idx").on(t.archivedAt),
  // Partial indexes for the two phase-specific hot paths. See
  // "Column validity by status" comment above.
  index("opportunities_and_pledges_open_pipeline_idx")
    .on(t.organizationId, t.projectedCloseDate)
    .where(sql`${t.status} = 'open'`),
  index("opportunities_and_pledges_cash_in_completed_idx")
    .on(t.actualCompletionDate)
    .where(sql`${t.status} = 'cash_in'`),
  // Donor exclusivity: exactly one of organization / individual-giver / household.
  check(
    "opportunities_and_pledges_donor_xor",
    sql`num_nonnulls(${t.organizationId}, ${t.individualGiverPersonId}, ${t.householdId}) = 1`,
  ),
  // NOTE: previously had a `closed_requires_completion_date` CHECK that
  // forced won/lost rows to carry an actualCompletionDate. Dropped to
  // support data-cleanup workflows where the user is marking historical
  // opps as won/lost in bulk and a real close date isn't always known
  // (and inventing one — e.g. today — would be worse than null).
]);

export type OpportunityOrPledge = typeof opportunitiesAndPledges.$inferSelect;
export type NewOpportunityOrPledge =
  typeof opportunitiesAndPledges.$inferInsert;
