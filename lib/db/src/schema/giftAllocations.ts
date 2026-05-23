import {
  index,
  pgTable,
  text,
  timestamp,
  boolean,
  numeric,
  date,
} from "drizzle-orm/pg-core";
import { intendedUsageEnum } from "./_enums";
import { giftsAndPayments } from "./giftsAndPayments";
import { entities } from "./entities";
import { fundableProjects } from "./fundableProjects";
import { schools } from "./schools";

export const giftAllocations = pgTable("gift_allocations", {
  id: text("id").primaryKey(),
  // RESTRICT: allocations are money-trail line items. Deleting the parent
  // gift must explicitly clean up its allocations first.
  giftId: text("gift_id").references(() => giftsAndPayments.id, {
    onDelete: "restrict",
  }),
  subAmount: numeric("sub_amount", { precision: 14, scale: 2 }),
  grantYearToBookTo: text("grant_year_to_book_to"),
  // FK to entities.id — the fund entity this allocation lands in.
  entityId: text("entity_id").references(() => entities.id, {
    onDelete: "restrict",
  }),
  // Was this allocation explicitly restricted to a specific region by the
  // funder? (Independent of fund-use restriction.)
  formalRegionalRestriction: boolean("formal_regional_restriction")
    .default(false)
    .notNull(),
  intendedUsage: intendedUsageEnum("intended_usage"),
  // FK to fundable_projects; populated when intendedUsage = 'project'.
  fundableProjectId: text("fundable_project_id").references(
    () => fundableProjects.id,
    { onDelete: "restrict" },
  ),
  // Was this allocation explicitly restricted to a particular use (e.g.
  // gen_ops vs a named project) by the funder? Orthogonal to the regional
  // restriction above.
  formalFundUseRestriction: boolean("formal_fund_use_restriction")
    .default(false)
    .notNull(),
  // RESTRICT: see giftsAndPayments.schoolRecipientId rationale.
  schoolRecipientId: text("school_recipient_id").references(() => schools.id, {
    onDelete: "restrict",
  }),
  spendingStart: date("spending_start"),
  spendingEnd: date("spending_end"),
  // Array of regions.id values. Array columns can't carry native FK
  // constraints; API layer enforces.
  regionIds: text("region_ids").array(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("gift_allocations_gift_id_idx").on(t.giftId),
  index("gift_allocations_entity_id_idx").on(t.entityId),
  index("gift_allocations_fundable_project_id_idx").on(t.fundableProjectId),
  index("gift_allocations_school_recipient_id_idx").on(t.schoolRecipientId),
  index("gift_allocations_region_ids_gin_idx").using("gin", t.regionIds),
]);

export type GiftAllocation = typeof giftAllocations.$inferSelect;
export type NewGiftAllocation = typeof giftAllocations.$inferInsert;
