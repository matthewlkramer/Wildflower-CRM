import {
  pgTable,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
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
  ],
);

export type QboAccountingCheck = typeof qboAccountingChecks.$inferSelect;
export type NewQboAccountingCheck = typeof qboAccountingChecks.$inferInsert;
