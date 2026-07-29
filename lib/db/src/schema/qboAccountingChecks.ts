import {
  pgTable,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { stagedPayments } from "./stagedPayments";
import { users } from "./users";
import { qboAccountingDispositionEnum } from "./_enums";

/**
 * The QBO **expected-vs-actual accounting sidecar**
 * (docs/adr-bank-spine-money-model.md, Phase 7). Once the real money chain is
 * resolved (bank deposit → payout/checks → payment units → gifts/allocations),
 * the expected QBO posting can be DERIVED from it and compared against what QBO
 * actually says. One row = one QBO record's comparison result.
 *
 * This is ACCOUNTING REVIEW, never another money ledger:
 *   - it never counts as money (totals come from payment_units / the ledger);
 *   - the CRM never writes to QBO — `correction_needed` is a worklist for a
 *     human to fix QBO in QBO, then a re-compare flips it to `corrected`;
 *   - `accepted_historical` records a deliberate decision to leave frozen
 *     history wrong (with `note` explaining why).
 *
 * `booking_basis` records how a Stripe payout was posted in QBO. Wildflower has
 * historically used both gross and net booking, so either is accepted as a
 * complete accounting treatment for now. `unmatched` means the QBO amount
 * matches neither basis and remains a correction. The field is derived by the
 * comparer, not manually entered.
 *
 * `expected` / `actual` are jsonb snapshots written by the comparer (donor /
 * revenue composition, gross, fees, entity/account/class/location) so the row
 * shows WHAT differed at compare time even after either side changes;
 * `computed_at` stamps the comparison. The comparer (app/report code) upserts
 * by the deterministic id `qac_<staged_payment_id>` and only ever moves
 * disposition forward from `consistent`/`correction_needed` — human-set
 * `corrected`/`accepted_historical` are review state it must not clobber
 * unless the facts changed again.
 */
export const qboAccountingChecks = pgTable(
  "qbo_accounting_checks",
  {
    id: text("id").primaryKey(),
    // The QBO record under comparison. CASCADE: the check is derived review
    // state about the record; it has no life of its own.
    stagedPaymentId: text("staged_payment_id")
      .notNull()
      .references(() => stagedPayments.id, { onDelete: "cascade" }),
    // Snapshot of the DERIVED expected posting at compare time.
    expected: jsonb("expected"),
    // Snapshot of what QBO actually said at compare time.
    actual: jsonb("actual"),
    disposition: qboAccountingDispositionEnum("disposition").notNull(),
    // Derived Stripe posting basis: gross and net are both acceptable; unmatched
    // is the only basis that requires correction. Null for non-Stripe checks or
    // historical rows not yet recomputed.
    bookingBasis: text("booking_basis"),
    // Human explanation — required in practice for accepted_historical.
    note: text("note"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    computedAt: timestamp("computed_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // One comparison row per QBO record.
    uniqueIndex("qbo_accounting_checks_staged_payment_id_uq").on(
      t.stagedPaymentId,
    ),
    index("qbo_accounting_checks_disposition_idx").on(t.disposition),
    index("qbo_accounting_checks_booking_basis_idx").on(t.bookingBasis),
    check(
      "qbo_accounting_checks_booking_basis_ck",
      sql`${t.bookingBasis} IS NULL OR ${t.bookingBasis} IN ('gross', 'net', 'unmatched')`,
    ),
  ],
);

export type QboAccountingCheck = typeof qboAccountingChecks.$inferSelect;
export type NewQboAccountingCheck = typeof qboAccountingChecks.$inferInsert;
