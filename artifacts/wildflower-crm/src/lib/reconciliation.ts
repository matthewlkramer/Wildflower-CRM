import {
  type ReconciliationEdgeState,
  type ReconciliationCandidateSource,
  type ReconciliationCandidate,
  type ReconciliationGraph,
  type ApproveCompleteMatchBody,
  type GiftFinalAmountSource,
} from "@workspace/api-client-react";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

/** Edge-state → badge label + variant for the node summaries. */
export const EDGE_STATE_BADGE: Record<
  ReconciliationEdgeState,
  { label: string; variant: BadgeVariant }
> = {
  determined: { label: "Auto-matched", variant: "default" },
  ambiguous: { label: "Needs choice", variant: "secondary" },
  filter_only: { label: "Filter", variant: "outline" },
  conflict: { label: "Conflict", variant: "destructive" },
  none: { label: "No match", variant: "outline" },
  create: { label: "New", variant: "secondary" },
};

/** Compact human label for how a candidate was derived (UI badge). */
export const CANDIDATE_SOURCE_LABEL: Record<ReconciliationCandidateSource, string> = {
  donor_xor: "donor",
  payment_on_pledge: "on pledge",
  name: "name",
  email: "email",
  amount_date: "amount + date",
  memo: "memo",
  intermediary: "intermediary",
  stripe: "stripe",
  manual: "manual",
};

/** Which evidence track set the gift's final amount. */
export const FINAL_AMOUNT_SOURCE_LABEL: Record<GiftFinalAmountSource, string> = {
  human: "Human amount",
  stripe: "Stripe gross",
  quickbooks: "QuickBooks",
};

/** An explicit per-track status: which side is approved vs still awaiting. */
export type TrackStatus = { label: string; variant: BadgeVariant };

/**
 * QuickBooks (the anchor) track, derived from the staged-payment status. Every
 * card has a QB side, so this never returns null.
 */
export function qbTrackStatus(status: string): TrackStatus {
  switch (status) {
    case "approved":
      return { label: "Approved", variant: "default" };
    case "reconciled":
      return { label: "Reconciled", variant: "default" };
    case "rejected":
      return { label: "Rejected", variant: "outline" };
    case "excluded":
      return { label: "Excluded", variant: "outline" };
    case "pending":
    default:
      return { label: "Awaiting approval", variant: "secondary" };
  }
}

/**
 * Stripe payout track, derived from the payout's QB-reconciliation status.
 * Returns null when no Stripe payout/charge backs this money (brokerage/check).
 * `conflict_approved` is NOT a money discrepancy — it only means the QB side was
 * already approved into a gift, so the Stripe evidence is waiting for a human to
 * confirm tying it in.
 */
export function stripeTrackStatus(
  status: string | null | undefined,
): TrackStatus | null {
  switch (status) {
    case "proposed":
      return { label: "Awaiting approval", variant: "secondary" };
    case "conflict_approved":
      return { label: "Awaiting confirmation", variant: "secondary" };
    case "confirmed_reconciled":
    case "confirmed_keep":
    case "confirmed_replace":
      return { label: "Reconciled", variant: "default" };
    case "confirmed_excluded":
      return { label: "Excluded", variant: "outline" };
    case "unmatched":
      return { label: "Awaiting match", variant: "outline" };
    case null:
    case undefined:
      return null;
    default:
      return { label: status, variant: "outline" };
  }
}

export type OutcomeChoice =
  | "create_gift_from_opportunity"
  | "convert_to_pledge_and_first_payment";

export type DeriveResult =
  | {
      ok: true;
      body: ApproveCompleteMatchBody;
      summary: string;
      /** When set, the UI must confirm with the human before sending (e.g. a
       *  gift-donor switch that overrides the gift's existing donor). */
      confirm?: { title: string; description: string };
    }
  | { ok: false; reason: string };

/**
 * True when the card's blockers include an amount/date tolerance failure, which
 * the server only waives with an explicit override reason.
 */
export function hasAmountBlocker(blockers: string[]): boolean {
  return blockers.some((b) => /amount|out.?of.?band|tolerance|mismatch/i.test(b));
}

