import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  entityTypeEnum,
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

/**
 * Unified external-organization table. Consolidates the former `funders`
 * (grant-makers) and `organizations` (advisors, partners, etc.) tables.
 *
 * `issuesGrants` distinguishes grant-makers (true) from non-grant entities
 * (false). Grant-making-specific fields (capacityRating, totalAssets, etc.)
 * are nullable and simply ignored when issuesGrants = false.
 *
 * Contact info lives in normalized tables:
 *   - email       → `emails` (FK `organization_id`)
 *   - phone       → `phone_numbers` (FK `organization_id`)
 *   - address     → `addresses` (FK `organization_id`)
 */
export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  issuesGrants: boolean("issues_grants").notNull().default(false),
  entityType: entityTypeEnum("entity_type"),
  makesPris: boolean("makes_pris"),
  numberOfEmployees: numberOfEmployeesEnum("number_of_employees"),
  capacityRating: capacityRatingEnum("capacity_rating"),
  totalAssets: numeric("total_assets", { precision: 16, scale: 2 }),
  priorityAreasNotes: text("priority_areas_notes"),
  about: text("about"),
  activeStatus: activeStatusEnum("active_status"),
  otherNames: text("other_names"),
  historicalNames: text("historical_names").array(),
  details: text("details"),
  emailDomain: text("email_domain"),
  orgEmail: text("org_email"),
  ownerUserId: text("owner_user_id").references(() => users.id, {
    onDelete: "restrict",
  }),
  tags: text("tags"),
  website: text("website"),
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
  connectionStatus: connectionStatusEnum("connection_status"),
  enthusiasm: enthusiasmEnum("enthusiasm"),
  strategicAlignment: strategicAlignmentEnum("strategic_alignment"),
  interestsThematic: text("interests_thematic").array(),
  interestsAges: text("interests_ages").array(),
  interestsGovModels: text("interests_gov_models").array(),
  regionIds: text("region_ids").array(),
  // Self-ref. SET NULL: removing a parent org leaves children intact.
  parentOrganizationId: text("parent_organization_id").references(
    (): AnyPgColumn => organizations.id,
    { onDelete: "set null" },
  ),
  // Payment intermediary (e.g. a DAF) this org gives through. Relevant
  // only when issuesGrants = true. SET NULL: removing the intermediary
  // leaves the org intact.
  paymentIntermediaryId: text("payment_intermediary_id").references(
    () => paymentIntermediaries.id,
    { onDelete: "set null" },
  ),
  // Solicitation priority tier. Relevant when issuesGrants = true.
  priority: priorityEnum("priority"),
  // When true, the organization's real name is hidden in the UI (shown as
  // "Anonymous") from everyone except the record owner and admins. UI-only.
  anonymous: boolean("anonymous").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("organizations_owner_user_id_idx").on(t.ownerUserId),
  index("organizations_parent_organization_id_idx").on(t.parentOrganizationId),
  index("organizations_payment_intermediary_id_idx").on(t.paymentIntermediaryId),
  index("organizations_priority_idx").on(t.priority),
  index("organizations_issues_grants_idx").on(t.issuesGrants),
  index("organizations_region_ids_gin_idx").using("gin", t.regionIds),
  index("organizations_interests_thematic_gin_idx").using("gin", t.interestsThematic),
  index("organizations_interests_ages_gin_idx").using("gin", t.interestsAges),
  index("organizations_interests_gov_models_gin_idx").using("gin", t.interestsGovModels),
]);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
