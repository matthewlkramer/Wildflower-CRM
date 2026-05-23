import {
  type AnyPgColumn,
  index,
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  date,
} from "drizzle-orm/pg-core";
import {
  fundingEntitySubtypeEnum,
  numberOfEmployeesEnum,
  capacityRatingEnum,
  connectionStatusEnum,
  enthusiasmEnum,
  strategicAlignmentEnum,
  activeStatusEnum,
} from "./_enums";
import { users } from "./users";

export const funders = pgTable("funders", {
  id: text("id").primaryKey(),
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
  // Team member who owns this funder. RESTRICT keeps history intact when a
  // team member archives.
  ownerUserId: text("owner_user_id").references(() => users.id, {
    onDelete: "restrict",
  }),
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
  // Array of regions.id values the funder prioritizes. NB: array columns
  // cannot carry native PG FK constraints; integrity is enforced at write
  // time by the API layer.
  regionIds: text("region_ids").array(),
  // Self-ref. SET NULL: removing a parent funder leaves children intact
  // (they just lose the parent pointer).
  parentFunderId: text("parent_funder_id").references(
    (): AnyPgColumn => funders.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("funders_owner_user_id_idx").on(t.ownerUserId),
  index("funders_parent_funder_id_idx").on(t.parentFunderId),
  index("funders_region_ids_gin_idx").using("gin", t.regionIds),
  index("funders_interests_thematic_gin_idx").using("gin", t.interestsThematic),
  index("funders_interests_ages_gin_idx").using("gin", t.interestsAges),
  index("funders_interests_gov_models_gin_idx").using("gin", t.interestsGovModels),
]);

export type Funder = typeof funders.$inferSelect;
export type NewFunder = typeof funders.$inferInsert;
