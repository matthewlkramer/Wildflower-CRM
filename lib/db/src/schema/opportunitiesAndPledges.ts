import {
  type AnyPgColumn,
  index,
  pgTable,
  text,
  timestamp,
  boolean,
  numeric,
  date,
} from "drizzle-orm/pg-core";
import {
  opportunityStatusEnum,
  opportunityTypeEnum,
  opportunityStageEnum,
  opportunityConditionalEnum,
  intendedUsageEnum,
} from "./_enums";
import { funders } from "./funders";
import { people } from "./people";
import { users } from "./users";

export const opportunitiesAndPledges = pgTable("opportunities_and_pledges", {
  id: text("id").primaryKey(),
  name: text("name"),
  // RESTRICT: the funder is the giver of record on this opportunity/pledge.
  // Deleting them must explicitly clean up dependent rows first.
  funderId: text("funder_id").references(() => funders.id, {
    onDelete: "restrict",
  }),
  askAmount: numeric("ask_amount", { precision: 14, scale: 2 }),
  awardedAmount: numeric("awarded_amount", { precision: 14, scale: 2 }),
  type: opportunityTypeEnum("type"),
  conditional: opportunityConditionalEnum("conditional"),
  conditions: text("conditions"),
  conditionsMet: boolean("conditions_met").default(false).notNull(),
  // Array of fiscal_years.id slugs (e.g. {fy2024,fy2025}). Multi-year grants
  // book a sub_amount to each year via pledge_allocations.
  grantYears: text("grant_years").array(),
  // RESTRICT: the individual giver is part of the money-trail record.
  individualGiverPersonId: text("individual_giver_person_id").references(
    () => people.id,
    { onDelete: "restrict" },
  ),
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
  status: opportunityStatusEnum("status"),
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
  // Array of regions.id values. Array columns can't carry native FK
  // constraints; the API layer is responsible for validating writes.
  regionIds: text("region_ids").array(),
  usageNotes: text("usage_notes"),
  // Legacy integer pledge ID inherited from Copper. Not a FK; preserved for
  // cross-reference back to the prior CRM.
  copperPledgeId: text("copper_pledge_id"),
  // SET NULL: primary contact is a soft pointer.
  primaryContactPersonId: text("primary_contact_person_id").references(
    () => people.id,
    { onDelete: "set null" },
  ),
  createdAtFromAirtable: timestamp("created_at_from_airtable"),
  updatedAtFromAirtable: timestamp("updated_at_from_airtable"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("opportunities_and_pledges_funder_id_idx").on(t.funderId),
  index("opportunities_and_pledges_individual_giver_person_id_idx").on(t.individualGiverPersonId),
  index("opportunities_and_pledges_individual_advisor_person_id_idx").on(t.individualAdvisorPersonId),
  index("opportunities_and_pledges_match_id_idx").on(t.matchId),
  index("opportunities_and_pledges_owner_user_id_idx").on(t.ownerUserId),
  index("opportunities_and_pledges_primary_contact_person_id_idx").on(t.primaryContactPersonId),
  index("opportunities_and_pledges_region_ids_gin_idx").using("gin", t.regionIds),
  index("opportunities_and_pledges_entity_ids_gin_idx").using("gin", t.entityIds),
  index("opportunities_and_pledges_fundable_project_ids_gin_idx").using("gin", t.fundableProjectIds),
  index("opportunities_and_pledges_intended_usages_gin_idx").using("gin", t.intendedUsages),
  index("opportunities_and_pledges_grant_years_gin_idx").using("gin", t.grantYears),
]);

export type OpportunityOrPledge = typeof opportunitiesAndPledges.$inferSelect;
export type NewOpportunityOrPledge =
  typeof opportunitiesAndPledges.$inferInsert;
