import {
  donorOf,
  donorsMatch,
  hasExactlyOneDonor,
  type LinkDonor,
} from "./quickbooksLink";
import {
  OPEN_STATUSES,
  isOpenStatus,
  type DerivedStatus,
} from "./derivedStatus";

/**
 * Shared consistency gate for the unified "complete-match" reconciler.
 *
 * Every approve outcome (link an existing gift, mint a new one, generate from an
 * opportunity) runs the SAME pure validator over the already-loaded graph rows
 * before the route commits anything. The gate never trusts UI-supplied locks —
 * the route re-derives the graph from the DB and feeds it here.
 *
 * It enforces the cross-node invariants:
 *   - the QuickBooks staged row is the REQUIRED anchor and is still OPEN for
 *     reconciliation (DERIVED status pending or match_proposed), not already
 *     match_confirmed/excluded;
 *   - the gift carries exactly one donor (Donor XOR);
 *   - when an opportunity is in play, its donor matches the gift's donor;
 *   - neither the gift nor the opportunity is archived;
 *   - a selected Stripe charge actually belongs to this payment's payout;
 *   - the evidence amount and the gift amount agree within the processor
 *     fee-band tolerance, unless a human supplies an override reason.
 *
 * It is PURE (no DB, no IO) so it is unit-testable without reconciliation data.
 */

export type GateIssueCode =
  | "qb_missing"
  | "qb_not_pending"
  | "donor_missing"
  | "donor_not_xor"
  | "gift_archived"
  | "opportunity_archived"
  | "gift_donor_mismatch_opportunity"
  | "stripe_charge_unlinked"
  | "stripe_charge_required"
  | "gift_already_stripe_sourced"
  | "gift_already_qb_linked"
  | "payment_already_applied"
  | "amount_out_of_band";

/** Human-readable snapshot of the Stripe charge that currently backs a gift,
 *  surfaced in the `gift_already_stripe_sourced` issue so the UI can describe the
 *  swap the reviewer is about to confirm. */
export interface GateStripeChargeDetails {
  id: string;
  amount: string | null;
  payerName: string | null;
  date: string | null;
}

/** Human-readable snapshot of the QuickBooks staged payment that is currently
 *  linked to a gift (the "incumbent"), surfaced in the `gift_already_qb_linked`
 *  issue so the UI can describe the displacement the reviewer is about to
 *  confirm. */
export interface GateQbPaymentDetails {
  id: string;
  amount: string | null;
  payerName: string | null;
  date: string | null;
}

/** Human-readable snapshot of the gift the ANCHOR payment is presently applied
 *  to (its own existing match), surfaced in the `payment_already_applied` issue
 *  so the UI can describe the move the reviewer is about to confirm. */
export interface GateAppliedGiftDetails {
  id: string;
  name: string | null;
  amount: string | null;
  date: string | null;
}

export interface GateIssueDetails {
  /** The Stripe charge presently sourcing the gift (for gift_already_stripe_sourced). */
  currentStripeCharge?: GateStripeChargeDetails;
  /** The charge the reviewer is trying to switch TO. */
  targetStripeChargeId?: string;
  /** The QB staged payment presently linked to the gift (for gift_already_qb_linked). */
  currentQbPayment?: GateQbPaymentDetails;
  /** The staged payment the reviewer is trying to link (displace onto). */
  targetStagedPaymentId?: string;
  /** The gift the anchor payment is presently applied to (for payment_already_applied). */
  currentAppliedGift?: GateAppliedGiftDetails;
  /** The gift the reviewer is trying to move the payment onto. */
  targetGiftId?: string;
}

export interface GateIssue {
  code: GateIssueCode;
  message: string;
  /** Extra machine-readable context for the reviewer's confirmation UI. */
  details?: GateIssueDetails;
}

export interface GateStaged {
  id: string;
  /** DERIVED status (lib/derivedStatus.ts) — the write-path guard vocabulary. */
  status: DerivedStatus;
  /** Set ONLY by the link_existing_gift route when the row is a confirmed
   *  DIRECT match (a sole counted non-mint ledger application, no mint/group
   *  membership) being re-targeted
   *  under the guarded move/displace flow. Suppresses the qb_not_pending issue
   *  for that one path — every other caller leaves it unset, so a confirmed
   *  row stays blocked everywhere else. */
  openForRelink?: boolean;
}

