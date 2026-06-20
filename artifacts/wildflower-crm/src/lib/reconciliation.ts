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

export type OutcomeChoice =
  | "create_gift_from_opportunity"
  | "convert_to_pledge_and_first_payment";

export type DeriveResult =
  | { ok: true; body: ApproveCompleteMatchBody; summary: string }
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
    return {
      ok: true,
      summary: `Link to existing gift “${gift.label}”${
        opportunity ? ` and tie it to ${opportunity.label}` : ""
      }.`,
      body: {
        ...base,
        outcome: "link_existing_gift",
        giftId: gift.id,
        opportunityId: opportunity?.id ?? null,
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
