import {
  pgTable,
  text,
  timestamp,
  numeric,
  boolean,
  integer,
  pgEnum,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { fundEnum } from "./users";
import { individuals } from "./individuals";
import { households } from "./households";
import { fundingEntities } from "./fundingEntities";
import { organizations } from "./organizations";
export const opportunitySubtypeEnum = pgEnum("opportunity_subtype", [
  "ongoing_rolling",
  "targeted_deadline",
  "rfp_proposal",
]);

export const opportunityDonorTypeEnum = pgEnum("opportunity_donor_type", [
  "individual",
  "household",
  "family_foundation",
  "institutional_foundation",
  "daf_account",
  "government_rfp",
]);

export const opportunityStageEnum = pgEnum("opportunity_stage", [
  "pre_conversation",
  "conversation",
  "solicitation",
  "negotiation",
  "committed",
  "funded",
  "stewarding",
  "declined",
  "withdrawn",
]);

export const governmentOpportunityStageEnum = pgEnum(
  "government_opportunity_stage",
  [
    "rfp_watching",
    "application_in_progress",
    "submitted",
    "under_review",
    "awarded",
    "not_awarded",
  ],
);

export const opportunities = pgTable("opportunities", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  subtype: opportunitySubtypeEnum("subtype").notNull(),
  donorType: opportunityDonorTypeEnum("donor_type").notNull(),
  individualId: text("individual_id").references(() => individuals.id, {
    onDelete: "set null",
  }),
  householdId: text("household_id").references(() => households.id, {
    onDelete: "set null",
  }),
  fundingEntityId: text("funding_entity_id").references(
    () => fundingEntities.id,
    { onDelete: "set null" },
  ),
  ownerUserId: text("owner_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  fund: fundEnum("fund").notNull(),
  region: text("region"),
  amountExpected: numeric("amount_expected", { precision: 15, scale: 2 }),
  probability: integer("probability").default(50),
  probabilityOverridden: boolean("probability_overridden").default(false),
  stage: opportunityStageEnum("stage").notNull().default("pre_conversation"),
  governmentStage: governmentOpportunityStageEnum("government_stage"),
  expectedCloseDate: timestamp("expected_close_date"),
  fiscalYear: text("fiscal_year"),
  rollForwardCount: integer("roll_forward_count").default(0),
  loiDeadline: timestamp("loi_deadline"),
  loiSubmitted: boolean("loi_submitted").default(false),
  proposalDeadline: timestamp("proposal_deadline"),
  proposalSubmitted: boolean("proposal_submitted").default(false),
  decisionExpectedDate: timestamp("decision_expected_date"),
  askAmount: numeric("ask_amount", { precision: 15, scale: 2 }),
  askRationale: text("ask_rationale"),
  pledgeId: text("pledge_id"),
  fiscalSponsorFundingEntityId: text("fiscal_sponsor_funding_entity_id").references(
    () => fundingEntities.id,
    { onDelete: "set null" },
  ),
  fiscalSponsorOrganizationId: text("fiscal_sponsor_organization_id").references(
    () => organizations.id,
    { onDelete: "set null" },
  ),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Opportunity = typeof opportunities.$inferSelect;
export type NewOpportunity = typeof opportunities.$inferInsert;