export interface GateGift {
  id: string;
  amount: string | null;
  archivedAt: Date | null;
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
  /**
   * The Stripe charge currently counted against this gift in the ledger, or
   * null. Replaces the retired finalAmountStripeChargeId pointer column — the
   * caller resolves this from the payment_applications ledger before calling
   * runConsistencyGate.
   */
  currentStripeChargeId?: string | null;
}

export interface GateOpportunity {
  id: string;
  archivedAt: Date | null;
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
}

export interface GateStripeCharge {
  id: string;
  stripePayoutId: string | null;
}

export interface ConsistencyGateInput {
  /** The QuickBooks staged row anchoring the match (REQUIRED for a complete match). */
  staged: GateStaged | null | undefined;
  /** The gift the evidence will be tied to (existing, or freshly built for a mint). */
  gift: GateGift;
  /** An opportunity/pledge the gift links to, when the outcome involves one. */
  opportunity?: GateOpportunity | null;
  /** The amount that will be stamped onto the gift (Stripe GROSS when a charge is
   *  selected, else the QB staged amount). */
  evidenceAmount: string | null;
  /** The processor NET (bank-deposited) amount when a Stripe charge backs the
   *  money. Lets the amount band auto-accept a gift recorded at net vs gross (the
   *  same money, a fee apart) with no override. Null/undefined for QB-only. */
  evidenceNetAmount?: string | null;
  /** A Stripe charge selected as the precise (GROSS) amount source. */
  stripeCharge?: GateStripeCharge | null;
  /** Ids of the Stripe payouts tied to the staged row; a selected charge must
   *  belong to one of them. */
  stagedPayoutIds?: string[];
  /** Count of still-unreconciled Stripe charges sitting on the tied payouts. When
   *  > 0 and no charge is selected, the precise GROSS evidence is being ignored —
   *  and because a QB-linked gift can never later adopt its Stripe charge through
   *  this route, the charge must be selected up front (Stripe precedence). */
  stripeChargesAvailable?: number;
  /** A human's free-text reason that waives the amount-band check. */
  overrideAmountMismatchReason?: string | null;
  /** When true (link_existing_gift + human-confirmed), allow re-sourcing a gift
   *  from the selected charge even though it is already sourced from a different
   *  one; the commit orphans the old charge back to the queue. */
  switchStripeSource?: boolean;
  /** The charge presently backing the gift's amount, loaded under lock by the
   *  route. Attached to the `gift_already_stripe_sourced` issue so the UI can
   *  describe what it is about to swap. */
  currentStripeChargeDetails?: GateStripeChargeDetails | null;
  /** The id of an INCUMBENT QuickBooks staged payment already QB-linked to the
   *  gift (other than the anchor being approved), resolved by the route from the
   *  cash-application ledger. When set, tying THIS payment would collide with the
   *  incumbent — blocked unless the reviewer confirms `displaceLinkedPayment`. */
  qbLinkedPaymentId?: string | null;
  /** When true (link_existing_gift + human-confirmed), allow displacing the
   *  incumbent QB payment: the commit disconnects it back to the pending queue
   *  and links this one instead. */
  displaceLinkedPayment?: boolean;
  /** The incumbent QB staged payment presently linked to the gift, loaded under
   *  lock by the route. Attached to the `gift_already_qb_linked` issue so the UI
   *  can describe the displacement it is about to perform. */
  currentQbPaymentDetails?: GateQbPaymentDetails | null;
  /** The id of the gift the ANCHOR payment is already applied to (other than the
   *  target gift), resolved by the route from the cash-application ledger. When
   *  set, applying THIS payment to the target gift would count one payment's
   *  money against two gifts (the book-once guard's dead-end 409) — blocked
   *  unless the reviewer confirms `moveOwnApplication`. */
  ownAppliedGiftId?: string | null;
  /** When true (link_existing_gift + human-confirmed), allow moving the anchor
   *  payment off the gift it is presently applied to: the commit unwinds its own
   *  existing cash-application first, then applies it to the target gift. */
  moveOwnApplication?: boolean;
  /** The gift the anchor payment is presently applied to, loaded under lock by
   *  the route. Attached to the `payment_already_applied` issue so the UI can
   *  describe the move it is about to perform. */
  currentAppliedGiftDetails?: GateAppliedGiftDetails | null;
}

