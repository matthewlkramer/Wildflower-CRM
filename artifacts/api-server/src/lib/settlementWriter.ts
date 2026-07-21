import type { SettlementLinkFields } from "./settlementLink";

/**
 * Settlement-link builders (docs/reconciliation-design.md §4.3 / §4.5 / §7).
 *
 * `settlement_links` is the AUTHORITATIVE store of every payout↔deposit tie. A
 * caller expresses settlement INTENT as the `settlement_links` row it wants —
 * {@link proposeSettlementLink} for a freshly proposed tie, {@link confirmSettlementLink}
 * for a human/system-confirmed one — and persists it via `settlementLink.ts`
 * (`upsertSettlementLink` / `transitionSettlementLink`). The reconciliation status
 * enum a link REPRESENTS is derived on read by `payoutStatusFromLink` /
 * `payoutStatusLabelSql`; the retired legacy `stripe_payouts.qb_reconciliation_status`
 * + pointer mirror columns this store replaced have been dropped.
 */

/**
 * Build the settlement link for a freshly proposed payout↔deposit tie. A non-null
 * `conflictGiftId` marks the legacy `conflict_approved` case: the deposit is already
 * booked to that gift, so a human must confirm reconciling the coarse deposit.
 */
export function proposeSettlementLink(
  depositStagedPaymentId: string,
  conflictGiftId: string | null,
): SettlementLinkFields {
  return {
    lifecycle: "proposed",
    provenance: "system",
    depositStagedPaymentId,
    conflictGiftId,
    confirmedByUserId: null,
    confirmedAt: null,
  };
}

/**
 * Build the settlement link for a human/system CONFIRMED payout↔deposit tie
 * (legacy `confirmed_reconciled`).
 *
 * `confirmedAt` is a REQUIRED non-null `Date`: a confirmed link records WHEN it
 * was confirmed, and the type makes omitting it unrepresentable so no confirm
 * path can persist a confirmed link without a timestamp.
 *
 * Provenance follows the confirmer: a real user id is `human`, a null (system)
 * confirmer is `system_confirmed`. A non-null `conflictGiftId` is the "keep"
 * discriminator carried onto the confirmed link — the already-booked QB gift the
 * coarse deposit is kept against, which the revert path reads to route back to
 * `conflict_approved`.
 */
export function confirmSettlementLink(args: {
  depositStagedPaymentId: string;
  conflictGiftId: string | null;
  confirmedByUserId: string | null;
  confirmedAt: Date;
}): SettlementLinkFields {
  return {
    lifecycle: "confirmed",
    provenance: args.confirmedByUserId ? "human" : "system_confirmed",
    depositStagedPaymentId: args.depositStagedPaymentId,
    conflictGiftId: args.conflictGiftId,
    confirmedByUserId: args.confirmedByUserId,
    confirmedAt: args.confirmedAt,
  };
}

/**
 * Build the EXEMPT settlement link for a payout that needs no QB deposit at all
 * — a negative payout (Stripe withdrawal / failed payout) explicitly resolved by
 * a human. Carries NO deposit (settlement_links_deposit_required_chk allows a
 * null deposit only here) and records who resolved it and when.
 */
export function exemptSettlementLink(args: {
  confirmedByUserId: string | null;
  confirmedAt: Date;
}): SettlementLinkFields {
  return {
    lifecycle: "exempt",
    provenance: args.confirmedByUserId ? "human" : "system_confirmed",
    depositStagedPaymentId: null,
    conflictGiftId: null,
    confirmedByUserId: args.confirmedByUserId,
    confirmedAt: args.confirmedAt,
  };
}
