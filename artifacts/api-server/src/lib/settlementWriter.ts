import type { SettlementLinkFields } from "./settlementLink";

/**
 * Phase-4 AUTHORITATIVE settlement-link writer (docs/reconciliation-design.md
 * §4.3 / §4.5 / §7).
 *
 * Where `settlementLink.ts` MIRRORS the legacy
 * `stripe_payouts.qb_reconciliation_status` + pointer columns INTO
 * `settlement_links` (deriveSettlementLinkFields), this module inverts the
 * authority: a caller expresses settlement INTENT as the `settlement_links` row it
 * wants, and {@link reverseSettlementLink} derives the legacy enum + pointer columns
 * FROM that link. After the write-flip those columns are a pure WRITE-ONLY mirror,
 * read only by the parity gate + the response scrub (no confirm/revert/queue logic
 * reads or guards on them); they are kept solely for parity + rollback until a
 * later human-gated column drop.
 *
 * The forward parity gate (`parity:settlement-links`) still proves
 * `deriveSettlementLinkFields(payout) == link`. Because the reverse map is the EXACT
 * inverse of that deriver over the only four states the authoritative writer can
 * produce — {unmatched, proposed, conflict_approved, confirmed_reconciled} — the two
 * stay in lockstep by construction, so NO parity-direction flip is needed. The D4
 * confirm model already retired keep/replace/excluded; those survive only on frozen
 * historical rows this writer never produces.
 *
 * Phase-4 rolls the inversion out one write path at a time. T3 wires ONLY the Stripe
 * proposal pass (`stripeReconcile`); the confirm family + bundle commit follow.
 */

/** The legacy payout reconciliation columns derived from a settlement link. */
export type PayoutReconWrite = {
  qbReconciliationStatus:
    | "unmatched"
    | "proposed"
    | "conflict_approved"
    | "confirmed_reconciled";
  proposedQbStagedPaymentId: string | null;
  matchedQbStagedPaymentId: string | null;
  qbConflictStagedPaymentId: string | null;
  qbConflictGiftId: string | null;
  qbReconciliationConfirmedByUserId: string | null;
  qbReconciliationConfirmedAt: Date | null;
};

/**
 * Exact inverse of `deriveSettlementLinkFields` over the four states the
 * authoritative writer can produce.
 *
 * - `null` link ⇒ `unmatched` (all pointers cleared).
 * - A `proposed` link with a `conflictGiftId` is the legacy `conflict_approved`
 *   (the proposal collided with an already-booked gift, so a human must confirm);
 *   the deposit doubles as `qb_conflict_staged_payment_id`, mirroring exactly what
 *   the proposal pass writes today. Without a conflict gift it is a clean
 *   `proposed`.
 * - A `confirmed` link is `confirmed_reconciled`, with the deposit on
 *   `matched_qb_staged_payment_id` and the confirmer/timestamp carried through
 *   (writing `qb_reconciliation_confirmed_at` from the link kills the `updated_at`
 *   drift carve-out for new rows). The conflict gift is retained as the
 *   revert-of-keep discriminator.
 */
export function reverseSettlementLink(
  link: SettlementLinkFields | null,
): PayoutReconWrite {
  if (!link) {
    return {
      qbReconciliationStatus: "unmatched",
      proposedQbStagedPaymentId: null,
      matchedQbStagedPaymentId: null,
      qbConflictStagedPaymentId: null,
      qbConflictGiftId: null,
      qbReconciliationConfirmedByUserId: null,
      qbReconciliationConfirmedAt: null,
    };
  }

  switch (link.lifecycle) {
    case "proposed":
      return {
        qbReconciliationStatus: link.conflictGiftId
          ? "conflict_approved"
          : "proposed",
        proposedQbStagedPaymentId: link.depositStagedPaymentId,
        matchedQbStagedPaymentId: null,
        qbConflictStagedPaymentId: link.conflictGiftId
          ? link.depositStagedPaymentId
          : null,
        qbConflictGiftId: link.conflictGiftId,
        qbReconciliationConfirmedByUserId: null,
        qbReconciliationConfirmedAt: null,
      };
    case "confirmed":
      return {
        qbReconciliationStatus: "confirmed_reconciled",
        proposedQbStagedPaymentId: null,
        matchedQbStagedPaymentId: link.depositStagedPaymentId,
        qbConflictStagedPaymentId: link.conflictGiftId
          ? link.depositStagedPaymentId
          : null,
        qbConflictGiftId: link.conflictGiftId,
        qbReconciliationConfirmedByUserId: link.confirmedByUserId,
        qbReconciliationConfirmedAt: link.confirmedAt,
      };
    case "exempt":
      // No writer path produces an `exempt` link today (the deriver never returns
      // it; `confirmed_excluded` backfills to `confirmed`). Reachable only if a
      // future intent introduces exemptions — it must be mapped explicitly then.
      throw new Error(
        "reverseSettlementLink: 'exempt' lifecycle has no legacy enum mapping yet",
      );
  }
}

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
 * `confirmedAt` is a REQUIRED non-null `Date`: `deriveSettlementLinkFields`
 * coalesces a null `confirmedAt` to the payout's `updated_at`, so a confirmed
 * link that omitted the timestamp would round-trip to a DIFFERENT link whenever
 * `updated_at` later moves. The type makes that mistake unrepresentable — every
 * confirm-family caller must stamp `now`.
 *
 * Provenance follows the confirmer, matching the deriver's
 * `qbReconciliationConfirmedByUserId ? "human" : "system_confirmed"`: a real
 * user id is `human`, a null (system) confirmer is `system_confirmed`. A
 * non-null `conflictGiftId` is the "keep" discriminator carried onto the
 * confirmed link — the already-booked QB gift the coarse deposit is kept
 * against, which the revert path reads to route back to `conflict_approved`.
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
