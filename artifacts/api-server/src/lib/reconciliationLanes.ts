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
  // Staged-payment / Stripe-charge lifecycle status.
  status: string; // pending | approved | reconciled | excluded | rejected
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
    i.status === "excluded" || i.status === "rejected"
      ? "exempt"
      : i.giftLinked || i.status === "reconciled" || i.status === "approved"
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

type PayoutReconciliationStatus =
  | "unmatched"
  | "proposed"
  | "conflict_approved"
  | "confirmed_reconciled"
  | "confirmed_excluded"
  | "confirmed_keep"
  | "confirmed_replace"
  | null
  | undefined;

// A Stripe payout is a batch (gross − fees = net) with no single donor, so only
// the funding lane applies; crmRecord is null. Its funding lane is derived from
// the payout ↔ QuickBooks reconciliation lifecycle.
export function derivePayoutLanes(
  status: PayoutReconciliationStatus,
): ReconciliationLanes {
  const funding: ReconciliationLaneStatus =
    status === "confirmed_excluded"
      ? "exempt"
      : status === "confirmed_reconciled" ||
          status === "confirmed_keep" ||
          status === "confirmed_replace"
        ? "confirmed"
        : status === "proposed" || status === "conflict_approved"
          ? "proposed"
          : "unlinked";
  return { funding, crmRecord: null };
}
