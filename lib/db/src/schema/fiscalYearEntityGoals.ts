import { pgTable, text, numeric, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { fiscalYears } from "./fiscalYears";
import { entities } from "./entities";
import { fundraisingCategoryEnum, loanOrGrantEnum } from "./_enums";

// Per-(fiscal_year, entity, loan_or_grant) fundraising goal. Wildflower books
// goals against individual fund entities (Wildflower Foundation, Black
// Wildflowers Fund, etc.) rather than a single org-wide number, and splits
// each goal by loan-vs-grant track so loan-fund capital is tracked as a
// first-class parallel target. Composite PK (fiscalYearId, entityId,
// loanOrGrant) keeps upserts idempotent on re-seed. The legacy
// `fiscal_years.goal_amount` column is no longer read by the API — kept on
// that table for now to avoid an out-of-band data drop.
export const fiscalYearEntityGoals = pgTable(
  "fiscal_year_entity_goals",
  {
    fiscalYearId: text("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    // @deprecated — superseded by `loanOrGrant` (now the PK's third column).
    // Frozen as of the cutover: never written (new rows keep the 'revenue'
    // default), never read, scrubbed from API responses. Kept physical only
    // for the deprecate-then-drop window.
    category: fundraisingCategoryEnum("category")
      .notNull()
      .default("revenue"),
    // Authoritative loan-vs-grant flag (see loanOrGrantEnum). Part of the
    // goal's identity — one goal per (fy, entity, loanOrGrant).
    loanOrGrant: loanOrGrantEnum("loan_or_grant").notNull().default("grant"),
    goalAmount: numeric("goal_amount", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({
      name: "fy_entity_goals_fy_entity_loan_or_grant_pk",
      columns: [t.fiscalYearId, t.entityId, t.loanOrGrant],
    }),
  ],
);

export type FiscalYearEntityGoal = typeof fiscalYearEntityGoals.$inferSelect;
export type NewFiscalYearEntityGoal = typeof fiscalYearEntityGoals.$inferInsert;
