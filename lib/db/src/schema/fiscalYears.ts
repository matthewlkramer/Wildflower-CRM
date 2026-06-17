import { index, pgTable, text, date, timestamp, numeric } from "drizzle-orm/pg-core";

// Wildflower's fiscal year runs July 1 through June 30.
// FY2024 = 2023-07-01 → 2024-06-30 (named by the calendar year the FY ends in).
// Seeded from fy2014 onward; extend the seed as time passes.
export const fiscalYears = pgTable("fiscal_years", {
  id: text("id").primaryKey(),         // slug, e.g. "fy2024"
  label: text("label").notNull(),      // display label, e.g. "FY2024"
  startDate: date("start_date"),
  endDate: date("end_date"),
  // Fundraising goal for the FY, in dollars. Nullable — not every seeded FY
  // has a goal set (e.g. far-future years). The dashboard renders "—" when null.
  goalAmount: numeric("goal_amount", { precision: 14, scale: 2 }),
  // Soft-delete: non-null = archived (hidden from non-admins).
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("fiscal_years_archived_at_idx").on(t.archivedAt),
]);

export type FiscalYear = typeof fiscalYears.$inferSelect;
export type NewFiscalYear = typeof fiscalYears.$inferInsert;
