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
  paymentApplicationLinkRoleEnum,
  paymentApplicationLifecycleEnum,
} from "./_enums";

/**
 * Unified unit↔gift cash-application ledger (Plane 2 of the reconciliation
 * redesign). One row records that some or all of a QuickBooks payment, Stripe
 * charge, or Donorbox donation was applied to a CRM gift.
 *
 * `link_role='counted' AND lifecycle='confirmed'` is the sole money trail.
 * Proposed, exempt, and corroborating rows never enter settled sums.
 */
export const paymentApplications = pgTable(
  "payment_applications",
  {
    id: text("id").primaryKey(),
    paymentId: text("payment_id").references(() => stagedPayments.id, {
      onDelete: "restrict",
    }),
    giftId: text("gift_id")
      .notNull()
      .references(() => giftsAndPayments.id, { onDelete: "restrict" }),
    giftAllocationId: text("gift_allocation_id").references(
      () => giftAllocations.id,
      { onDelete: "set null" },
    ),
    amountApplied: numeric("amount_applied", { precision: 14, scale: 2 }),
    evidenceSource:
      paymentApplicationEvidenceSourceEnum("evidence_source").notNull(),
    stripeChargeId: text("stripe_charge_id").references(
      () => stripeStagedCharges.id,
      { onDelete: "set null" },
    ),
    donorboxDonationId: text("donorbox_donation_id").references(
      () => donorboxDonations.id,
      { onDelete: "set null" },
    ),
    matchMethod: paymentApplicationMatchMethodEnum("match_method")
      .notNull()
      .default("system"),
    linkRole: paymentApplicationLinkRoleEnum("link_role")
      .notNull()
      .default("counted"),
    lifecycle: paymentApplicationLifecycleEnum("lifecycle")
      .notNull()
      .default("confirmed"),
    /**
     * Set only by the settlement supersede engine when a confirmed counted QBO
     * application is demoted to corroborating because confirmed Stripe charge
     * applications represent the same payout/deposit dollars at donor grain.
     *
     * This is intentionally not an FK: the provenance must survive settlement
     * deletion long enough for the bidirectional recompute to promote the QBO
     * row back to counted. It is cleared on promotion.
     */
    supersededBySettlementLinkId: text(
      "superseded_by_settlement_link_id",
    ),
    confirmedByUserId: text("confirmed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamp("confirmed_at"),
    note: text("note"),
    createdTheGift: boolean("created_the_gift").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("payment_applications_payment_id_gift_id_uq")
      .on(t.paymentId, t.giftId)
      .where(sql`${t.linkRole} = 'counted'`),
    uniqueIndex("payment_applications_stripe_charge_id_gift_id_uq")
      .on(t.stripeChargeId, t.giftId)
      .where(sql`${t.stripeChargeId} IS NOT NULL AND ${t.linkRole} = 'counted'`),
    uniqueIndex("payment_applications_donorbox_donation_id_gift_id_uq")
      .on(t.donorboxDonationId, t.giftId)
      .where(
        sql`${t.donorboxDonationId} IS NOT NULL AND ${t.linkRole} = 'counted'`,
      ),
    // Stripe charges and Donorbox donations are non-splittable processor units.
    // They may have only one active counted owner across proposed + confirmed
    // lifecycles, regardless of gift. Exempt rows remain historical only.
    uniqueIndex("payment_applications_stripe_charge_active_owner_uq")
      .on(t.stripeChargeId)
      .where(
        sql`${t.stripeChargeId} IS NOT NULL AND ${t.linkRole} = 'counted' AND ${t.lifecycle} IN ('proposed', 'confirmed')`,
      ),
    uniqueIndex("payment_applications_donorbox_donation_active_owner_uq")
      .on(t.donorboxDonationId)
      .where(
        sql`${t.donorboxDonationId} IS NOT NULL AND ${t.linkRole} = 'counted' AND ${t.lifecycle} IN ('proposed', 'confirmed')`,
      ),
    uniqueIndex("payment_applications_payment_id_gift_id_corroborating_uq")
      .on(t.paymentId, t.giftId)
      .where(sql`${t.paymentId} IS NOT NULL AND ${t.linkRole} = 'corroborating'`),
    uniqueIndex(
      "payment_applications_stripe_charge_id_gift_id_corroborating_uq",
    )
      .on(t.stripeChargeId, t.giftId)
      .where(
        sql`${t.stripeChargeId} IS NOT NULL AND ${t.linkRole} = 'corroborating'`,
      ),
    index("payment_applications_gift_id_idx").on(t.giftId),
    index("payment_applications_gift_allocation_id_idx").on(
      t.giftAllocationId,
    ),
    index("payment_applications_payment_id_idx").on(t.paymentId),
    index("payment_applications_stripe_charge_id_idx").on(t.stripeChargeId),
    index("payment_applications_donorbox_donation_id_idx").on(
      t.donorboxDonationId,
    ),
    index("payment_applications_superseded_by_settlement_link_id_idx").on(
      t.supersededBySettlementLinkId,
    ),
    check(
      "payment_applications_amount_applied_positive",
      sql`(${t.linkRole} = 'counted' AND ${t.amountApplied} > 0) OR (${t.linkRole} = 'corroborating' AND (${t.amountApplied} IS NULL OR ${t.amountApplied} > 0))`,
    ),
    check(
      "payment_applications_quickbooks_evidence_chk",
      sql`${t.evidenceSource} <> 'quickbooks' OR ${t.paymentId} IS NOT NULL`,
    ),
    check(
      "payment_applications_stripe_evidence_chk",
      sql`${t.evidenceSource} <> 'stripe' OR ${t.stripeChargeId} IS NOT NULL`,
    ),
    check(
      "payment_applications_donorbox_evidence_chk",
      sql`${t.evidenceSource} <> 'donorbox' OR ${t.donorboxDonationId} IS NOT NULL`,
    ),
    check(
      "payment_applications_settlement_supersede_role_chk",
      sql`${t.supersededBySettlementLinkId} IS NULL OR (${t.evidenceSource} = 'quickbooks' AND ${t.linkRole} = 'corroborating' AND ${t.lifecycle} = 'confirmed')`,
    ),
  ],
);

export type PaymentApplication = typeof paymentApplications.$inferSelect;
export type NewPaymentApplication = typeof paymentApplications.$inferInsert;
