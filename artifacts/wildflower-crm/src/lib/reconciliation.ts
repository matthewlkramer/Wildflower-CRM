import {
  StagedPaymentFundingSource,
  type ReconciliationEdgeState,
  type ReconciliationCandidateSource,
  type ReconciliationCandidate,
  type ReconciliationGraph,
  type ApproveCompleteMatchBody,
  type GiftFinalAmountSource,
  type ReconciliationLaneStatus,
  type ReconciliationLanes,
  type StagedPaymentExclusionReason,
} from "@workspace/api-client-react";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

/**
 * Two-lane reconciliation model (INV-4). Every unit of money tracks TWO
 * independent lanes — `funding` (the accounting/evidence side) and `crmRecord`
 * (the donor-record side) — each progressing unlinked → proposed → confirmed
 * (with an `exempt` terminal where no connection is expected). These replace the
 * old single "blended" reconciliation badge: a reviewer sees the money lane and
 * the donor lane separately instead of one merged status.
 */
export const LANE_STATUS_BADGE: Record<
  ReconciliationLaneStatus,
  { label: string; variant: BadgeVariant }
> = {
  confirmed: { label: "Confirmed", variant: "default" },
  proposed: { label: "Proposed", variant: "secondary" },
  unlinked: { label: "Unlinked", variant: "outline" },
  exempt: { label: "Exempt", variant: "outline" },
};

/** Prefixed label for a single lane, e.g. "Funding: Confirmed". */
export function laneBadge(
  lane: "funding" | "crmRecord",
  status: ReconciliationLaneStatus,
): { label: string; variant: BadgeVariant } {
  const prefix = lane === "funding" ? "Funding" : "CRM record";
  const base = LANE_STATUS_BADGE[status];
  return { label: `${prefix}: ${base.label}`, variant: base.variant };
}

/**
 * Both lane badges for a unit of money, in display order (funding first, then
 * CRM record). The CRM-record lane is omitted when null (e.g. a Stripe payout —
 * a batch with no single donor).
 */
export function laneBadges(
  lanes: ReconciliationLanes | null | undefined,
): Array<{ key: string; label: string; variant: BadgeVariant }> {
  if (!lanes) return [];
  const out: Array<{ key: string; label: string; variant: BadgeVariant }> = [
    { key: "funding", ...laneBadge("funding", lanes.funding) },
  ];
  if (lanes.crmRecord != null) {
    out.push({ key: "crmRecord", ...laneBadge("crmRecord", lanes.crmRecord) });
  }
  return out;
}

/**
 * A reconciliation match's status — collapsed to three states so a reviewer
 * doesn't have to juggle a taxonomy:
 *   - none     — the matcher hasn't found anything yet.
 *   - proposal — the matcher thinks it has a match (a candidate gift or donor)
 *                that a human still has to confirm.
 *   - matched  — the money is tied to a resolved CRM gift (a human set the match
 *                or approved the matcher's proposal).
 */
export type ReconCardStatusKey = "none" | "proposal" | "matched";

export interface ReconCardStatus {
  key: ReconCardStatusKey;
  label: string;
  variant: BadgeVariant;
}

