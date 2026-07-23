import {
  pgTable,
  text,
  numeric,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bankDepositComponentSourceEnum } from "./_enums";
import { bankDeposits } from "./bankDeposits";
import { paymentUnits } from "./paymentUnits";
import { stagedPayments } from "./stagedPayments";

/**
 * The **components of a bank deposit** (docs/adr-bank-spine-money-model.md,
 * Phase 3) — deliberately named so it can never be repurposed as a generic
 * batch/split abstraction.
 *
 * One row = "this check / direct payment (a `payment_units` row) is part of THIS
 * bank deposit, for THIS amount." Use it ONLY for payments that DIRECTLY compose
 * a bank deposit — principally checks, plus direct ACH/wire deposits. Stripe
 * charges are NOT components: a Stripe charge composes a payout, and the payout
 * composes the deposit (`stripe_payouts.bank_deposit_id`, Phase 4). Forcing both
 * shapes through one abstraction is exactly what this table avoids.
 *
 *   bank deposit ──┬─ check payment_unit      (bank_deposit_components)
 *                  └─ check payment_unit
 *   bank deposit ──── stripe payout ──┬─ stripe_charge payment_unit  (NOT here)
 *                                     └─ stripe_charge payment_unit
 *
 * The deposit's composition state — unresolved / partial / complete /
 * overallocated — is DERIVED from `SUM(components.amount)` vs the deposit
 * `amount`; it is NEVER stored.
 *
 * ── Source & upgrade path ───────────────────────────────────────────────
 * `source` records the evidence behind the row. Today the only source is
 * `qbo_inferred` (from a QBO Deposit's lines / split children — imperfect, hence
 * `needs_review`). When a check register, bank feed, or deposit images arrive,
 * a row is upgraded IN PLACE (`source` + `amount` change, the relationships do
 * not). `source_staged_payment_id` keeps the QBO provenance for audit; it is
 * SET NULL when QBO is no longer the source and is never an authority.
 *
 * ── Cardinality ─────────────────────────────────────────────────────────
 * A check `payment_unit` composes exactly ONE deposit → `UNIQUE(payment_unit_id)`.
 * A deposit has many components (its checks). RESTRICT on both FKs: neither the
 * deposit nor the unit may be deleted out from under a component.
 */
export const bankDepositComponents = pgTable(
  "bank_deposit_components",
  {
    id: text("id").primaryKey(),
    bankDepositId: text("bank_deposit_id")
      .notNull()
      .references(() => bankDeposits.id, { onDelete: "restrict" }),
    paymentUnitId: text("payment_unit_id")
      .notNull()
      .references(() => paymentUnits.id, { onDelete: "restrict" }),
    // The deposited amount of this component. Usually equals the unit's gross,
    // but stored explicitly because the deposit-side figure is the authority for
    // composition math (a unit could in principle be split/adjusted at deposit).
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    source: bankDepositComponentSourceEnum("source").notNull(),
    // Provisional QBO provenance (the staged deposit line / split child this was
    // inferred from). SET NULL when a better source replaces QBO.
    sourceStagedPaymentId: text("source_staged_payment_id").references(
      () => stagedPayments.id,
      { onDelete: "set null" },
    ),
    // True when the inference is uncertain and a human should confirm the
    // composition (QBO errors are the reason this table exists as an interim).
    needsReview: boolean("needs_review").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // A check unit composes exactly one deposit.
    uniqueIndex("bank_deposit_components_payment_unit_id_uq").on(t.paymentUnitId),
    index("bank_deposit_components_bank_deposit_id_idx").on(t.bankDepositId),
    index("bank_deposit_components_source_staged_payment_id_idx").on(
      t.sourceStagedPaymentId,
    ),
    check("bank_deposit_components_amount_positive_chk", sql`${t.amount} > 0`),
  ],
);

export type BankDepositComponent = typeof bankDepositComponents.$inferSelect;
export type NewBankDepositComponent = typeof bankDepositComponents.$inferInsert;
