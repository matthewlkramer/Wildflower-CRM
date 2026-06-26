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
import { stagedPayments } from "./stagedPayments";
import { giftsAndPayments } from "./giftsAndPayments";
import { giftAllocations } from "./giftAllocations";
import { stripeStagedCharges } from "./stripeStagedCharges";
import { donorboxDonations } from "./donorboxDonations";
import { users } from "./users";
import {
  paymentApplicationEvidenceSourceEnum,
  paymentApplicationMatchMethodEnum,
} from "./_enums";

/**
 * Authoritative QuickBooks **cash-application ledger** — the many-to-many
 * between a QB payment record (`staged_payments`) and the CRM gift
 * (`gifts_and_payments`) it settles. One row records "this much of this QB
 * payment was applied to this gift".
 *
 * Grain & scope (firm decisions — see the rollout plan):
 *   - HEADER grain, not allocations: `gift_id` points at `gifts_and_payments`,
 *     never `gift_allocations`.
 *   - STRICTLY QB cash-application: a row exists ONLY once QB settles a gift.
 *     There is NO row for pre-QB Stripe / hand-entered / off-books money.
 *   - The ledger SUM(amount_applied) per gift is the QB-settled figure that the
 *     tie deriver reads (within fee band of the gift amount ⇒ tied; no rows ⇒
 *     missing; otherwise amount_mismatch; off-books exempt).
 *
 * Both FKs are ON DELETE RESTRICT (the QB record is the anchor; the gift is the
 * settled record — neither may be hard-deleted out from under a ledger row).
 * The hard-delete gift paths (gift merge, QuickBooks revert, Stripe revert)
 * clear / block on ledger rows first.
 *
 * Book-once is enforced in the SERVICE layer (see applyPaymentApplication),
 * NOT by a DB aggregate/fee-band constraint:
 *   - UNIQUE(payment_id, gift_id): a payment is booked to a gift exactly once
 *     (re-runs upsert the amount instead of duplicating).
 *   - the helper's tx row-lock + live SUM validation stops a single payment
 *     being applied to gifts for more than it is worth.
 */
export const paymentApplications = pgTable(
  "payment_applications",
  {
    id: text("id").primaryKey(),
    // The anchoring QB payment record. Deposits already stage per-line, so the
    // staged row is the atomic cash grain.
    paymentId: text("payment_id")
      .notNull()
      .references(() => stagedPayments.id, { onDelete: "restrict" }),
    // The CRM gift this cash was applied to. The ledger SUM that the tie deriver
    // reads is per-GIFT, so this is always the header (the authoritative grain).
    giftId: text("gift_id")
      .notNull()
      .references(() => giftsAndPayments.id, { onDelete: "restrict" }),
    // Optional NARROWING pointer to the specific gift_allocation a reviewer chose
    // when linking (the CRM-only worklist's "Link allocation → payment" action).
    // NULL = the application is recorded against the whole gift header (the
    // historical/default behavior, and what a "Link gift → payment" produces).
    // This NEVER changes the tie math — that stays per-gift on amount_applied —
    // it only records WHICH allocation the human intended. ON DELETE SET NULL so
    // dropping an allocation degrades the row gracefully to header-level.
    giftAllocationId: text("gift_allocation_id").references(
      () => giftAllocations.id,
      { onDelete: "set null" },
    ),
    // The portion of the payment applied to this gift (> 0, enforced by CHECK).
    amountApplied: numeric("amount_applied", { precision: 14, scale: 2 }).notNull(),
    evidenceSource: paymentApplicationEvidenceSourceEnum("evidence_source").notNull(),
    // Present (and required) when evidence_source = 'stripe'.
    stripeChargeId: text("stripe_charge_id").references(
      () => stripeStagedCharges.id,
      { onDelete: "set null" },
    ),
    // Present (and required) when evidence_source = 'donorbox'.
    donorboxDonationId: text("donorbox_donation_id").references(
      () => donorboxDonations.id,
      { onDelete: "set null" },
    ),
    matchMethod: paymentApplicationMatchMethodEnum("match_method")
      .notNull()
      .default("system"),
    confirmedByUserId: text("confirmed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamp("confirmed_at"),
    note: text("note"),
    // Preserves today's createdGiftId mint-ownership signal: true when this
    // application is the one that MINTED the gift (vs. matched a pre-existing one).
    createdTheGift: boolean("created_the_gift").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // Book-once key: one ledger row per payment↔gift pair.
    uniqueIndex("payment_applications_payment_id_gift_id_uq").on(
      t.paymentId,
      t.giftId,
    ),
    index("payment_applications_gift_id_idx").on(t.giftId),
    index("payment_applications_gift_allocation_id_idx").on(t.giftAllocationId),
    index("payment_applications_payment_id_idx").on(t.paymentId),
    index("payment_applications_stripe_charge_id_idx").on(t.stripeChargeId),
    index("payment_applications_donorbox_donation_id_idx").on(
      t.donorboxDonationId,
    ),
    check(
      "payment_applications_amount_applied_positive",
      sql`${t.amountApplied} > 0`,
    ),
    // Stripe / Donorbox evidence must carry its originating id.
    check(
      "payment_applications_stripe_evidence_chk",
      sql`${t.evidenceSource} <> 'stripe' OR ${t.stripeChargeId} IS NOT NULL`,
    ),
    check(
      "payment_applications_donorbox_evidence_chk",
      sql`${t.evidenceSource} <> 'donorbox' OR ${t.donorboxDonationId} IS NOT NULL`,
    ),
  ],
);

export type PaymentApplication = typeof paymentApplications.$inferSelect;
export type NewPaymentApplication = typeof paymentApplications.$inferInsert;
