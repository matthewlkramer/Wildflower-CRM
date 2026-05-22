import { pgTable, text, timestamp, boolean, integer, date } from "drizzle-orm/pg-core";
import {
  fundingEntitySubtypeEnum,
  numberOfEmployeesEnum,
  capacityRatingEnum,
  connectionStatusEnum,
  enthusiasmEnum,
  strategicAlignmentEnum,
  activeStatusEnum,
} from "./_enums";

export const funders = pgTable("funders", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  name: text("name").notNull(),
  fundingEntitySubtype: fundingEntitySubtypeEnum("funding_entity_subtype"),
  makesPris: boolean("makes_pris"),
  numberOfEmployees: numberOfEmployeesEnum("number_of_employees"),
  capacityRating: capacityRatingEnum("capacity_rating"),
  nationalPriorities: boolean("national_priorities"),
  priorityAreasNotes: text("priority_areas_notes"),
  activeStatus: activeStatusEnum("active_status"),
  otherNames: text("other_names"),
  details: text("details"),
  emailDomain: text("email_domain"),
  orgEmail: text("org_email"),
  // FK to users.id — team member who owns this funder.
  ownerUserId: text("owner_user_id"),
  tags: text("tags"),
  lastContacted: date("last_contacted"),
  interactionCount: integer("interaction_count"),
  createdFromCopper: date("created_from_copper"),
  updatedFromCopper: date("updated_from_copper"),
  x: text("x"),
  linkedin: text("linkedin"),
  facebook: text("facebook"),
  instagram: text("instagram"),
  youtube: text("youtube"),
  crunchbase: text("crunchbase"),
  website: text("website"),
  connectionStatus: connectionStatusEnum("connection_status"),
  enthusiasm: enthusiasmEnum("enthusiasm"),
  strategicAlignment: strategicAlignmentEnum("strategic_alignment"),
  interestsThematic: text("interests_thematic").array(),
  interestsAges: text("interests_ages").array(),
  interestsGovModels: text("interests_gov_models").array(),
  // Array of regions.id values the funder prioritizes (was the
  // funder_regional_priorities junction table).
  regionIds: text("region_ids").array(),
  parentFunderId: text("parent_funder_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Funder = typeof funders.$inferSelect;
export type NewFunder = typeof funders.$inferInsert;
