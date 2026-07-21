// Two-lane reconciliation model (INV-4).
//
// Every unit of money has TWO independent reconciliation lanes, each of which
// progresses unlinked → proposed → confirmed (with an `exempt` terminal where no
// connection is expected):
//
//   • funding  — the accounting/evidence side (QuickBooks / Stripe). "Is this
//     money tied to real booked evidence?"
//   • crmRecord — the donor-record side. "Is this money attached to a confirmed
//     CRM donor record?"
//
// These statuses are DERIVED, never stored — there is no new column or source of
// truth. The derivers below read only existing fields (the persisted QB-tie
// signal on gifts, and the status / donor / gift-link state on still-unmatched
// evidence rows) and project them onto the two lanes. They mirror the pure
// `deriveGiftQbTie` / `deriveOppFields` pattern: pure functions, no DB access.

// Canonical per-record QB card state — always produced via the ONE shared
// mapping `qbCardStateOfStatus` (routes/reconciliation/workbenchRowState.ts)
// from the derived lifecycle status. Server internals converge on this
// vocabulary; raw status strings must not be compared here.
import type { QbCardState } from "../routes/reconciliation/workbenchRowState";

export type ReconciliationLaneStatus =
  | "unlinked"
  | "proposed"
  | "confirmed"
  | "exempt";

export interface ReconciliationLanes {
  funding: ReconciliationLaneStatus;
  // null where a donor lane does not apply (e.g. a Stripe payout — a batch with
  // no single donor).
  crmRecord: ReconciliationLaneStatus | null;
}

type GiftQuickbooksTie = "exempt" | "tied" | "amount_mismatch" | "missing";

// A CRM gift IS the confirmed CRM record (Donor XOR guarantees exactly one
// donor), so its crmRecord lane is always `confirmed`. Its funding lane mirrors
// the persisted per-gift QuickBooks-tie signal.
export function deriveGiftLanes(
  tie: GiftQuickbooksTie | null | undefined,
): ReconciliationLanes {
  const funding: ReconciliationLaneStatus =
    tie === "exempt"
      ? "exempt"
      : tie === "tied"
        ? "confirmed"
        : tie === "amount_mismatch"
          ? "proposed"
          : "unlinked";
  return { funding, crmRecord: "confirmed" };
}

export interface EvidenceLaneInput {
  // Canonical QB card state of the evidence row, via qbCardStateOfStatus.
  cardState: QbCardState;
  // A donor candidate FK is set on the evidence row (auto-guessed or chosen).
  donorPresent: boolean;
  // A human has stamped the donor match (matchConfirmedAt is set).
  donorConfirmed: boolean;
  // The evidence is linked to a real gift (matched / created / group-reconciled).
  giftLinked: boolean;
  // A candidate gift exists for review but is not yet linked.
  giftProposed?: boolean;
}

// Still-unmatched evidence (QB staged payment / Stripe staged charge). The two
// lanes move independently: a row can have its money confirmed but its donor
// still open (auto-applied gift link), or its donor confirmed but its money
// still open (human picked the donor, no gift link yet).
export function deriveEvidenceLanes(i: EvidenceLaneInput): ReconciliationLanes {
  const funding: ReconciliationLaneStatus =
    i.cardState === "excluded"
      ? "exempt"
      : i.giftLinked || i.cardState === "matched_complete"
        ? "confirmed"
        : i.giftProposed
          ? "proposed"
          : "unlinked";
  // A gift link alone does NOT confirm the donor lane — that requires either a
  // human-stamped match or a real donor FK.
  const crmRecord: ReconciliationLaneStatus = i.donorConfirmed
    ? "confirmed"
    : i.donorPresent
      ? "proposed"
      : "unlinked";
  return { funding, crmRecord };
}

// The minimal shape of a payout's settlement_links mirror row this deriver reads
// (§4.4 batch). `null` / `undefined` = no link at all = an orphan payout.
export interface PayoutSettlementLinkLike {
  lifecycle: "proposed" | "confirmed" | "exempt";
}

// A Stripe payout is a batch (gross − fees = net) with no single donor, so only
// the funding lane applies; crmRecord is null. Post S5 read-flip its funding lane
// is derived from the payout's `settlement_links` mirror (§4.4 batch), NOT the
// legacy 7-value qb_reconciliation_status: a `confirmed` link = settled money
// (funding=confirmed), a `proposed` link = an unconfirmed tie (proposed), no link
// = orphan (unlinked); the reserved `exempt` lifecycle maps straight to exempt.
//
// One deliberate delta vs the retired status mapping: a legacy `confirmed_excluded`
// payout mirrors as a CONFIRMED settlement link, so it now reads funding=confirmed
// (it IS a confirmed settlement — the coarse QB lump was suppressed so the
// per-charge Stripe gifts aren't double-counted; the exclusion is a Plane-2 fact on
// staged_payments.exclusion_reason, not a payout-settlement state), where the old
// status mapping read it as `exempt`.
export function derivePayoutLanes(
  link: PayoutSettlementLinkLike | null | undefined,
): ReconciliationLanes {
  const funding: ReconciliationLaneStatus = !link
    ? "unlinked"
    : link.lifecycle === "exempt"
      ? "exempt"
      : link.lifecycle === "confirmed"
        ? "confirmed"
        : "proposed";
  return { funding, crmRecord: null };
}
