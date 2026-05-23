import {
  index,
  pgTable,
  text,
  timestamp,
  boolean,
  numeric,
} from "drizzle-orm/pg-core";
import { pledgeAllocationStatusEnum, intendedUsageEnum } from "./_enums";
import { opportunitiesAndPledges } from "./opportunitiesAndPledges";
import { entities } from "./entities";
import { fundableProjects } from "./fundableProjects";

export const pledgeAllocations = pgTable("pledge_allocations", {
  id: text("id").primaryKey(),
  // RESTRICT: allocations are money-trail line items. Deleting the parent
  // pledge must explicitly clean up its allocations first.
  pledgeOrOpportunityId: text("pledge_or_opportunity_id").references(
    () => opportunitiesAndPledges.id,
    { onDelete: "restrict" },
  ),
  subAmount: numeric("sub_amount", { precision: 14, scale: 2 }),
  // NB: array column despite the singular column name. Worth renaming to
  // grant_years for consistency with opportunities_and_pledges.grant_years
  // (see #5 in the data-structures review).
  grantYear: text("grant_year").array(),
  entityId: text("entity_id").references(() => entities.id, {
    onDelete: "restrict",
  }),
  intendedUsage: intendedUsageEnum("intended_usage"),
  // FK to fundable_projects; populated when intendedUsage = 'project'.
  fundableProjectId: text("fundable_project_id").references(
    () => fundableProjects.id,
    { onDelete: "restrict" },
  ),
  directToSchool: boolean("direct_to_school").default(false).notNull(),
  status: pledgeAllocationStatusEnum("status"),
  conditions: text("conditions"),
  notes: text("notes"),
  // Array of regions.id values. Array columns can't carry native FK
  // constraints; the API layer is responsible for validating writes.
  regionIds: text("region_ids").array(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("pledge_allocations_pledge_or_opportunity_id_idx").on(t.pledgeOrOpportunityId),
  index("pledge_allocations_entity_id_idx").on(t.entityId),
  index("pledge_allocations_fundable_project_id_idx").on(t.fundableProjectId),
  index("pledge_allocations_region_ids_gin_idx").using("gin", t.regionIds),
  index("pledge_allocations_grant_year_gin_idx").using("gin", t.grantYear),
]);

export type PledgeAllocation = typeof pledgeAllocations.$inferSelect;
export type NewPledgeAllocation = typeof pledgeAllocations.$inferInsert;
