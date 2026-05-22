import { pgTable, text, timestamp, boolean, numeric } from "drizzle-orm/pg-core";
import { pledgeAllocationStatusEnum, intendedUsageEnum } from "./_enums";

export const pledgeAllocations = pgTable("pledge_allocations", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  pledgeOrOpportunityId: text("pledge_or_opportunity_id"),
  subAmount: numeric("sub_amount", { precision: 14, scale: 2 }),
  grantYear: text("grant_year").array(),
  entityId: text("entity_id"),
  intendedUsage: intendedUsageEnum("intended_usage"),
  // FK to fundable_projects; populated when intendedUsage = 'project'.
  fundableProjectId: text("fundable_project_id"),
  directToSchool: boolean("direct_to_school").default(false).notNull(),
  status: pledgeAllocationStatusEnum("status"),
  conditions: text("conditions"),
  notes: text("notes"),
  // Array of regions.id values this allocation is designated to (was the
  // pledge_allocation_regional_designation junction table).
  regionIds: text("region_ids").array(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PledgeAllocation = typeof pledgeAllocations.$inferSelect;
export type NewPledgeAllocation = typeof pledgeAllocations.$inferInsert;