function toAmount(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The single human "Status:" line a reconciliation card leads with. There are
 * only three states by design — the reviewer shouldn't have to juggle a
 * taxonomy of "awaiting / partial / multiple":
 *
 *  - matched  — the money is tied to a resolved CRM gift (a human set the match
 *               or approved the matcher's proposal).
 *  - proposal — the matcher has a candidate (a proposed gift, a determined /
 *               ambiguous gift edge, or a proposed donor to create a gift for)
 *               that a human still has to confirm.
 *  - none     — no gift or donor candidate yet.
 */
export function deriveCardStatus(card: {
  resolvedGiftId?: string | null;
  proposedGiftId?: string | null;
  proposedDonorId?: string | null;
  proposedDonorName?: string | null;
  giftState?: ReconciliationEdgeState;
}): ReconCardStatus {
  if (card.resolvedGiftId) {
    return { key: "matched", label: "Matched", variant: "default" };
  }

  if (
    card.proposedGiftId ||
    card.giftState === "determined" ||
    card.giftState === "ambiguous" ||
    card.proposedDonorId ||
    card.proposedDonorName
  ) {
    return { key: "proposal", label: "Proposed match", variant: "secondary" };
  }

  return { key: "none", label: "No match yet", variant: "outline" };
}

/**
 * Whether a card's gift link is fully SETTLED — a resolved gift whose amount
 * matches the deposit within the auto-match fee band (10% + $1, using the group
 * total for grouped cards). This is a BUCKETING signal only (it decides whether
 * a resolved card can drop out of the review column), kept deliberately separate
 * from the user-facing 3-state status: an amount-divergent resolved gift still
 * reads as "Matched" but stays in review so the rest of the money can be tied to
 * it.
 */
export function isSettledGiftLink(card: {
  resolvedGiftId?: string | null;
  resolvedGiftAmount?: string | null;
  amount?: string | null;
  sourceGroupTotalAmount?: string | null;
}): boolean {
  if (!card.resolvedGiftId) return false;
  const dep = toAmount(card.sourceGroupTotalAmount ?? card.amount);
  const gift = toAmount(card.resolvedGiftAmount);
  if (dep == null || gift == null) return true;
  if (gift > dep * 1.1 + 1) return false;
  if (dep > gift * 1.1 + 1) return false;
  return true;
}

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

/**
 * Human label for a unit of money's ORIGIN (its funding source), distinct from
 * the QuickBooks payment instrument and from the funding-lane reconcile status.
 */
export const FUNDING_SOURCE_LABEL: Record<StagedPaymentFundingSource, string> = {
  stripe: "Stripe",
  brokerage: "Brokerage / stock",
  daf: "Donor-advised fund",
  donorbox: "Donorbox",
  paypal: "PayPal",
  wire_ach: "Wire / ACH",
  check: "Check",
  cash: "Cash",
  employer_match: "Employer match",
  other: "Other",
};

/** Funding sources in display order for the manual-override picker. Derived from
 *  the generated enum so it can never drift from the contract. */
export const FUNDING_SOURCE_OPTIONS = Object.values(
  StagedPaymentFundingSource,
) as StagedPaymentFundingSource[];

/**
 * The status of one CONNECTION between two records (e.g. Stripe → QuickBooks),
 * not the status of a single record. Reviewers think in connections: "is the
 * Stripe charge tied to the QB deposit?", "is the QB deposit booked to a gift?".
 */
export type ConnectionStatus = {
  label: string;
  variant: BadgeVariant;
  /** Optional one-line explanation (shown in the expanded card, not collapsed). */
  hint?: string;
};

/**
 * Stripe → QuickBooks: does the Stripe charge tie to the QB deposit?
 * Derived from the Stripe payout's QB-reconciliation status. Returns null when
 * no Stripe charge/payout backs this money (brokerage/check).
 * `conflict_approved` is NOT a money discrepancy — it only means the QB deposit
 * is already booked to a gift, so the Stripe charge is waiting for a human to
 * confirm tying it in.
 */
export function stripeToQbStatus(
  status: string | null | undefined,
): ConnectionStatus | null {
  switch (status) {
    case "confirmed_reconciled":
    case "confirmed_keep":
    case "confirmed_replace":
      return { label: "Matched", variant: "default" };
    case "proposed":
      return {
        label: "Match proposed",
        variant: "secondary",
        hint: "A Stripe charge looks like this QuickBooks deposit — confirm to tie them together.",
      };
    case "conflict_approved":
      return {
        label: "Awaiting confirmation",
        variant: "secondary",
        hint: "QuickBooks is already booked to a gift; confirm to tie this Stripe charge in (not a money discrepancy).",
      };
    case "confirmed_excluded":
      return { label: "Excluded", variant: "outline" };
    case "unmatched":
      return { label: "Not matched yet", variant: "outline" };
    case null:
    case undefined:
      return null;
    default:
      return { label: status, variant: "outline" };
  }
}

/**
 * QuickBooks → Gift: is the QB deposit booked to a gift? Derived from the QB
 * staged-payment status; while still pending, it falls back to the proposed
 * gift-match edge state so the reviewer can see whether a match is waiting.
 */
export function qbToGiftStatus(args: {
  stagedStatus: string;
  giftState?: ReconciliationEdgeState | null;
}): ConnectionStatus {
  switch (args.stagedStatus) {
    case "match_confirmed":
    case "match_proposed":
      return { label: "Linked", variant: "default" };
    case "excluded":
      return { label: "Excluded", variant: "outline" };
  }
  // Still pending — describe the proposed gift match instead.
  switch (args.giftState) {
    case "determined":
      return { label: "Match proposed", variant: "secondary" };
    case "ambiguous":
      return { label: "Choose a gift", variant: "secondary" };
    case "conflict":
      return { label: "Conflict", variant: "destructive" };
    case "create":
      return { label: "New gift", variant: "secondary" };
    default:
      return { label: "Not linked yet", variant: "outline" };
  }
}

/**
 * Gift → Pledge: is the gift a payment on a pledge/opportunity? Optional —
 * returns null when no pledge is in play (so the connection row is omitted).
 */
export function giftToPledgeStatus(
  opportunityState: ReconciliationEdgeState | null | undefined,
): ConnectionStatus | null {
  switch (opportunityState) {
    case "determined":
      return { label: "On pledge", variant: "default" };
    case "ambiguous":
      return { label: "Choose a pledge", variant: "secondary" };
    case "conflict":
      return { label: "Conflict", variant: "destructive" };
    case "create":
      return { label: "New pledge", variant: "secondary" };
    default:
      return null;
  }
}

/**
 * Pull the specific, actionable reasons out of a failed reconciliation request.
 *
 * The server's consistency gate returns a 409 of the shape
 * `{ error, message, details: { issues: [{ code, message }] } }`. The generated
 * client throws an `ApiError` whose `.data` carries that parsed body, while its
 * `.message` only has the generic top-level line ("The reconciliation graph
 * isn't consistent."). The graph's client-side `blockers` cover only some gate
 * codes (donor/gift/amount), so codes like `stripe_charge_required` slip past
 * the disabled-button check and 409 on approve — leaving the reviewer with an
 * opaque error. Surface the per-issue messages so they see *what* to fix
 * (e.g. "select the Stripe charge", "the gift has no donor").
 */
export function extractGateIssues(err: unknown): string[] {
  if (!err || typeof err !== "object") return [];
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const details = (data as { details?: unknown }).details;
  if (!details || typeof details !== "object") return [];
  const issues = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  const out: string[] = [];
  for (const issue of issues) {
    if (issue && typeof issue === "object") {
      const message = (issue as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) out.push(message.trim());
    }
  }
  return out;
}

/**
 * The staged-payment resolve endpoints (split / reconcile / group) are
 * NOT idempotent: once a row flips from `pending` to a terminal state they
 * return `409 { error: "not_pending" }` ("This staged payment has already been
 * resolved."). If a successful apply's response was lost (network/timeout) or the
 * reviewer clicked Apply twice, the second pass 409s even though the money was
 * already booked. Recognize that specific case so Apply-to-CRM can self-heal
 * instead of surfacing a scary raw "HTTP 409 …" error. Duck-types the generated
 * `ApiError` (status + parsed `.data.error`) like the other helpers here.
 */
export function isAlreadyResolvedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { status?: unknown }).status !== 409) return false;
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  return (data as { error?: unknown }).error === "not_pending";
}

