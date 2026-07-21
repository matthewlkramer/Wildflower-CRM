import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { stripeStagedCharges } from "./stripeStagedCharges";
import { stagedPayments } from "./stagedPayments";
import { donorboxDonations } from "./donorboxDonations";
import { users } from "./users";
import {
  sourceLinkTypeEnum,
  sourceLinkLifecycleEnum,
  sourceLinkProvenanceEnum,
} from "./_enums";

/**
 * The unit-grain **evidence ↔ evidence claim ledger**
 * (docs/adr-source-link-ledger.md). One row records "these two rows in two
 * money systems are the SAME money" — with NO gift involved. This is the third
 * relationship kind alongside the two ratified planes:
 *
 *   • Plane 1 (batch↔batch): `settlement_links` — payout ↔ QB deposit lump.
 *   • Plane 2 (unit↔gift):   `payment_applications` — the cash-application ledger.
 *   • THIS table:            unit↔unit claims across evidence sources.
 *
 * It REPLACES the five scattered pointer columns:
 *   stripe_staged_charges.linked_qb_staged_payment_id     → charge_qb_tie (confirmed)
 *   stripe_staged_charges.proposed_qb_staged_payment_id   → charge_qb_tie (proposed)
 *   stripe_staged_charges.linked_fee_qb_staged_payment_id → charge_fee_row
 *   donorbox_donations.linked_qb_staged_payment_id        → donorbox_qb
 *   donorbox_donations.linked_stripe_charge_id            → donorbox_charge
 * Those columns stay physical `@deprecated` mirrors during the transition
 * (never approve the interactive-push drop); this ledger is the authority.
 *
 * CLAIM ≠ STATUS stays law (derivedStatus.ts): a source_links row is a CLAIM —
 * it blocks re-picking and feeds eligibility filters — but `match_confirmed`
 * status evidence for a QB row remains the tied charge's own counted
 * payment_applications row. Never derive status from raw linkage.
 *
 * Deterministic ids so backfill + runtime dual-write converge idempotently
 * (mirrors `settlement_links`' `sl_<payout_id>` convention):
 *   charge_qb_tie   → `srcl_ct_<charge_id>`   (one live tie per charge; the
 *                     proposed→confirmed transition is ONE row's lifecycle)
 *   charge_fee_row  → `srcl_fee_<charge_id>`
 *   donorbox_qb     → `srcl_dbq_<donation_id>`
 *   donorbox_charge → `srcl_dbc_<donation_id>`
 */
export const sourceLinks = pgTable(
  "source_links",
  {
    id: text("id").primaryKey(),
    linkType: sourceLinkTypeEnum("link_type").notNull(),
    // Exactly two of the three evidence FKs are non-NULL, pinned per link_type
    // by the CHECKs below.
    stripeChargeId: text("stripe_charge_id").references(
      () => stripeStagedCharges.id,
      { onDelete: "cascade" },
    ),
    qbStagedPaymentId: text("qb_staged_payment_id").references(
      () => stagedPayments.id,
      { onDelete: "cascade" },
    ),
    donorboxDonationId: text("donorbox_donation_id").references(
      () => donorboxDonations.id,
      { onDelete: "cascade" },
    ),
    lifecycle: sourceLinkLifecycleEnum("lifecycle").notNull(),
    provenance: sourceLinkProvenanceEnum("provenance")
      .notNull()
      .default("system"),
    // Who/when confirmed (populated only for a human-confirmed claim).
    confirmedByUserId: text("confirmed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    // Optional HUMAN text — never machine-parsed (the retired
    // `charge_tie_supersede:<qbId>` marker lives on as the
    // payment_applications.match_method enum value instead).
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // Per-type FK shape: exactly which two evidence FKs a row carries.
    check(
      "source_links_fk_shape_chk",
      sql`(
        (${t.linkType} = 'charge_qb_tie'   AND ${t.stripeChargeId} IS NOT NULL AND ${t.qbStagedPaymentId} IS NOT NULL AND ${t.donorboxDonationId} IS NULL) OR
        (${t.linkType} = 'charge_fee_row'  AND ${t.stripeChargeId} IS NOT NULL AND ${t.qbStagedPaymentId} IS NOT NULL AND ${t.donorboxDonationId} IS NULL) OR
        (${t.linkType} = 'donorbox_qb'     AND ${t.donorboxDonationId} IS NOT NULL AND ${t.qbStagedPaymentId} IS NOT NULL AND ${t.stripeChargeId} IS NULL) OR
        (${t.linkType} = 'donorbox_charge' AND ${t.donorboxDonationId} IS NOT NULL AND ${t.stripeChargeId} IS NOT NULL AND ${t.qbStagedPaymentId} IS NULL)
      )`,
    ),
    // Only charge↔QB ties have a proposed state; every other claim kind is
    // written already-confirmed (matches today's pointer semantics).
    check(
      "source_links_proposed_tie_only_chk",
      sql`${t.lifecycle} = 'confirmed' OR ${t.linkType} = 'charge_qb_tie'`,
    ),
    // ── DB-enforced cardinality (the app 409s stay as the friendly error) ──
    // A charge has at most one LIVE tie row (proposed or confirmed) — the
    // deterministic id already guarantees this, the index documents/enforces
    // it independently of id discipline.
    uniqueIndex("source_links_charge_tie_charge_uq")
      .on(t.stripeChargeId)
      .where(sql`${t.linkType} = 'charge_qb_tie'`),
    // A QB row is claimed by at most one CONFIRMED tie (NEW protection — no
    // index guarded this before; proposals may still compete).
    uniqueIndex("source_links_charge_tie_qb_confirmed_uq")
      .on(t.qbStagedPaymentId)
      .where(sql`${t.linkType} = 'charge_qb_tie' AND ${t.lifecycle} = 'confirmed'`),
    // One fee-row link per charge; many charges MAY share one QB fee lump row
    // (no uniqueness on the QB side — matches today's semantics).
    uniqueIndex("source_links_fee_row_charge_uq")
      .on(t.stripeChargeId)
      .where(sql`${t.linkType} = 'charge_fee_row'`),
    // One counterpart of each kind per donation.
    uniqueIndex("source_links_donorbox_qb_uq")
      .on(t.donorboxDonationId)
      .where(sql`${t.linkType} = 'donorbox_qb'`),
    uniqueIndex("source_links_donorbox_charge_uq")
      .on(t.donorboxDonationId)
      .where(sql`${t.linkType} = 'donorbox_charge'`),
    // Symmetric "what claims this row?" lookups.
    index("source_links_qb_staged_payment_id_idx").on(t.qbStagedPaymentId),
    index("source_links_stripe_charge_id_idx").on(t.stripeChargeId),
    index("source_links_donorbox_donation_id_idx").on(t.donorboxDonationId),
    index("source_links_link_type_lifecycle_idx").on(t.linkType, t.lifecycle),
  ],
);

export type SourceLink = typeof sourceLinks.$inferSelect;
export type NewSourceLink = typeof sourceLinks.$inferInsert;

/** Deterministic source_links ids (backfill and dual-write must converge). */
export function sourceLinkId(
  linkType: SourceLink["linkType"],
  anchorId: string,
): string {
  switch (linkType) {
    case "charge_qb_tie":
      return `srcl_ct_${anchorId}`;
    case "charge_fee_row":
      return `srcl_fee_${anchorId}`;
    case "donorbox_qb":
      return `srcl_dbq_${anchorId}`;
    case "donorbox_charge":
      return `srcl_dbc_${anchorId}`;
  }
}
