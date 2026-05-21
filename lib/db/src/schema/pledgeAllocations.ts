import { pgTable, text, timestamp, boolean, numeric } from "drizzle-orm/pg-core";
import { pledgeAllocationStatusEnum } from "./_enums";

export const pledgeAllocations = pgTable("pledge_allocations", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  pledgeOrOpportunityId: text("pledge_or_opportunity_id"),
  subAmount: numeric("sub_amount", { precision: 14, scale: 2 }),
  grantYear: text("grant_year").array(),
  entityId: text("entity_id"),
  intendedUsage: text("intended_usage"),
  directToSchool: boolean("direct_to_school").default(false).notNull(),
  status: pledgeAllocationStatusEnum("status"),
  conditions: text("conditions"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PledgeAllocation = typeof pledgeAllocations.$inferSelect;
export type NewPledgeAllocation = typeof pledgeAllocations.$inferInsert;