/**
 * A staged change awaiting Apply, reduced to just what's needed to decide whether
 * an already-resolved staged payment reached the outcome the reviewer staged.
 * `targetGiftId` is the existing gift a confirm/re-target/group links to; it is
 * null for outcomes without a single pre-chosen gift (create-a-new-gift, or a
 * split across several gifts).
 */
export interface ResolvedStateProbe {
  kind: "confirm" | "retarget" | "split";
  stagedPaymentId: string;
  targetGiftId: string | null;
}

/**
 * Given the current server state (the resolved "done" cards) for a staged
 * payment that returned the already-resolved 409, decide whether it reached
 * the outcome the reviewer staged. Used to self-heal Apply-to-CRM: a match
 * means the change quietly counts as applied; a mismatch (resolved into a
 * DIFFERENT state by a sync or another user) keeps the change with a calm
 * "already resolved" note.
 *
 *  - split / create-a-new-gift (no `targetGiftId`) → intended when the row now
 *              appears as a resolved "done" card at all (the money is booked).
 *  - confirm / re-target / group (a specific `targetGiftId`) → intended only
 *              when a resolved "done" card for the row ties to THAT gift.
 */
export function changeReachedIntendedState(
  probe: ResolvedStateProbe,
  cards: {
    done: { stagedPaymentId: string; resolvedGiftId?: string | null }[];
  },
): boolean {
  const spId = probe.stagedPaymentId;
  const done = cards.done.filter((c) => c.stagedPaymentId === spId);
  if (done.length === 0) return false;
  if (!probe.targetGiftId) return true;
  return done.some((c) => c.resolvedGiftId === probe.targetGiftId);
}

