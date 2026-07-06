import { index, pgTable, text, date, timestamp, numeric } from "drizzle-orm/pg-core";
import { users } from "./users";

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
  // ── Audit close (gift booking lifecycle) ──────────────────────────────────
  // The date this fiscal year's external audit CLOSED. This — not FY-end (6/30) —
  // is the gating event: once set, the ledger facts that were audited (amount,
  // date_received, donor, off-books, and each allocation's sub_amount / entity /
  // fiscal year / revenue coding) are FROZEN for every gift and pledge GOVERNED by
  // this FY (a gift by its date_received FY; a pledge by its recognized FY). Frozen
  // records are never mutated in place — corrections, write-offs, and overpayments
  // become NEW linked records in the current OPEN FY (write-off = a new offsetting
  // pledge; overpay = a new gift). NULL = not yet closed (still mutable). Admin-set
  // and audit-logged; an admin can reopen (safety valve).
  auditClosedAt: timestamp("audit_closed_at"),
  // The admin who closed (or last re-closed) the audit. SET NULL if that user row
  // is removed — preserve the close state itself.
  auditClosedByUserId: text("audit_closed_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("fiscal_years_archived_at_idx").on(t.archivedAt),
  index("fiscal_years_audit_closed_at_idx").on(t.auditClosedAt),
]);

export type FiscalYear = typeof fiscalYears.$inferSelect;
export type NewFiscalYear = typeof fiscalYears.$inferInsert;
