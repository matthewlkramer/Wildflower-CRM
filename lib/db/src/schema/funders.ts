import { pgTable, text, timestamp, boolean, integer, date } from "drizzle-orm/pg-core";

ALL THE TEXT NAMES FOR FIELDS HERE ARE IN SNAKE CASE BUT THEY SHOULD BE IN REGULAR INITIAL CAPS WITH SPACES
export const funders = pgTable("funders", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  name: text("name").notNull(),
  fundingEntitySubtype: text("funding_entity_subtype"), ENUM
  makesPris: boolean("makes_pris"),
  numberOfEmployees: text("number_of_employees"), ENUM
  capacityRating: text("capacity_rating"), ENUM
  nationalPriorities: boolean("national_priorities"),
  priorityAreasNotes: text("priority_areas_notes"),
  activeStatus: text("active_status"),ENUM
  otherNames: text("other_names"),
  details: text("details"),
  emailDomain: text("email_domain"),
  owner: text("owner"), FK TO AN OWNERS TABLE OR THE USERS TABLE
  tags: text("tags"),
  lastContacted: date("last_contacted"),THIS SHOULD BE A SUMMARY LINK TO AN INTERACTIONS TABLE
  interactionCount: integer("interaction_count"), THIS SHOULD ALSO BE A LINK TO AN INTERACTIONS TABLE
  createdFromCopper: date("created_from_copper"),
  updatedFromCopper: date("updated_from_copper"),
  x: text("x"),
  linkedin: text("linkedin"),
  facebook: text("facebook"),
  instagram: text("instagram"),
  youtube: text("youtube"),
  crunchbase: text("crunchbase"),
  website: text("website"),
  connectionStatus: text("connection_status"), ENUM
  enthusiasm: text("enthusiasm"), ENUM
  strategicAlignment: text("strategic_alignment"), ENUM
  interestsThematic: text("interests_thematic").array(), ENUM THAT WORKS ACROSS TABLES
  interestsAges: text("interests_ages").array(),
  interestsGovModels: text("interests_gov_models").array(),
  parentFunderId: text("parent_funder_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Funder = typeof funders.$inferSelect;
export type NewFunder = typeof funders.$inferInsert;