/** Snapshot of the Stripe charge currently sourcing a gift, as returned in the
 *  `gift_already_stripe_sourced` gate issue's `details.currentStripeCharge`. */
export interface StripeSourceConflict {
  currentCharge: {
    id: string;
    amount: string | null;
    payerName: string | null;
    date: string | null;
  } | null;
  targetChargeId: string | null;
}

/**
 * When a re-target 409s because the gift is already sourced from a DIFFERENT
 * Stripe charge, pull the current backing charge's details out of the gate issue
 * so the workbench can describe the swap the reviewer is about to confirm.
 * Returns null when the failure isn't a `gift_already_stripe_sourced` conflict.
 */
export function extractStripeSourceConflict(
  err: unknown,
): StripeSourceConflict | null {
  if (!err || typeof err !== "object") return null;
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const details = (data as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const issues = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") continue;
    if ((issue as { code?: unknown }).code !== "gift_already_stripe_sourced") {
      continue;
    }
    const d = (issue as { details?: unknown }).details;
    const cur =
      d && typeof d === "object"
        ? (d as { currentStripeCharge?: unknown }).currentStripeCharge
        : null;
    const target =
      d && typeof d === "object"
        ? (d as { targetStripeChargeId?: unknown }).targetStripeChargeId
        : null;
    return {
      currentCharge:
        cur && typeof cur === "object"
          ? {
              id: String((cur as { id?: unknown }).id ?? ""),
              amount:
                typeof (cur as { amount?: unknown }).amount === "string"
                  ? (cur as { amount: string }).amount
                  : null,
              payerName:
                typeof (cur as { payerName?: unknown }).payerName === "string"
                  ? (cur as { payerName: string }).payerName
                  : null,
              date:
                typeof (cur as { date?: unknown }).date === "string"
                  ? (cur as { date: string }).date
                  : null,
            }
          : null,
      targetChargeId: typeof target === "string" ? target : null,
    };
  }
  return null;
}

/** Snapshot of the incumbent QuickBooks staged payment currently linked to a
 *  gift, as returned in the `gift_already_qb_linked` gate issue's
 *  `details.currentQbPayment`. */
export interface QbLinkConflict {
  currentPayment: {
    id: string;
    amount: string | null;
    payerName: string | null;
    date: string | null;
  } | null;
  targetStagedPaymentId: string | null;
}

