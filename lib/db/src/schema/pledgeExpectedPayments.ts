import {
  index,
  pgTable,
  text,
  timestamp,
  numeric,
  date,
} from "drizzle-orm/pg-core";
import { opportunitiesAndPledges } from "./opportunitiesAndPledges";

/**
 * Expected-payment installments on a FIXED-COMMITMENT pledge (Task #788).
 *
 * One row = one expected installment ("$250k due 2026-09-01"). This table is
 * the sole authority for installment scheduling: it replaces the deprecated
 * per-allocation pledge_allocations.expected_payment_date convention (where
 * allocations sharing a date implicitly rolled up into one expected payment).
 *
 * Installments are a CASH-TIMING plan only — they carry no scope. Purpose /
 * restriction / fiscal-year scope stays on pledge_allocations; the two plans
 * are deliberately independent (a single installment can fund several
 * allocation years and vice versa). Overdue detection, cash forecasting, and
 * reconciliation match scoring read from here for fixed-commitment pledges.
 * Cost-reimbursement pledges normally have NO rows here (their annual
 * allocations are the forecast), but rows are not forbidden — a reimbursement
 * award with a known drawdown schedule may still record one.
 */
export const pledgeExpectedPayments = pgTable(
  "pledge_expected_payments",
  {
    id: text("id").primaryKey(),
    // RESTRICT: money-plan line items; delete the schedule explicitly before
    // the pledge (mirrors pledge_allocations).
    pledgeOrOpportunityId: text("pledge_or_opportunity_id")
      .notNull()
      .references(() => opportunitiesAndPledges.id, { onDelete: "restrict" }),
    // The date this installment is expected. Drives overdue detection
    // (expected_date < today AND pledge not fully paid) and cash-timing
    // forecasts. NOT NULL — an unscheduled installment is meaningless; leave
    // the schedule empty instead.
    expectedDate: date("expected_date").notNull(),
    // Expected amount of this installment. Nullable = date known, amount TBD.
    amount: numeric("amount", { precision: 14, scale: 2 }),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("pledge_expected_payments_pledge_idx").on(t.pledgeOrOpportunityId),
    index("pledge_expected_payments_expected_date_idx").on(t.expectedDate),
  ],
);

export type PledgeExpectedPayment = typeof pledgeExpectedPayments.$inferSelect;
export type NewPledgeExpectedPayment =
  typeof pledgeExpectedPayments.$inferInsert;
