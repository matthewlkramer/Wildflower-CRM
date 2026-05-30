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
import { sql } from "drizzle-orm";
import {
  fundingEntitySubtypeEnum,
  numberOfEmployeesEnum,
  capacityRatingEnum,
  connectionStatusEnum,
  enthusiasmEnum,
  strategicAlignmentEnum,
  activeStatusEnum,
  priorityEnum,
} from "./_enums";
import { users } from "./users";
import { paymentIntermediaries } from "./paymentIntermediaries";

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
  // Prior names the funder has been known by (e.g. rebrands, mergers).
  // Surface in search/UI so legacy references resolve.
  historicalNames: text("historical_names").array(),
  // Self-ref. SET NULL: removing a parent funder leaves children intact
  // (they just lose the parent pointer).
  parentFunderId: text("parent_funder_id").references(
    (): AnyPgColumn => funders.id,
    { onDelete: "set null" },
  ),
  // Payment intermediary (e.g. a DAF) this funder gives through. SET NULL:
  // removing the intermediary leaves the funder intact.
  paymentIntermediaryId: text("payment_intermediary_id").references(
    () => paymentIntermediaries.id,
    { onDelete: "set null" },
  ),
  // Solicitation priority tier (top/high/medium/low). The "top" band
  // is surfaced as a star icon on the funders table and inline next to
  // the funder name wherever it appears as a donor (opportunities, gifts).
  priority: priorityEnum("priority"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("funders_owner_user_id_idx").on(t.ownerUserId),
  index("funders_parent_funder_id_idx").on(t.parentFunderId),
  index("funders_payment_intermediary_id_idx").on(t.paymentIntermediaryId),
  index("funders_priority_idx").on(t.priority),
  index("funders_region_ids_gin_idx").using("gin", t.regionIds),
  index("funders_interests_thematic_gin_idx").using("gin", t.interestsThematic),
  index("funders_interests_ages_gin_idx").using("gin", t.interestsAges),
  index("funders_interests_gov_models_gin_idx").using("gin", t.interestsGovModels),
]);

export type Funder = typeof funders.$inferSelect;
export type NewFunder = typeof funders.$inferInsert;
