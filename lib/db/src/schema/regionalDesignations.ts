import { pgTable, text, primaryKey } from "drizzle-orm/pg-core";

export const funderRegionalPriorities = pgTable(
  "funder_regional_priorities",
  {
    funderId: text("funder_id").notNull(),
    regionId: text("region_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.funderId, t.regionId] })],
);

export const opportunityRegionalFocus = pgTable(
  "opportunity_regional_focus",
  {
    opportunityId: text("opportunity_id").notNull(),
    regionId: text("region_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.opportunityId, t.regionId] })],
);

export const pledgeAllocationRegionalDesignation = pgTable(
  "pledge_allocation_regional_designation",
  {
    pledgeAllocationId: text("pledge_allocation_id").notNull(),
    regionId: text("region_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.pledgeAllocationId, t.regionId] })],
);

export const giftRegionalDesignation = pgTable(
  "gift_regional_designation",
  {
    giftId: text("gift_id").notNull(),
    regionId: text("region_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.giftId, t.regionId] })],
);

export const giftAllocationRegionalDesignation = pgTable(
  "gift_allocation_regional_designation",
  {
    giftAllocationId: text("gift_allocation_id").notNull(),
    regionId: text("region_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.giftAllocationId, t.regionId] })],
);

export const personRegionalPriorities = pgTable(
  "person_regional_priorities",
  {
    personId: text("person_id").notNull(),
    regionId: text("region_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.regionId] })],
);