/** Processor fees lower the QB/bank net below the human gross by up to ~10% + $1. */
const FEE_BAND_MULTIPLIER = 1.1;
const FEE_BAND_ADDEND = 1;
const HALF_CENT = 0.01;

/**
 * True when an evidence amount and a gift amount are plausibly the same money.
 * When the processor NET is known (a Stripe charge backs the money), that is an
 * exact constraint: the gift is the same money only inside the [net, gross]
 * window (the sole legitimate gap is gross vs net, a fee apart). Without a known
 * net (QB-only), it falls back to the heuristic band — equal to the cent, or the
 * gift (gross) within a processor fee-band above the evidence (net).
 */
export function amountWithinFeeBand(
  evidence: string | null,
  gift: string | null,
  evidenceNet?: string | null,
): boolean {
  if (evidence == null || gift == null) return evidence == null && gift == null;
  const e = Number(evidence);
  const g = Number(gift);
  if (!Number.isFinite(e) || !Number.isFinite(g)) return false;
  if (Math.abs(g - e) < HALF_CENT) return true;
  // When the processor net is known (a Stripe charge backs this money), the gift
  // legitimately sits ANYWHERE between the bank net and the donor-paid gross — the
  // sole difference is gross vs net, the same money a processor fee apart. Accept
  // the whole [net, gross] window so a pure gross/net gap needs no override.
  const net = evidenceNet == null ? NaN : Number(evidenceNet);
  if (Number.isFinite(net)) {
    // Net known ⇒ the [net, gross] window is AUTHORITATIVE (no QB fallback). A
    // gift outside it — including ABOVE the gross, which a processor fee can
    // never explain — is a real discrepancy that still needs an explicit
    // override; only a pure gross-vs-net gap auto-resolves.
    const lo = Math.min(net, e) - HALF_CENT;
    const hi = Math.max(net, e) + HALF_CENT;
    return g >= lo && g <= hi;
  }
  // QB-only fallback (no known fee): the gift (gross) sits at or just above the
  // QB net, within a generous processor fee band.
  return g >= e - HALF_CENT && g <= e * FEE_BAND_MULTIPLIER + FEE_BAND_ADDEND;
}

/** The workbench card's server-authoritative 3-state match verdict. */
export type CardStatusVerdict = "none" | "proposal" | "matched";

export interface CardVerdict {
  /** 3-state "Status:" line: matched (resolved gift) > proposal (candidate
   *  gift/donor awaiting a human) > none. */
  status: CardStatusVerdict;
  /** Bucketing verdict: a resolved gift whose amount agrees with the card's
   *  evidence within the approve gate's fee band drops out of the review
   *  column. Amount-divergent resolved gifts stay visible (still "matched")
   *  so the rest of the money can be tied to them. */
  settled: boolean;
}

/**
 * Derive the card's verdict (status + settled) server-side so the workbench
 * renders it instead of re-deriving settlement math client-side. Pure, and
 * uses the SAME authoritative fee band as the approve gate
 * (amountWithinFeeBand), so the review-column bucketing can never disagree
 * with what the gate would accept.
 *
 * Evidence precedence mirrors the gate: a source group reconciles for its
 * members' combined total (never with a per-charge net); Stripe GROSS wins
 * when a charge backs the money (with the net opening the [net, gross]
 * window); otherwise the QB amount. Unknown amounts (either side null) count
 * as settled — same convention as deriveGiftQbTie (unknown ⇒ no discrepancy
 * to hold the card in review for).
 */