/**
 * When a re-target 409s because the gift is already linked to a DIFFERENT
 * QuickBooks staged payment, pull the incumbent payment's details out of the
 * gate issue so the workbench can describe the displacement the reviewer is
 * about to confirm. Returns null when the failure isn't a `gift_already_qb_linked`
 * conflict.
 */
export function extractQbLinkConflict(err: unknown): QbLinkConflict | null {
  if (!err || typeof err !== "object") return null;
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const details = (data as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const issues = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") continue;
    if ((issue as { code?: unknown }).code !== "gift_already_qb_linked") {
      continue;
    }
    const d = (issue as { details?: unknown }).details;
    const cur =
      d && typeof d === "object"
        ? (d as { currentQbPayment?: unknown }).currentQbPayment
        : null;
    const target =
      d && typeof d === "object"
        ? (d as { targetStagedPaymentId?: unknown }).targetStagedPaymentId
        : null;
    return {
      currentPayment:
        cur && typeof cur === "object"
          ? {
              id: String((cur as { id?: unknown }).id ?? ""),
              amount:
                typeof (cur as { amount?: unknown }).amount === "string"
                  ? (cur as { amount: string }).amount
                  : null,
              payerName:
                typeof (cur as { payerName?: unknown }).payerName === "string"
                  ? (cur as { payerName: string }).payerName
                  : null,
              date:
                typeof (cur as { date?: unknown }).date === "string"
                  ? (cur as { date: string }).date
                  : null,
            }
          : null,
      targetStagedPaymentId: typeof target === "string" ? target : null,
    };
  }
  return null;
}

/** The 409 payload when the PAYMENT being re-targeted is itself already applied
 *  to a different gift (a wrong worker auto-match); the currently applied gift's
 *  details ride on `details.currentAppliedGift`. */
export interface OwnApplicationConflict {
  currentGift: {
    id: string;
    name: string | null;
    amount: string | null;
    date: string | null;
  } | null;
  targetGiftId: string | null;
}

/**
 * When a re-target 409s because the QuickBooks payment itself is already
 * applied to a DIFFERENT gift (the sync worker matched it to the wrong one),
 * pull the currently applied gift's details out of the gate issue so the
 * workbench can describe the move the reviewer is about to confirm. Returns
 * null when the failure isn't a `payment_already_applied` conflict.
 */
