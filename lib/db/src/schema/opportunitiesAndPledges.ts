import { pgTable, text, timestamp, boolean, numeric, date } from "drizzle-orm/pg-core";
import {
  opportunityStatusEnum,
  opportunityTypeEnum,
  opportunityStageEnum,
  opportunityConditionalEnum,
  intendedUsageEnum,
} from "./_enums";

export const opportunitiesAndPledges = pgTable("opportunities_and_pledges", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  name: text("name"),
  funderId: text("funder_id"),
  askAmount: numeric("ask_amount", { precision: 14, scale: 2 }),
  awardedAmount: numeric("awarded_amount", { precision: 14, scale: 2 }),
  type: opportunityTypeEnum("type"),
  conditional: opportunityConditionalEnum("conditional"),
  conditions: text("conditions"),
  conditionsMet: boolean("conditions_met").default(false).notNull(),
  // Array of fiscal_years.id slugs (e.g. {fy2024,fy2025}). Multi-year grants
  // book a sub_amount to each year via pledge_allocations.
  grantYears: text("grant_years").array(),
  individualGiverPersonId: text("individual_giver_person_id"),
  individualAdvisorPersonId: text("individual_advisor_person_id"),
  // Self-referential FK to the *original* opportunity that this row matches.
  // Convention: the matching gift's match_id points at the original gift's id.
  // (i.e. populated only on the matching-gift row, never on the original.)
  matchId: text("match_id"),
  status: opportunityStatusEnum("status"),
  // Legacy free-text owner name from Airtable/Copper; kept for display until
  // we can map names → Clerk users.
  owner: text("owner"),
  // FK to users.id — the team member who owns this opportunity. Nullable
  // until backfilled from `owner` text.
  ownerUserId: text("owner_user_id"),
  projectedCloseDate: date("projected_close_date"),
  actualCompletionDate: date("actual_completion_date"),
  winProbability: numeric("win_probability", { precision: 5, scale: 4 }),
  stage: opportunityStageEnum("stage"),
  lossReason: text("loss_reason"),
  applicationDeadline: date("application_deadline"),
  paymentDetails: text("payment_details"),
  // Array of entities.id slugs the opportunity is attributed to. Replaces the
  // old `opportunity_entities` junction table.
  entityIds: text("entity_ids").array(),
  // Array of intended_usage enum values. An opportunity may target multiple
  // usages (e.g. {gen_ops, project}); use the parallel fundable_project_ids
  // for any 'project' entries.
  intendedUsages: intendedUsageEnum("intended_usages").array(),
  // Array of fundable_projects.id slugs corresponding to the 'project'
  // entries in intendedUsages.
  fundableProjectIds: text("fundable_project_ids").array(),
  usageNotes: text("usage_notes"),
  // Legacy integer pledge ID inherited from Copper. Not a FK; preserved for
  // cross-reference back to the prior CRM.
  copperPledgeId: text("copper_pledge_id"),
  primaryContactPersonId: text("primary_contact_person_id"),
  createdAtFromAirtable: timestamp("created_at_from_airtable"),
  updatedAtFromAirtable: timestamp("updated_at_from_airtable"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type OpportunityOrPledge = typeof opportunitiesAndPledges.$inferSelect;
export type NewOpportunityOrPledge = typeof opportunitiesAndPledges.$inferInsert;
