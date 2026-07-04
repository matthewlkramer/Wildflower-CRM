import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { stripePayouts } from "./stripePayouts";
import { stagedPayments } from "./stagedPayments";
import { giftsAndPayments } from "./giftsAndPayments";
import { users } from "./users";
import {
  settlementLinkLifecycleEnum,
  settlementLinkProvenanceEnum,
} from "./_enums";

/**
 * Plane 1 of the ratified reconciliation redesign — batch↔batch **settlement**
 * (docs/reconciliation-design.md §4.3). One row ties a Stripe **payout** (the bank
 * transfer) to the QuickBooks **deposit** lump line it landed as. This is
 * structurally different from the Plane-2 unit↔gift cash-application ledger
 * (`payment_applications`): a settlement row has no donor and no amount split — it
 * only records "this payout IS this deposit", plus its confirmation lifecycle.
 *
 * It REPLACES the 7-value `stripe_payouts.qb_reconciliation_status` enum (and the
 * `proposed/matched/qb_conflict` pointer columns + the vestigial keep/replace
 * paths). The legacy `conflict_approved` state is preserved here as
 * `lifecycle = 'proposed' AND conflict_gift_id IS NOT NULL` (see that column). The
 * payout's settlement status (`settled` | `proposed` | `orphan`) becomes a pure
 * derivation over this table (§4.4) — nothing hand-set.
 *
 * A confirmed link means the deposit and its constituent Stripe charges are the
 * SAME dollars at two grains. Book-once is per-unit, so avoiding a double count
 * across the settlement boundary is a SEPARATE Plane-2 rule (the §4.3 supersede:
 * per-charge counted units downgrade the coarse deposit→gift link to
 * `corroborating`) — that is NOT modeled here and is Phase 5, not Phase 4.
 *
 * This is now the authoritative store: the reconcile/confirm/revert + mint/link
 * choke points write ONLY this table, and the payout's reconciliation status is a
 * pure derivation over it on read (`payoutStatusFromLink` / `payoutStatusLabelSql`).
 * It was backfilled from the legacy `qb_reconciliation_status` by migration 0089;
 * those legacy `qb_reconciliation_status` + pointer mirror columns have since been
 * dropped.
 *
 * Membership is EXCLUSIVE: at most one settlement link per payout, enforced by the
 * deterministic PK `sl_<payout_id>` AND a UNIQUE(payout_id). FKs cascade off the
 * payout (dissolving a payout removes its link) and SET NULL off the deposit /
 * confirming user (the link survives, the pointer degrades gracefully).
 */
export const settlementLinks = pgTable(
  "settlement_links",
  {
    // Deterministic `sl_<payout_id>` so the runtime dual-write and the 0089
    // backfill converge on the SAME id (idempotent, one link per payout).
    id: text("id").primaryKey(),
    payoutId: text("payout_id")
      .notNull()
      .references(() => stripePayouts.id, { onDelete: "cascade" }),
    // The QB deposit lump line this payout landed as. NULLABLE — an `exempt` link
    // (payout intentionally not settled against QB) carries none; `proposed` /
    // `confirmed` links always carry one (enforced by the CHECK below).
    depositStagedPaymentId: text("deposit_staged_payment_id").references(
      () => stagedPayments.id,
      { onDelete: "set null" },
    ),
    // The already-approved QB gift a `proposed` link COLLIDED with — i.e. the
    // legacy `conflict_approved` state (a proposal that landed on a gift already
    // booked from QB, awaiting the human's keep/replace decision). A conflict is
    // therefore `lifecycle = 'proposed' AND conflict_gift_id IS NOT NULL` — NOT a
    // 4th lifecycle value (that would contradict the ratified §4.5 target and fork
    // every shipped lifecycle read). Mirrors `stripe_payouts.qb_conflict_gift_id`;
    // RETAINED on the resulting `confirmed` link too, because revert-of-keep uses
    // its presence as the discriminator and the double-book guards consume it.
    conflictGiftId: text("conflict_gift_id").references(
      () => giftsAndPayments.id,
      { onDelete: "set null" },
    ),
    lifecycle: settlementLinkLifecycleEnum("lifecycle").notNull(),
    provenance: settlementLinkProvenanceEnum("provenance")
      .notNull()
      .default("system"),
    // Who/when confirmed (populated only for a human-confirmed link).
    confirmedByUserId: text("confirmed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // Exclusivity: at most one settlement link per payout.
    uniqueIndex("settlement_links_payout_id_uq").on(t.payoutId),
    index("settlement_links_deposit_staged_payment_id_idx").on(
      t.depositStagedPaymentId,
    ),
    index("settlement_links_lifecycle_idx").on(t.lifecycle),
    index("settlement_links_conflict_gift_id_idx").on(t.conflictGiftId),
    // A non-exempt link must tie to a QB deposit; only `exempt` may omit it.
    check(
      "settlement_links_deposit_required_chk",
      sql`${t.lifecycle} = 'exempt' OR ${t.depositStagedPaymentId} IS NOT NULL`,
    ),
  ],
);

export type SettlementLink = typeof settlementLinks.$inferSelect;
export type NewSettlementLink = typeof settlementLinks.$inferInsert;