export function extractOwnApplicationConflict(
  err: unknown,
): OwnApplicationConflict | null {
  if (!err || typeof err !== "object") return null;
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const details = (data as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const issues = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") continue;
    if ((issue as { code?: unknown }).code !== "payment_already_applied") {
      continue;
    }
    const d = (issue as { details?: unknown }).details;
    const cur =
      d && typeof d === "object"
        ? (d as { currentAppliedGift?: unknown }).currentAppliedGift
        : null;
    const target =
      d && typeof d === "object"
        ? (d as { targetGiftId?: unknown }).targetGiftId
        : null;
    return {
      currentGift:
        cur && typeof cur === "object"
          ? {
              id: String((cur as { id?: unknown }).id ?? ""),
              name:
                typeof (cur as { name?: unknown }).name === "string"
                  ? (cur as { name: string }).name
                  : null,
              amount:
                typeof (cur as { amount?: unknown }).amount === "string"
                  ? (cur as { amount: string }).amount
                  : null,
              date:
                typeof (cur as { date?: unknown }).date === "string"
                  ? (cur as { date: string }).date
                  : null,
            }
          : null,
      targetGiftId: typeof target === "string" ? target : null,
    };
  }
  return null;
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

/**
 * Derive the one-click approve body from a graph's SERVER-PROPOSED selections —
 * the auto-locked candidate on each node (`selectedId`). Used by the workbench's
 * "confirm" and "approve all high-confidence" actions, which accept the existing
 * auto-proposal as-is rather than re-picking nodes by hand. Reuses
 * deriveApproveBody so the body (and the Stripe-gross precedence) is identical to
 * the per-node reconciler. An optional gift override re-targets the match to a
 * different gift while keeping the rest of the proposal.
 *
 * Whenever a gift is in play (auto-selected OR overridden) we pass `donor: null`
 * so the link cleanly ADOPTS the gift's own donor — confirming/​re-targeting a
 * proposal must never silently SWITCH a gift's donor (that override path is
 * reserved for an explicit human donor re-pick in the per-node reconciler, which
 * surfaces a confirmation dialog this one-click flow does not). On re-target we
 * also drop the original opportunity, since the chosen gift may be unrelated to
 * the auto-proposed pledge.
 */
export function deriveApproveBodyFromProposal(
  graph: ReconciliationGraph,
  giftOverride?: ReconciliationCandidate | null,
): DeriveResult {
  const pick = (
    nodeType: "donor" | "gift" | "opportunity",
  ): ReconciliationCandidate | null => {
    const node = graph.nodes.find((n) => n.nodeType === nodeType);
    if (!node || !node.selectedId) return null;
    return node.candidates.find((c) => c.id === node.selectedId) ?? null;
  };
  const isOverride = giftOverride !== undefined;
  const gift = isOverride ? giftOverride : pick("gift");
  return deriveApproveBody({
    // Adopt the gift's donor (null) when a gift is chosen; only fall back to the
    // proposed donor for the donor-only create_gift path.
    donor: gift ? null : pick("donor"),
    gift,
    opportunity: isOverride ? null : pick("opportunity"),
    outcomeChoice: "create_gift_from_opportunity",
    overrideAmountMismatchReason: "",
    graph,
  });
}

/**
 * Human-readable labels for every staged-payment exclusion reason (including
 * reconciliation-only + legacy reasons, so historical rows still render).
 * Mirrors the labels on the legacy staged-payments page.
 */
export const EXCLUSION_REASON_LABELS: Record<
  StagedPaymentExclusionReason,
  string
> = {
  zero_amount: "Zero amount",
  loan_repayment: "Loan repayment",
  loan_proceeds: "Borrowed funds / loan proceeds",
  note_payable: "Note payable",
  earned_income: "Earned income / fees for service",
  other_revenue: "Other revenue (non-gift)",
  interest: "Interest / investment income",
  membership: "Membership contributions",
  tax_refund: "Tax refund",
  insurance: "Insurance / COBRA reimbursement",
  expense_refund: "Expense refund (non-gift)",
  expensify: "Expensify reimbursement (non-gift)",
  intercompany_transfer: "Intercompany transfer",
  miscoded_withdrawal: "Miscoded withdrawal",
  returned_wire: "Returned wire (non-gift)",
  other: "Other (not a gift)",
  processor_payout: "Processor payout (reconciled to Stripe)",
  failed_charge: "Failed charge (never settled)",
  refunded_charge: "Refunded (never booked)",
  loan: "Loan activity (legacy)",
  government_reimbursement: "Government reimbursement (legacy)",
  fiscally_sponsored: "Fiscally sponsored (legacy)",
};

/**
 * Grouped families offered in the manual "Exclude as…" picker. Reconciliation-
 * only (processor_payout) and legacy reasons are intentionally NOT offered —
 * they are only ever set by automated flows, never by hand.
 */
export const MANUAL_EXCLUSION_FAMILIES: {
  family: string;
  reasons: StagedPaymentExclusionReason[];
}[] = [
  { family: "No money", reasons: ["zero_amount"] },
  {
    family: "Loans & borrowed funds",
    reasons: ["loan_repayment", "loan_proceeds", "note_payable"],
  },
  {
    family: "Non-gift income",
    reasons: ["earned_income", "other_revenue", "interest", "membership"],
  },
  {
    family: "Refunds & reimbursements",
    reasons: ["tax_refund", "insurance", "expense_refund", "expensify"],
  },
  {
    family: "Internal movement & corrections",
    reasons: ["intercompany_transfer", "miscoded_withdrawal", "returned_wire"],
  },
  { family: "Other", reasons: ["other"] },
];
