import { pgTable, text, numeric, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { fiscalYears } from "./fiscalYears";
import { entities } from "./entities";

// Per-(fiscal_year, entity) fundraising goal. Wildflower books goals against
// individual fund entities (Wildflower Foundation, Black Wildflowers Fund,
// etc.) rather than a single org-wide number. Composite PK (fiscalYearId,
// entityId) keeps this idempotent on re-seed. The legacy
// `fiscal_years.goal_amount` column is no longer read by the API — kept on
// the table for now to avoid an out-of-band data drop.
export const fiscalYearEntityGoals = pgTable(
  "fiscal_year_entity_goals",
  {
    fiscalYearId: text("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    goalAmount: numeric("goal_amount", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.fiscalYearId, t.entityId] })],
);

export type FiscalYearEntityGoal = typeof fiscalYearEntityGoals.$inferSelect;
export type NewFiscalYearEntityGoal = typeof fiscalYearEntityGoals.$inferInsert;
