import { pgTable, text, numeric, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { fiscalYears } from "./fiscalYears";
import { entities } from "./entities";
import { fundraisingCategoryEnum } from "./_enums";

// Per-(fiscal_year, entity, category) fundraising goal. Wildflower books goals
// against individual fund entities (Wildflower Foundation, Black Wildflowers
// Fund, etc.) rather than a single org-wide number, and now also splits each
// goal by `category` (revenue vs loan_capital) so loan-fund capital is tracked
// as a first-class parallel target. Composite PK (fiscalYearId, entityId,
// category) keeps this idempotent on re-seed. Existing rows are backfilled to
// category='revenue'. The legacy `fiscal_years.goal_amount` column is no longer
// read by the API — kept on the table for now to avoid an out-of-band data drop.
export const fiscalYearEntityGoals = pgTable(
  "fiscal_year_entity_goals",
  {
    fiscalYearId: text("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    category: fundraisingCategoryEnum("category")
      .notNull()
      .default("revenue"),
    goalAmount: numeric("goal_amount", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.fiscalYearId, t.entityId, t.category] })],
);

export type FiscalYearEntityGoal = typeof fiscalYearEntityGoals.$inferSelect;
export type NewFiscalYearEntityGoal = typeof fiscalYearEntityGoals.$inferInsert;
