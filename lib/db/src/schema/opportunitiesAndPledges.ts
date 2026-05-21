import { pgTable, text, timestamp, boolean, numeric, date } from "drizzle-orm/pg-core";
import {
  opportunityStatusEnum,
  opportunityTypeEnum,
  opportunityStageEnum,
  opportunityConditionalEnum,
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
  grantYears: text("grant_years").array(),
  individualGiverPersonId: text("individual_giver_person_id"),
  individualAdvisorPersonId: text("individual_advisor_person_id"),
  matchId: text("match_id"),
  status: opportunityStatusEnum("status"),
  owner: text("owner"),
  projectedCloseDate: date("projected_close_date"),
  actualCompletionDate: date("actual_completion_date"),
  winProbability: numeric("win_probability", { precision: 5, scale: 4 }),
  stage: opportunityStageEnum("stage"),
  lossReason: text("loss_reason"),
  applicationDeadline: date("application_deadline"),
  paymentDetails: text("payment_details"),
  // Fund-entity attribution moved to `opportunity_entities` junction table
  // (one opportunity can be split across multiple entities).
  intendedUsage: text("intended_usage"),
  usageNotes: text("usage_notes"),
  pledgeId: text("pledge_id"),
  primaryContactPersonId: text("primary_contact_person_id"),
  createdAtFromAirtable: timestamp("created_at_from_airtable"),
  updatedAtFromAirtable: timestamp("updated_at_from_airtable"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type OpportunityOrPledge = typeof opportunitiesAndPledges.$inferSelect;
export type NewOpportunityOrPledge = typeof opportunitiesAndPledges.$inferInsert;