/**
 * Pure client-side derivation of the approve body from the human's node
 * selections. The server re-derives + re-validates everything (it never trusts
 * these UI locks); this only decides which outcome to send and surfaces a
 * preview of what approving will do.
 *
 * Precedence mirrors the server dispatch:
 *  - a chosen gift  ⇒ link_existing_gift (donor adopted FROM the gift)
 *  - else a chosen opportunity ⇒ the human's outcomeChoice (donor derived from opp)
 *  - else a chosen donor ⇒ create_gift (Donor XOR by donorKind)
 */
export function deriveApproveBody(args: {
  donor: ReconciliationCandidate | null;
  gift: ReconciliationCandidate | null;
  opportunity: ReconciliationCandidate | null;
  outcomeChoice: OutcomeChoice;
  overrideAmountMismatchReason: string;
  graph: ReconciliationGraph;
}): DeriveResult {
  const {
    donor,
    gift,
    opportunity,
    outcomeChoice,
    overrideAmountMismatchReason,
    graph,
  } = args;

  const reason = overrideAmountMismatchReason.trim();
  if (hasAmountBlocker(graph.blockers) && !reason) {
    return {
      ok: false,
      reason: "Enter an amount-mismatch override reason to approve this card.",
    };
  }

  // Stripe GROSS takes precedence over the QB net when a single charge backs
  // the money; omit for QB-only money (brokerage / check).
  const stripeChargeId = graph.evidence.stripe?.chargeId ?? null;
  const base: ApproveCompleteMatchBody = { outcome: "create_gift" };
  if (stripeChargeId) base.stripeChargeId = stripeChargeId;
  if (reason) base.overrideAmountMismatchReason = reason;

  if (gift) {
    // If the reviewer ALSO picked a donor that differs from the gift's CURRENT
    // donor, ask the server to re-point the gift's donor — but only after an
    // explicit confirmation (this overrides the usual adopt-the-gift's-donor
    // behavior). The server re-validates Donor XOR + blocks the switch when the
    // gift is a payment on a pledge owned by another donor.
    // Compare BOTH donor kind and id: a switch is any change to the
    // (kind, id) pair, so an org and a person that happened to share an id
    // string are still treated as different donors.
    const switching =
      donor != null &&
      donor.donorKind != null &&
      gift.donorId != null &&
      (donor.id !== gift.donorId || donor.donorKind !== gift.donorKind);
    const switchField =
      switching && donor
        ? donor.donorKind === "organization"
          ? { organizationId: donor.id }
          : donor.donorKind === "person"
            ? { individualGiverPersonId: donor.id }
            : { householdId: donor.id }
        : {};
    return {
      ok: true,
      summary: `Link to existing gift “${gift.label}”${
        opportunity ? ` and tie it to ${opportunity.label}` : ""
      }${switching && donor ? ` and switch its donor to ${donor.label}` : ""}.`,
      ...(switching && donor
        ? {
            confirm: {
              title: "Switch this gift’s donor?",
              description: `This gift is currently for ${
                gift.sublabel ?? "another donor"
              }. Approving will re-point it from ${
                gift.sublabel ?? "its current donor"
              } → to ${donor.label}.`,
            },
          }
        : {}),
      body: {
        ...base,
        outcome: "link_existing_gift",
        giftId: gift.id,
        opportunityId: opportunity?.id ?? null,
        ...(switching ? { switchGiftDonor: true, ...switchField } : {}),
      },
    };
  }

  if (opportunity) {
    return {
      ok: true,
      summary:
        outcomeChoice === "convert_to_pledge_and_first_payment"
          ? `Convert “${opportunity.label}” to a pledge and record this as the first payment.`
          : `Create a one-time gift from opportunity “${opportunity.label}”.`,
      body: { ...base, outcome: outcomeChoice, opportunityId: opportunity.id },
    };
  }

  if (donor) {
    const kind = donor.donorKind;
    if (!kind) {
      return {
        ok: false,
        reason: "The selected donor is missing its kind — pick it from search again.",
      };
    }
    const donorField =
      kind === "organization"
        ? { organizationId: donor.id }
        : kind === "person"
          ? { individualGiverPersonId: donor.id }
          : { householdId: donor.id };
    return {
      ok: true,
      summary: `Create a new gift for ${donor.label}.`,
      body: { ...base, outcome: "create_gift", ...donorField },
    };
  }

  return {
    ok: false,
    reason: "Choose a gift, an opportunity, or a donor to approve.",
  };
}
