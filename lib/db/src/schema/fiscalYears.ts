import { pgTable, text, date, timestamp } from "drizzle-orm/pg-core";

// Wildflower's fiscal year runs July 1 through June 30.
// FY2024 = 2023-07-01 → 2024-06-30 (named by the calendar year the FY ends in).
// Seeded from fy2014 onward; extend the seed as time passes.
// A sentinel row "future" represents undated future grant years.
export const fiscalYears = pgTable("fiscal_years", {
  id: text("id").primaryKey(),         // slug, e.g. "fy2024" or "future"
  label: text("label").notNull(),      // display label, e.g. "FY2024" or "Future"
  startDate: date("start_date"),       // null for the "future" sentinel
  endDate: date("end_date"),           // null for the "future" sentinel
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type FiscalYear = typeof fiscalYears.$inferSelect;
export type NewFiscalYear = typeof fiscalYears.$inferInsert;