export function deriveCardVerdict(card: {
  resolvedGiftId?: string | null;
  proposedGiftId?: string | null;
  proposedDonorId?: string | null;
  proposedDonorName?: string | null;
  giftState?: string | null;
  resolvedGiftAmount?: string | null;
  amount?: string | null;
  stripeGrossAmount?: string | null;
  stripeNetAmount?: string | null;
}): CardVerdict {
  const status: CardStatusVerdict = card.resolvedGiftId
    ? "matched"
    : card.proposedGiftId ||
        card.giftState === "determined" ||
        card.giftState === "ambiguous" ||
        card.proposedDonorId ||
        card.proposedDonorName
      ? "proposal"
      : "none";

  let settled = false;
  if (card.resolvedGiftId) {
    const evidence = card.stripeGrossAmount ?? card.amount ?? null;
    const evidenceNet = card.stripeNetAmount ?? null;
    const gift = card.resolvedGiftAmount ?? null;
    settled =
      evidence == null || gift == null
        ? true
        : amountWithinFeeBand(evidence, gift, evidenceNet);
  }

  return { status, settled };
}

function donorCount(d: LinkDonor): number {
  return [d.organizationId, d.individualGiverPersonId, d.householdId].filter(
    (v) => v != null,
  ).length;
}

/**
 * A staged payment (QB anchor) is "open for reconciliation" while its DERIVED
 * status (lib/derivedStatus.ts) is `pending` (fresh work) or `match_proposed`
 * (an auto-applied match a human has not yet confirmed — approving IS the
 * confirmation). The resolved states (`match_confirmed`, `excluded`) can never
 * be (re-)approved through this reconciler. The approve route and this gate
 * share this set so they can never disagree.
 */
export const APPROVABLE_STAGED_STATUSES = OPEN_STATUSES;

export function isStagedApprovable(status: DerivedStatus): boolean {
  return isOpenStatus(status);
}

/**
 * Run the consistency gate. Returns an empty array when the graph is consistent
 * and the approve may proceed, otherwise one or more issues for the caller to
 * surface (typically as a 409).
 */
