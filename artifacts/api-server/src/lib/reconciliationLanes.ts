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

// The payout facts this deriver reads (the settlement_links workflow is
// retired — 0168): `settled` = a QBO deposit row carries the
// settled_stripe_payout_id pairing fact; `withdrawal` = a negative payout
// (money leaving Stripe — no bank deposit ever reaches QuickBooks).
export interface PayoutSettlementFacts {
  settled: boolean;
  withdrawal: boolean;
}

// A Stripe payout is a batch (gross − fees = net) with no single donor, so only
// the funding lane applies; crmRecord is null. Its funding lane derives from
// plain facts: a settled QBO lump = confirmed, a withdrawal = exempt,
// otherwise unlinked. There is no `proposed` state — payout↔lump pairing is
// deterministic, and discrepancies surface in qbo_accounting_checks.
export function derivePayoutLanes(
  facts: PayoutSettlementFacts,
): ReconciliationLanes {
  const funding: ReconciliationLaneStatus = facts.settled
    ? "confirmed"
    : facts.withdrawal
      ? "exempt"
      : "unlinked";
  return { funding, crmRecord: null };
}