export function runConsistencyGate(input: ConsistencyGateInput): GateIssue[] {
  const issues: GateIssue[] = [];
  const {
    staged,
    gift,
    opportunity,
    evidenceAmount,
    evidenceNetAmount,
    stripeCharge,
    stagedPayoutIds = [],
    stripeChargesAvailable = 0,
    overrideAmountMismatchReason,
    switchStripeSource = false,
    currentStripeChargeDetails = null,
    qbLinkedPaymentId = null,
    displaceLinkedPayment = false,
    currentQbPaymentDetails = null,
    ownAppliedGiftId = null,
    moveOwnApplication = false,
    currentAppliedGiftDetails = null,
  } = input;

  // ── QuickBooks anchor ──────────────────────────────────────────────────────
  if (!staged || !staged.id) {
    issues.push({
      code: "qb_missing",
      message:
        "A QuickBooks staged payment is required to anchor a complete match.",
    });
  } else if (!isStagedApprovable(staged.status) && staged.openForRelink !== true) {
    issues.push({
      code: "qb_not_pending",
      message: "This staged payment is no longer open for reconciliation.",
    });
  }

  // ── Donor XOR (the gift's donor is adopted onto the evidence) ───────────────
  const giftDonor = donorOf(gift);
  const giftDonorCount = donorCount(giftDonor);
  if (giftDonorCount === 0) {
    issues.push({
      code: "donor_missing",
      message: "The gift has no donor.",
    });
  } else if (giftDonorCount > 1) {
    issues.push({
      code: "donor_not_xor",
      message: "The gift must have exactly one donor (Donor XOR).",
    });
  }

  // ── Nothing archived ───────────────────────────────────────────────────────
  if (gift.archivedAt != null) {
    issues.push({
      code: "gift_archived",
      message: "The selected gift is archived.",
    });
  }

  // ── Opportunity (when in play) ─────────────────────────────────────────────
  if (opportunity) {
    if (opportunity.archivedAt != null) {
      issues.push({
        code: "opportunity_archived",
        message: "The selected opportunity is archived.",
      });
    }
    // Only a meaningful comparison when the gift carries exactly one donor.
    if (hasExactlyOneDonor(giftDonor)) {
      const oppDonor = donorOf(opportunity);
      if (!donorsMatch(giftDonor, oppDonor)) {
        issues.push({
          code: "gift_donor_mismatch_opportunity",
          message: "The gift's donor must match the opportunity's donor.",
        });
      }
    }
  }

  // ── Stripe precedence + linkage ────────────────────────────────────────────
  if (stripeCharge) {
    const payoutId = stripeCharge.stripePayoutId ?? "";
    if (!payoutId || !stagedPayoutIds.includes(payoutId)) {
      issues.push({
        code: "stripe_charge_unlinked",
        message: "The selected Stripe charge isn't part of this payment's payout.",
      });
    }
    // Re-pointing a gift already sourced from a DIFFERENT Stripe charge would
    // silently orphan that charge's evidence (the DB unique index only stops a
    // charge from backing two gifts, not a gift from swapping charges). Block it
    // UNLESS the reviewer explicitly confirmed a source switch — the commit then
    // orphans the old charge back to the unmatched-money queue and re-sources the
    // gift to this one.
    if (
      gift.currentStripeChargeId &&
      gift.currentStripeChargeId !== stripeCharge.id &&
      !switchStripeSource
    ) {
      issues.push({
        code: "gift_already_stripe_sourced",
        message:
          "This gift's amount is already sourced from a different Stripe charge.",
        details: {
          ...(currentStripeChargeDetails
            ? { currentStripeCharge: currentStripeChargeDetails }
            : {}),
          targetStripeChargeId: stripeCharge.id,
        },
      });
    }
  } else if (stripeChargesAvailable > 0) {
    // Stripe GROSS wins when a charge exists. Because tying QB evidence to the
    // gift claims it permanently, the gift could never adopt its Stripe charge
    // afterward through this route — so the charge must be chosen now.
    issues.push({
      code: "stripe_charge_required",
      message:
        "This payment has Stripe charge detail; select the Stripe charge so its gross amount is used.",
    });
  }

  // ── QB-link displacement (human-confirmed) ─────────────────────────────────
  // Tying THIS payment to a gift that is ALREADY QB-linked to a DIFFERENT staged
  // payment would collide with the ledger's one-QB-payment-per-gift guard (the
  // link commit's UPDATE would find 0 rows → a dead-end 409). Block it UNLESS the
  // reviewer explicitly confirmed the displacement — the commit then disconnects
  // the incumbent back to the pending/unmatched queue before linking this one.
  // The route only ever supplies an incumbent id OTHER than the anchor being
  // approved (it excludes the anchor from the ledger lookup).
  if (qbLinkedPaymentId && !displaceLinkedPayment) {
    issues.push({
      code: "gift_already_qb_linked",
      message:
        "This gift is already linked to a different QuickBooks staged payment.",
      details: {
        ...(currentQbPaymentDetails
          ? { currentQbPayment: currentQbPaymentDetails }
          : {}),
        ...(staged?.id ? { targetStagedPaymentId: staged.id } : {}),
      },
    });
  }

  // ── Own-application move (human-confirmed) ─────────────────────────────────
  // The ANCHOR payment itself already holds a COUNTED cash-application to a
  // DIFFERENT gift (e.g. the sync worker auto-matched it to the wrong one of two
  // identical donations). Applying it to the target gift would count one
  // payment's money against two gifts — the book-once guard hard-409s at commit
  // (payment_already_applied) with no recovery. Block it UNLESS the reviewer
  // explicitly confirmed the move — the commit then unwinds the payment's own
  // existing application (ledger rows, old gift's amount stamp, pledge + QB-tie
  // re-derivation) before applying it here. The route only ever supplies a gift
  // id OTHER than the target (it excludes the target from the ledger lookup).
  if (ownAppliedGiftId && !moveOwnApplication) {
    issues.push({
      code: "payment_already_applied",
      message:
        "This payment is already applied to a different gift (an existing match).",
      details: {
        ...(currentAppliedGiftDetails
          ? { currentAppliedGift: currentAppliedGiftDetails }
          : {}),
        targetGiftId: gift.id,
      },
    });
  }

  // ── Amount band (waivable by an explicit override reason) ───────────────────
  const overridden = (overrideAmountMismatchReason ?? "").trim().length > 0;
  if (
    !overridden &&
    !amountWithinFeeBand(evidenceAmount, gift.amount, evidenceNetAmount)
  ) {
    issues.push({
      code: "amount_out_of_band",
      message:
        "The evidence amount and the gift amount differ beyond the fee-band tolerance. Provide an override reason to approve.",
    });
  }

  return issues;
}
