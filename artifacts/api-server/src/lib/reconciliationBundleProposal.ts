import { db } from "@workspace/db";
import {
  stripePayouts,
  stripeStagedCharges,
  stagedPayments,
  giftsAndPayments,
  organizations,
  people,
  households,
} from "@workspace/db/schema";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { scoreStripeCharge } from "./stripeMatch";
import {
  scoreStagedPayment,
  candidateNamesFromReference,
  type ScoredMatch,
  type MatchMethod,
} from "./quickbooksMatch";
import { candidateGiftId } from "./stripeReconcile";
import { amountWithinFeeBand } from "./reconciliationGate";
import { maskName, type Viewer } from "./identityVisibility";

/**
 * Settlement-bundle proposal engine.
 *
 * For a settlement ANCHOR — one Stripe payout (po_…) and/or one QuickBooks
 * deposit lump (staged_payments) plus all the charges that settled in it — this
 * assembles the COMPLETE proposed reconciliation end-state as a single object:
 *
 *   • a payout↔deposit `tie`, and
 *   • one `row` per unit of money (a Stripe charge, or — for pure-QB money — the
 *     deposit line itself), each carrying a proposed donor (existing | new |
 *     unresolved) and a proposed gift outcome (match | mint | research |
 *     exclude) with confidence, provenance, warnings, and a readiness flag.
 *
 * The auto-derivation reuses the SAME scorers the per-row flows use today
 * (scoreStripeCharge / scoreStagedPayment for donor+gift; the stored
 * payout↔deposit proposal for the tie) so the bundle never invents a parallel
 * matching path. Product decision 1a: when no existing donor fits we PROPOSE a
 * new donor from the payer facts, and when no existing gift fits (but a donor
 * does) we PROPOSE minting one.
 *
 * Reactivity is a PURE boundary: `deriveProposal(base, overrides)` takes the
 * DB-loaded base + the persisted human overrides and recomputes the whole
 * proposal (warnings, readiness, summary) with no I/O. `assembleBundleProposal`
 * is the thin DB wrapper that builds the base then calls it. The atomic confirm
 * (separate module) consumes the parallel `commit` plan this returns.
 */

// ── Contract shapes (mirror lib/api-spec/openapi.yaml Bundle* schemas) ──────

export type BundleAnchorType = "qb_staged_payment" | "stripe_payout";
export type BundleConfidenceTier = "high" | "medium" | "low" | "none";
export type BundleProvenance = "auto" | "override" | "sync";
export type BundleWarningSeverity = "info" | "warning" | "blocker";
export type DonorRecordKind = "organization" | "person" | "household";
export type CandidateSource =
  | "donor_xor"
  | "payment_on_pledge"
  | "name"
  | "email"
  | "amount_date"
  | "memo"
  | "intermediary"
  | "stripe"
  | "manual";

export type StagedPaymentExclusionReason =
  | "zero_amount"
  | "membership"
  | "interest"
  | "tax_refund"
  | "other_revenue"
  | "earned_income"
  | "intercompany_transfer"
  | "other"
  | "insurance"
  | "expense_refund"
  | "expensify"
  | "returned_wire"
  | "processor_payout"
  | "loan_repayment"
  | "loan_proceeds"
  | "note_payable"
  | "miscoded_withdrawal"
  | "loan"
  | "government_reimbursement"
  | "fiscally_sponsored";

export type GiftFinalAmountSource = "human" | "stripe" | "quickbooks";
export type GiftPaymentMethod =
  | "ach"
  | "check"
  | "wire"
  | "stock"
  | "donor_box"
  | "daf_ach"
  | "daf_check"
  | "daf_bill_com";

export type PayoutReconciliationStatus =
  | "unmatched"
  | "proposed"
  | "conflict_approved"
  | "confirmed_reconciled"
  | "confirmed_excluded"
  | "confirmed_keep"
  | "confirmed_replace";

export interface BundleWarning {
  code: string;
  message: string;
  severity: BundleWarningSeverity;
}

export interface BundleNewDonorDraft {
  kind: DonorRecordKind;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

export interface ReconciliationCandidate {
  nodeType: "qb" | "donor" | "gift" | "opportunity";
  id: string;
  label: string;
  sublabel?: string | null;
  amount?: string | null;
  date?: string | null;
  confidence?: number | null;
  source?: CandidateSource | null;
  donorKind?: DonorRecordKind | null;
  donorId?: string | null;
  alreadyLinkedStagedPaymentId?: string | null;
  conflictReason?: string | null;
}

export interface BundleDonorProposal {
  kind: "existing" | "new" | "unresolved";
  donorId?: string | null;
  donorKind?: DonorRecordKind | null;
  donorName?: string | null;
  newDonor?: BundleNewDonorDraft | null;
  paymentIntermediaryId?: string | null;
  confidence?: number | null;
  confidenceTier: BundleConfidenceTier;
  source?: CandidateSource | null;
  candidates: ReconciliationCandidate[];
}

export interface BundleGiftMintDraft {
  amount: string | null;
  dateReceived?: string | null;
  paymentMethod?: GiftPaymentMethod | null;
  finalAmountSource?: GiftFinalAmountSource | null;
}

export interface BundleGiftProposal {
  kind: "match" | "mint" | "research" | "exclude";
  giftId?: string | null;
  giftName?: string | null;
  giftAmount?: string | null;
  giftDonorName?: string | null;
  mintDraft?: BundleGiftMintDraft | null;
  exclusionReason?: StagedPaymentExclusionReason | null;
  confidence?: number | null;
  confidenceTier: BundleConfidenceTier;
  source?: CandidateSource | null;
  candidates: ReconciliationCandidate[];
}

export interface BundleChargeRow {
  rowKey: string;
  stripeChargeId?: string | null;
  stagedPaymentId?: string | null;
  amount?: string | null;
  feeAmount?: string | null;
  netAmount?: string | null;
  dateReceived?: string | null;
  payerName?: string | null;
  payerEmail?: string | null;
  donor: BundleDonorProposal;
  gift: BundleGiftProposal;
  provenance: BundleProvenance;
  warnings: BundleWarning[];
  ready: boolean;
}

export type BundleTieAction = "confirm_tie" | "none" | "conflict";

export interface BundleTieProposal {
  payoutId?: string | null;
  depositStagedPaymentId?: string | null;
  status: PayoutReconciliationStatus | null;
  action: BundleTieAction;
  payoutNetAmount?: string | null;
  depositAmount?: string | null;
  chargeCount?: number | null;
  warnings: BundleWarning[];
}

export interface BundleProposalSummary {
  rowCount: number;
  matchCount: number;
  mintCount: number;
  researchCount: number;
  excludeCount: number;
  newDonorCount: number;
  warningCount: number;
  blockerCount: number;
  ready: boolean;
}

export interface DerivedBundle {
  anchorType: BundleAnchorType;
  anchorId: string;
  tie: BundleTieProposal | null;
  rows: BundleChargeRow[];
  summary: BundleProposalSummary;
  sourceFingerprint: string;
}

// ── Override shapes (persisted in reconciliation_bundle_drafts.overrides) ────

export interface BundleRowOverride {
  rowKey: string;
  donorKind?: "existing" | "new" | "unresolved" | null;
  donorId?: string | null;
  donorRecordKind?: DonorRecordKind | null;
  newDonor?: BundleNewDonorDraft | null;
  paymentIntermediaryId?: string | null;
  giftKind?: "match" | "mint" | "research" | "exclude" | null;
  giftId?: string | null;
  mintAmount?: string | null;
  exclusionReason?: StagedPaymentExclusionReason | null;
  overrideAmountMismatchReason?: string | null;
  clear?: boolean | null;
}

export interface BundleTieOverride {
  action?: "confirm_tie" | "none" | null;
  depositStagedPaymentId?: string | null;
  clear?: boolean | null;
}

export interface StoredBundleOverrides {
  rows?: Record<string, BundleRowOverride>;
  tie?: BundleTieOverride | null;
}

export interface BundleOverridesInput {
  rows?: BundleRowOverride[];
  tie?: BundleTieOverride | null;
}

// ── Internal facts + base shapes (the pure layer's inputs) ──────────────────

export interface DonorFact {
  kind: DonorRecordKind;
  name: string | null;
}

export interface GiftFact {
  amount: string | null;
  name: string | null;
  donorKind: DonorRecordKind | null;
  donorId: string | null;
  donorName: string | null;
  /** A QB staged_payments row OUTSIDE this bundle already linked to the gift. */
  linkedByStagedPaymentId: string | null;
  /** A stripe_staged_charges row OUTSIDE this bundle already linked to the gift. */
  linkedByChargeId: string | null;
}

/**
 * PURE: the row OUTSIDE this bundle whose linking to `fact`'s gift would
 * double-book, given the anchor row's kind. QuickBooks and Stripe are PARALLEL
 * evidence for one gift, so a Stripe charge only double-books against ANOTHER
 * charge, and a QB staged payment only against ANOTHER staged payment — a
 * cross-kind link (a charge onto a QB-reconciled gift, or vice versa) is
 * expected parallel evidence and must NOT block.
 */
function linkedElsewhereFor(base: BaseChargeRow, fact: GiftFact): string | null {
  return base.stripeChargeId
    ? fact.linkedByChargeId
    : fact.linkedByStagedPaymentId;
}

export interface BundleFacts {
  donors: Record<string, DonorFact>;
  gifts: Record<string, GiftFact>;
}

export interface BaseChargeRow {
  rowKey: string;
  stripeChargeId: string | null;
  stagedPaymentId: string | null;
  amount: string | null;
  feeAmount: string | null;
  netAmount: string | null;
  dateReceived: string | null;
  payerName: string | null;
  payerEmail: string | null;
  autoDonorKind: "existing" | "new" | "unresolved";
  autoDonorId: string | null;
  autoDonorRecordKind: DonorRecordKind | null;
  autoNewDonor: BundleNewDonorDraft | null;
  autoIntermediaryId: string | null;
  autoDonorConfidence: number | null;
  autoDonorSource: CandidateSource | null;
  autoGiftKind: "match" | "mint" | "research" | "exclude";
  autoGiftId: string | null;
  autoMintAmount: string | null;
  autoMintFinalSource: GiftFinalAmountSource | null;
  autoExclusionReason: StagedPaymentExclusionReason | null;
  autoGiftConfidence: number | null;
  autoGiftSource: CandidateSource | null;
  /** Set when the source row is ALREADY booked into a gift — the row is locked
   * (reflected as a match) and the confirm SKIPS it. */
  committedGiftId: string | null;
}

export interface TieBase {
  payoutId: string | null;
  depositStagedPaymentId: string | null;
  status: PayoutReconciliationStatus | null;
  payoutNetAmount: string | null;
  depositAmount: string | null;
  chargeCount: number;
  /**
   * For a `conflict_approved` payout, the gift its QuickBooks deposit was already
   * approved into (the gift a `keep` confirm preserves as the single source of
   * truth). Used to gate any per-charge gift that would double-book it.
   */
  qbConflictGiftId: string | null;
}

export interface BundleBase {
  anchorType: BundleAnchorType;
  anchorId: string;
  rows: BaseChargeRow[];
  tie: TieBase | null;
  facts: BundleFacts;
  sourceFingerprint: string;
}

/** Per-row instruction the atomic confirm consumes (parallel to DerivedBundle.rows). */
export interface BundleCommitRow {
  rowKey: string;
  stripeChargeId: string | null;
  stagedPaymentId: string | null;
  amount: string | null;
  dateReceived: string | null;
  /** True when the money is already booked — confirm SKIPS (outcome=skipped). */
  alreadyCommitted: boolean;
  donor: BundleDonorProposal;
  gift: BundleGiftProposal;
}

export interface AssembledBundle {
  proposal: DerivedBundle;
  commit: BundleCommitRow[];
}

// ── Pure helpers ────────────────────────────────────────────────────────────

const ORG_KEYWORDS =
  /\b(inc|llc|ltd|corp|co|company|foundation|fund|trust|charit\w*|societ\w*|associat\w*|partners|group|institute|university|college|school|church|ministr\w*|fdn|nonprofit|foundation)\b/i;

export function tierFromScore(score: number | null | undefined): BundleConfidenceTier {
  if (score == null || score <= 0) return "none";
  if (score >= 90) return "high";
  if (score >= 70) return "medium";
  return "low";
}

export function methodToSource(method: MatchMethod | null): CandidateSource | null {
  switch (method) {
    case "email":
      return "email";
    case "name":
      return "name";
    case "name_amount_date":
      return "amount_date";
    case "memo":
      return "memo";
    case "intermediary":
      return "intermediary";
    default:
      return null;
  }
}

function donorKey(kind: DonorRecordKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Best-guess a NEW donor record from a charge's payer facts (product decision
 * 1a). A two/three-token name with no org keyword (especially with an email)
 * reads as a person; anything else as an organization. Returns null when there
 * is nothing usable to mint from.
 */
export function proposeNewDonor(
  payerName: string | null,
  payerEmail: string | null,
): BundleNewDonorDraft | null {
  const name = (payerName ?? "").trim();
  if (!name) {
    if (payerEmail && payerEmail.trim()) {
      // Email but no name — still a person we can mint and fix later.
      return {
        kind: "person",
        name: payerEmail.trim(),
        firstName: null,
        lastName: null,
        email: payerEmail.trim(),
      };
    }
    return null;
  }
  const tokens = name.split(/\s+/).filter(Boolean);
  const looksPerson = !ORG_KEYWORDS.test(name) && tokens.length >= 2 && tokens.length <= 3;
  if (looksPerson) {
    return {
      kind: "person",
      name,
      firstName: tokens[0],
      lastName: tokens.slice(1).join(" "),
      email: payerEmail ?? null,
    };
  }
  if (tokens.length === 1 && payerEmail) {
    return {
      kind: "person",
      name,
      firstName: name,
      lastName: null,
      email: payerEmail,
    };
  }
  return { kind: "organization", name, firstName: null, lastName: null, email: payerEmail ?? null };
}

function donorCandidate(
  kind: DonorRecordKind,
  id: string,
  name: string | null,
  confidence: number | null,
  source: CandidateSource | null,
): ReconciliationCandidate {
  return {
    nodeType: "donor",
    id,
    label: name ?? "(unnamed)",
    sublabel: null,
    confidence: confidence ?? null,
    source: source ?? null,
    donorKind: kind,
    donorId: id,
  };
}

function giftCandidate(
  id: string,
  fact: GiftFact,
  confidence: number | null,
  base: BaseChargeRow,
): ReconciliationCandidate {
  return {
    nodeType: "gift",
    id,
    label: fact.name ?? "Gift",
    sublabel: fact.donorName ?? null,
    amount: fact.amount ?? null,
    confidence: confidence ?? null,
    source: "amount_date",
    donorKind: fact.donorKind ?? null,
    donorId: fact.donorId ?? null,
    alreadyLinkedStagedPaymentId: linkedElsewhereFor(base, fact),
  };
}

interface EffectiveRow {
  donor: BundleDonorProposal;
  gift: BundleGiftProposal;
  provenance: BundleProvenance;
  alreadyCommitted: boolean;
}

/**
 * PURE: resolve a base row + its override into the final donor + gift proposals
 * (display, confidence, candidates). Warnings/readiness are computed separately.
 */
function resolveRow(
  base: BaseChargeRow,
  override: BundleRowOverride | undefined,
  facts: BundleFacts,
): EffectiveRow {
  // Already-booked rows are locked: always reflect the existing gift, ignore edits.
  if (base.committedGiftId) {
    const gf = facts.gifts[base.committedGiftId];
    const donor: BundleDonorProposal =
      gf && gf.donorId && gf.donorKind
        ? {
            kind: "existing",
            donorId: gf.donorId,
            donorKind: gf.donorKind,
            donorName: gf.donorName ?? null,
            confidence: null,
            confidenceTier: "none",
            source: null,
            candidates: [donorCandidate(gf.donorKind, gf.donorId, gf.donorName, null, null)],
          }
        : {
            kind: "unresolved",
            confidence: null,
            confidenceTier: "none",
            candidates: [],
          };
    return {
      donor,
      gift: {
        kind: "match",
        giftId: base.committedGiftId,
        giftName: gf?.name ?? null,
        giftAmount: gf?.amount ?? null,
        giftDonorName: gf?.donorName ?? null,
        confidence: null,
        confidenceTier: "none",
        source: null,
        candidates: gf ? [giftCandidate(base.committedGiftId, gf, null, base)] : [],
      },
      provenance: "auto",
      alreadyCommitted: true,
    };
  }

  const hasOverride =
    !!override &&
    !override.clear &&
    (override.donorKind != null ||
      override.donorId != null ||
      override.newDonor != null ||
      override.paymentIntermediaryId != null ||
      override.giftKind != null ||
      override.giftId != null ||
      override.mintAmount != null ||
      override.exclusionReason != null ||
      override.overrideAmountMismatchReason != null);

  // ── Donor ──
  const donorKind = override?.donorKind ?? base.autoDonorKind;
  let donor: BundleDonorProposal;
  if (donorKind === "existing") {
    const id = override?.donorId ?? base.autoDonorId;
    const recordKind = override?.donorRecordKind ?? base.autoDonorRecordKind;
    const fact = id && recordKind ? facts.donors[donorKey(recordKind, id)] : undefined;
    const confidence = override?.donorId ? null : base.autoDonorConfidence;
    const source: CandidateSource | null = override?.donorId ? "manual" : base.autoDonorSource;
    donor = {
      kind: "existing",
      donorId: id ?? null,
      donorKind: recordKind ?? null,
      donorName: fact?.name ?? null,
      paymentIntermediaryId: override?.paymentIntermediaryId ?? base.autoIntermediaryId,
      confidence,
      confidenceTier: tierFromScore(confidence),
      source,
      candidates:
        id && recordKind ? [donorCandidate(recordKind, id, fact?.name ?? null, confidence, source)] : [],
    };
  } else if (donorKind === "new") {
    const newDonor = override?.newDonor ?? base.autoNewDonor;
    const confidence = override?.newDonor ? null : base.autoDonorConfidence;
    donor = {
      kind: "new",
      newDonor: newDonor ?? null,
      paymentIntermediaryId: override?.paymentIntermediaryId ?? base.autoIntermediaryId,
      confidence,
      confidenceTier: tierFromScore(confidence),
      source: override?.newDonor ? "manual" : base.autoDonorSource,
      candidates: [],
    };
  } else {
    donor = {
      kind: "unresolved",
      paymentIntermediaryId: override?.paymentIntermediaryId ?? base.autoIntermediaryId,
      confidence: null,
      confidenceTier: "none",
      candidates: [],
    };
  }

  // ── Gift ──
  const giftKind = override?.giftKind ?? base.autoGiftKind;
  let gift: BundleGiftProposal;
  if (giftKind === "match") {
    const id = override?.giftId ?? base.autoGiftId;
    const fact = id ? facts.gifts[id] : undefined;
    const confidence = override?.giftId ? null : base.autoGiftConfidence;
    const source: CandidateSource | null = override?.giftId ? "manual" : base.autoGiftSource;
    gift = {
      kind: "match",
      giftId: id ?? null,
      giftName: fact?.name ?? null,
      giftAmount: fact?.amount ?? null,
      giftDonorName: fact?.donorName ?? null,
      confidence,
      confidenceTier: tierFromScore(confidence),
      source,
      candidates: id && fact ? [giftCandidate(id, fact, confidence, base)] : [],
    };
  } else if (giftKind === "mint") {
    const amount = override?.mintAmount ?? base.autoMintAmount ?? base.amount;
    gift = {
      kind: "mint",
      mintDraft: {
        amount: amount ?? null,
        dateReceived: base.dateReceived,
        paymentMethod: null,
        finalAmountSource: base.autoMintFinalSource,
      },
      confidence: override?.mintAmount ? null : base.autoGiftConfidence,
      confidenceTier: tierFromScore(override?.mintAmount ? null : base.autoGiftConfidence),
      source: override?.mintAmount ? "manual" : base.autoGiftSource,
      candidates: [],
    };
  } else if (giftKind === "exclude") {
    gift = {
      kind: "exclude",
      exclusionReason: override?.exclusionReason ?? base.autoExclusionReason ?? null,
      confidence: null,
      confidenceTier: "none",
      candidates: [],
    };
  } else {
    gift = {
      kind: "research",
      confidence: null,
      confidenceTier: "none",
      candidates: [],
    };
  }

  return { donor, gift, provenance: hasOverride ? "override" : "auto", alreadyCommitted: false };
}

/** PURE: warnings + readiness for a resolved row. */
function rowWarnings(
  base: BaseChargeRow,
  eff: EffectiveRow,
  override: BundleRowOverride | undefined,
  facts: BundleFacts,
): { warnings: BundleWarning[]; ready: boolean } {
  const warnings: BundleWarning[] = [];
  if (eff.alreadyCommitted) return { warnings, ready: true };

  const { donor, gift } = eff;
  let ready = true;

  if (gift.kind === "research") {
    return { warnings, ready: true };
  }

  if (gift.kind === "exclude") {
    if (!gift.exclusionReason) {
      warnings.push({
        code: "exclusion_reason_required",
        message: "Pick a reason to exclude this row.",
        severity: "blocker",
      });
      ready = false;
    }
    return { warnings, ready };
  }

  if (gift.kind === "match") {
    const fact = gift.giftId ? facts.gifts[gift.giftId] : undefined;
    if (!gift.giftId) {
      warnings.push({
        code: "gift_required",
        message: "Pick a gift to match, or switch to mint/research.",
        severity: "blocker",
      });
      ready = false;
    } else if (fact && linkedElsewhereFor(base, fact)) {
      warnings.push({
        code: "gift_already_linked",
        message: "This gift is already reconciled to other settlement money.",
        severity: "blocker",
      });
      ready = false;
    }
    if (gift.giftId && fact) {
      const acked = !!override?.overrideAmountMismatchReason;
      if (!acked && !amountWithinFeeBand(base.amount, fact.amount, base.netAmount)) {
        warnings.push({
          code: "amount_mismatch",
          message: `Row amount ${base.amount ?? "?"} differs from the gift amount ${fact.amount ?? "?"}.`,
          severity: "warning",
        });
      }
      if (
        donor.kind === "existing" &&
        donor.donorId &&
        fact.donorId &&
        donor.donorId !== fact.donorId
      ) {
        warnings.push({
          code: "payer_vs_gift_donor",
          message: "The matched gift is recorded under a different donor than the payer.",
          severity: "info",
        });
      }
    }
    return { warnings, ready };
  }

  // gift.kind === "mint"
  if (donor.kind === "unresolved") {
    warnings.push({
      code: "donor_required",
      message: "Pick or create a donor before minting a gift.",
      severity: "blocker",
    });
    ready = false;
  } else if (donor.kind === "new" && !(donor.newDonor && donor.newDonor.name)) {
    warnings.push({
      code: "donor_required",
      message: "The new donor needs at least a name.",
      severity: "blocker",
    });
    ready = false;
  }
  const mintAmount = gift.mintDraft?.amount ?? null;
  if (!mintAmount || !(Number(mintAmount) > 0)) {
    warnings.push({
      code: "amount_required",
      message: "A positive amount is required to mint a gift.",
      severity: "blocker",
    });
    ready = false;
  }
  return { warnings, ready };
}

/** PURE: derive the payout↔deposit tie from its base + override. */
function deriveTie(base: TieBase | null, override: BundleTieOverride | null | undefined): BundleTieProposal | null {
  if (!base) return null;
  const warnings: BundleWarning[] = [];
  const ov = override && !override.clear ? override : undefined;
  const depositId = ov?.depositStagedPaymentId ?? base.depositStagedPaymentId;

  let action: BundleTieAction;
  if (ov?.action) {
    action = ov.action;
  } else {
    switch (base.status) {
      case "confirmed_reconciled":
      case "confirmed_excluded":
      case "confirmed_keep":
      case "confirmed_replace":
        action = "none";
        break;
      case "proposed":
        action = depositId ? "confirm_tie" : "none";
        break;
      case "conflict_approved":
        action = depositId ? "confirm_tie" : "none";
        warnings.push({
          code: "tie_conflict_approved",
          message:
            "The QuickBooks deposit was already approved into a gift; confirming reconciles it (kept, not re-booked).",
          severity: "info",
        });
        break;
      default:
        action = depositId ? "confirm_tie" : "none";
    }
  }

  // Money-safety invariant — INDEPENDENT of any tie action override: a keep
  // confirm preserves the deposit's gift as the single source of truth, so
  // downstream per-charge mint guards skip it. If we don't know WHICH gift that
  // is (a legacy/malformed conflict with no recorded gift), we can't prove a
  // per-charge gift wouldn't double-book it — so block, even if a client
  // supplies an explicit tie action, keeping the pure layer's readiness honest.
  if (base.status === "conflict_approved" && !base.qbConflictGiftId) {
    warnings.push({
      code: "tie_conflict_missing_gift",
      message:
        "This conflicting QuickBooks deposit has no recorded gift to keep. Resolve it in QuickBooks review before confirming.",
      severity: "blocker",
    });
  }

  return {
    payoutId: base.payoutId,
    depositStagedPaymentId: depositId,
    status: base.status,
    action,
    payoutNetAmount: base.payoutNetAmount,
    depositAmount: base.depositAmount,
    chargeCount: base.chargeCount,
    warnings,
  };
}

/**
 * PURE reactive boundary: given the DB-loaded base and the persisted overrides,
 * compute the full proposal + the parallel commit plan. No I/O — unit-testable.
 */
export function deriveProposal(base: BundleBase, overrides: StoredBundleOverrides): AssembledBundle {
  const rowOverrides = overrides.rows ?? {};
  const rows: BundleChargeRow[] = [];
  const commit: BundleCommitRow[] = [];

  let matchCount = 0;
  let mintCount = 0;
  let researchCount = 0;
  let excludeCount = 0;
  let newDonorCount = 0;
  let warningCount = 0;
  let blockerCount = 0;
  let allReady = true;

  // Derive the tie up front: a `conflict_approved` payout's QuickBooks deposit was
  // ALREADY approved into a (coarse) gift, which confirming KEEPS as the single
  // source of truth. Minting/matching its per-charge Stripe rows on top of that
  // kept gift would double-book the same money, so those money-writing rows must
  // be gated out (the reviewer can still defer them to research or exclude them).
  const tie = deriveTie(base.tie, overrides.tie);
  const conflictKeep = tie?.status === "conflict_approved";
  const keptGiftId = base.tie?.qbConflictGiftId ?? null;

  for (const b of base.rows) {
    const ov = rowOverrides[b.rowKey];
    const eff = resolveRow(b, ov, base.facts);
    const { warnings, ready: rowReadyBase } = rowWarnings(b, eff, ov, base.facts);
    let ready = rowReadyBase;

    if (conflictKeep) {
      if (
        !eff.alreadyCommitted &&
        (eff.gift.kind === "match" || eff.gift.kind === "mint")
      ) {
        // The kept QB gift is the single source of truth; minting/matching this
        // charge on top of it would double-book the same money.
        warnings.push({
          code: "conflict_keep_no_new_gift",
          message:
            "This payout's deposit was already approved into a kept gift; defer this charge to research or exclude it instead of booking a new gift.",
          severity: "blocker",
        });
        ready = false;
      } else if (
        eff.alreadyCommitted &&
        b.committedGiftId &&
        b.committedGiftId !== keptGiftId
      ) {
        // A charge already booked into a DIFFERENT gift is a pre-existing
        // double-book; keeping the QB gift would silently bless it. Force the
        // reviewer to resolve it out of band before confirming.
        warnings.push({
          code: "conflict_keep_foreign_gift",
          message:
            "This charge is already booked into a different gift than the kept QuickBooks gift. Resolve the duplicate before confirming.",
          severity: "blocker",
        });
        ready = false;
      }
    }

    const row: BundleChargeRow = {
      rowKey: b.rowKey,
      stripeChargeId: b.stripeChargeId,
      stagedPaymentId: b.stagedPaymentId,
      amount: b.amount,
      feeAmount: b.feeAmount,
      netAmount: b.netAmount,
      dateReceived: b.dateReceived,
      payerName: b.payerName,
      payerEmail: b.payerEmail,
      donor: eff.donor,
      gift: eff.gift,
      provenance: eff.provenance,
      warnings,
      ready,
    };
    rows.push(row);
    commit.push({
      rowKey: b.rowKey,
      stripeChargeId: b.stripeChargeId,
      stagedPaymentId: b.stagedPaymentId,
      amount: b.amount,
      dateReceived: b.dateReceived,
      alreadyCommitted: eff.alreadyCommitted,
      donor: eff.donor,
      gift: eff.gift,
    });

    if (eff.gift.kind === "match") matchCount++;
    else if (eff.gift.kind === "mint") mintCount++;
    else if (eff.gift.kind === "research") researchCount++;
    else if (eff.gift.kind === "exclude") excludeCount++;
    if (eff.donor.kind === "new") newDonorCount++;

    warningCount += warnings.length;
    blockerCount += warnings.filter((w) => w.severity === "blocker").length;
    // A non-committed row that will write money (match/mint) must be ready.
    if (!eff.alreadyCommitted && (eff.gift.kind === "match" || eff.gift.kind === "mint") && !ready) {
      allReady = false;
    }
  }

  const tieBlockers = (tie?.warnings ?? []).filter((w) => w.severity === "blocker").length;
  blockerCount += tieBlockers;
  warningCount += tie?.warnings.length ?? 0;

  const summary: BundleProposalSummary = {
    rowCount: rows.length,
    matchCount,
    mintCount,
    researchCount,
    excludeCount,
    newDonorCount,
    warningCount,
    blockerCount,
    ready: allReady && blockerCount === 0,
  };

  return {
    proposal: {
      anchorType: base.anchorType,
      anchorId: base.anchorId,
      tie,
      rows,
      summary,
      sourceFingerprint: base.sourceFingerprint,
    },
    commit,
  };
}

/**
 * PURE: fold an incoming edit set into the stored overrides (per-rowKey). A row
 * override with `clear:true` drops that row's override; a tie override with
 * `clear:true` drops the tie override. Omitted fields keep their stored value.
 */
export function mergeOverrides(
  stored: StoredBundleOverrides,
  incoming: BundleOverridesInput | null | undefined,
): StoredBundleOverrides {
  const rows: Record<string, BundleRowOverride> = { ...(stored.rows ?? {}) };
  let tie: BundleTieOverride | null | undefined = stored.tie ?? null;

  for (const r of incoming?.rows ?? []) {
    if (!r.rowKey) continue;
    if (r.clear) {
      delete rows[r.rowKey];
      continue;
    }
    const prev = rows[r.rowKey] ?? { rowKey: r.rowKey };
    const next = { ...prev, rowKey: r.rowKey } as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(r)) {
      if (k === "rowKey" || k === "clear") continue;
      if (v !== undefined) next[k] = v;
    }
    rows[r.rowKey] = next as unknown as BundleRowOverride;
  }

  if (incoming?.tie !== undefined) {
    if (incoming.tie === null || incoming.tie.clear) {
      tie = null;
    } else {
      tie = { ...(tie ?? {}), ...incoming.tie };
    }
  }

  return { rows, tie: tie ?? null };
}

// ── DB layer ────────────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

export interface ScoredSourceRow {
  rowKey: string;
  stripeChargeId: string | null;
  stagedPaymentId: string | null;
  amount: string | null;
  feeAmount: string | null;
  netAmount: string | null;
  dateReceived: string | null;
  payerName: string | null;
  payerEmail: string | null;
  status: string;
  exclusionReason: StagedPaymentExclusionReason | null;
  committedGiftId: string | null;
  match: ScoredMatch;
}

export function baseRowFrom(src: ScoredSourceRow): BaseChargeRow {
  const m = src.match;
  const donorId =
    m.donor.organizationId ?? m.donor.individualGiverPersonId ?? m.donor.householdId ?? null;
  const donorRecordKind: DonorRecordKind | null = m.donor.organizationId
    ? "organization"
    : m.donor.individualGiverPersonId
      ? "person"
      : m.donor.householdId
        ? "household"
        : null;

  let autoDonorKind: "existing" | "new" | "unresolved";
  let autoNewDonor: BundleNewDonorDraft | null = null;
  let autoDonorSource: CandidateSource | null = null;
  if (donorId && donorRecordKind) {
    autoDonorKind = "existing";
    autoDonorSource = methodToSource(m.method);
  } else {
    const nd = proposeNewDonor(src.payerName, src.payerEmail);
    if (nd) {
      autoDonorKind = "new";
      autoNewDonor = nd;
      autoDonorSource = src.payerEmail ? "email" : "name";
    } else {
      autoDonorKind = "unresolved";
    }
  }

  // Gift outcome.
  let autoGiftKind: "match" | "mint" | "research" | "exclude";
  let autoGiftId: string | null = null;
  let autoMintFinalSource: GiftFinalAmountSource | null = null;
  let autoGiftSource: CandidateSource | null = null;
  let autoExclusionReason: StagedPaymentExclusionReason | null = null;

  if (src.committedGiftId) {
    autoGiftKind = "match";
    autoGiftId = src.committedGiftId;
  } else if (src.status === "excluded") {
    autoGiftKind = "exclude";
    autoExclusionReason = src.exclusionReason;
  } else if (m.matchedGiftId) {
    autoGiftKind = "match";
    autoGiftId = m.matchedGiftId;
    autoGiftSource = "amount_date";
  } else if (autoDonorKind !== "unresolved" && m.giftCandidateCount === 0) {
    autoGiftKind = "mint";
    autoMintFinalSource = src.stripeChargeId ? "stripe" : "quickbooks";
    autoGiftSource = methodToSource(m.method);
  } else {
    // Either the donor is unresolved, or plausible existing gifts exist but none
    // is an unambiguous target — never auto-mint over money that may already be
    // recorded; surface it for a human to match or mint deliberately.
    autoGiftKind = "research";
  }

  return {
    rowKey: src.rowKey,
    stripeChargeId: src.stripeChargeId,
    stagedPaymentId: src.stagedPaymentId,
    amount: src.amount,
    feeAmount: src.feeAmount,
    netAmount: src.netAmount,
    dateReceived: src.dateReceived,
    payerName: src.payerName,
    payerEmail: src.payerEmail,
    autoDonorKind,
    autoDonorId: donorId,
    autoDonorRecordKind: donorRecordKind,
    autoNewDonor,
    autoIntermediaryId: m.intermediaryId,
    autoDonorConfidence: autoDonorKind === "existing" ? m.score : null,
    autoDonorSource,
    autoGiftKind,
    autoGiftId,
    autoMintAmount: src.amount,
    autoMintFinalSource,
    autoExclusionReason,
    autoGiftConfidence: autoGiftKind === "match" ? m.score : null,
    autoGiftSource,
    committedGiftId: src.committedGiftId,
  };
}

function fingerprint(parts: unknown): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex");
}

/** Resolve donor + gift display facts for every id referenced by the base rows
 * and the overrides (so the pure layer can render any pick). */
async function loadFacts(
  conn: DbLike,
  rows: BaseChargeRow[],
  overrides: StoredBundleOverrides,
  viewer: Viewer,
  bundleStagedIds: string[],
  bundleChargeIds: string[],
): Promise<BundleFacts> {
  const donorIds: Record<DonorRecordKind, Set<string>> = {
    organization: new Set(),
    person: new Set(),
    household: new Set(),
  };
  const giftIds = new Set<string>();

  const addDonor = (kind: DonorRecordKind | null, id: string | null): void => {
    if (kind && id) donorIds[kind].add(id);
  };

  for (const b of rows) {
    addDonor(b.autoDonorRecordKind, b.autoDonorId);
    if (b.autoGiftId) giftIds.add(b.autoGiftId);
    if (b.committedGiftId) giftIds.add(b.committedGiftId);
  }
  for (const ov of Object.values(overrides.rows ?? {})) {
    if (ov.donorId && ov.donorRecordKind) addDonor(ov.donorRecordKind, ov.donorId);
    if (ov.giftId) giftIds.add(ov.giftId);
  }

  // Gifts first (their donors feed the donor set).
  const gifts: Record<string, GiftFact> = {};
  if (giftIds.size) {
    const giftRows = await conn
      .select({
        id: giftsAndPayments.id,
        amount: giftsAndPayments.amount,
        organizationId: giftsAndPayments.organizationId,
        individualGiverPersonId: giftsAndPayments.individualGiverPersonId,
        householdId: giftsAndPayments.householdId,
      })
      .from(giftsAndPayments)
      .where(inArray(giftsAndPayments.id, [...giftIds]));

    // Which of these gifts are linked OUTSIDE this bundle (double-book guard).
    // Tracked per evidence kind: QuickBooks and Stripe are PARALLEL evidence for
    // one gift, so a cross-kind link is expected and must not block (see
    // linkedElsewhereFor).
    const linkedByStaged = new Map<string, string>();
    const linkedByCharge = new Map<string, string>();
    const stagedLinks = await conn
      .select({
        gid: sql<string>`coalesce(${stagedPayments.createdGiftId}, ${stagedPayments.matchedGiftId}, ${stagedPayments.groupReconciledGiftId})`,
        sid: stagedPayments.id,
      })
      .from(stagedPayments)
      .where(
        or(
          inArray(stagedPayments.createdGiftId, [...giftIds]),
          inArray(stagedPayments.matchedGiftId, [...giftIds]),
          inArray(stagedPayments.groupReconciledGiftId, [...giftIds]),
        ),
      );
    for (const r of stagedLinks) {
      if (r.gid && !bundleStagedIds.includes(r.sid))
        linkedByStaged.set(r.gid, r.sid);
    }
    const chargeLinks = await conn
      .select({
        gid: sql<string>`coalesce(${stripeStagedCharges.createdGiftId}, ${stripeStagedCharges.matchedGiftId})`,
        cid: stripeStagedCharges.id,
      })
      .from(stripeStagedCharges)
      .where(
        or(
          inArray(stripeStagedCharges.createdGiftId, [...giftIds]),
          inArray(stripeStagedCharges.matchedGiftId, [...giftIds]),
        ),
      );
    for (const r of chargeLinks) {
      if (r.gid && !bundleChargeIds.includes(r.cid))
        linkedByCharge.set(r.gid, r.cid);
    }

    for (const g of giftRows) {
      addDonor("organization", g.organizationId);
      addDonor("person", g.individualGiverPersonId);
      addDonor("household", g.householdId);
      gifts[g.id] = {
        amount: g.amount,
        name: g.amount != null ? `$${Number(g.amount).toFixed(2)}` : "Gift",
        donorKind: g.organizationId
          ? "organization"
          : g.individualGiverPersonId
            ? "person"
            : g.householdId
              ? "household"
              : null,
        donorId: g.organizationId ?? g.individualGiverPersonId ?? g.householdId ?? null,
        donorName: null,
        linkedByStagedPaymentId: linkedByStaged.get(g.id) ?? null,
        linkedByChargeId: linkedByCharge.get(g.id) ?? null,
      };
    }
  }

  // Donors (masked).
  const donors: Record<string, DonorFact> = {};
  if (donorIds.organization.size) {
    const orgRows = await conn
      .select({
        id: organizations.id,
        name: organizations.name,
        anonymous: organizations.anonymous,
        ownerUserId: organizations.ownerUserId,
      })
      .from(organizations)
      .where(inArray(organizations.id, [...donorIds.organization]));
    for (const o of orgRows) {
      donors[donorKey("organization", o.id)] = {
        kind: "organization",
        name: maskName(o.name, { anonymous: o.anonymous, ownerUserId: o.ownerUserId }, viewer),
      };
    }
  }
  if (donorIds.person.size) {
    const personRows = await conn
      .select({
        id: people.id,
        name: people.fullName,
        anonymous: people.anonymous,
        ownerUserId: people.ownerUserId,
      })
      .from(people)
      .where(inArray(people.id, [...donorIds.person]));
    for (const p of personRows) {
      donors[donorKey("person", p.id)] = {
        kind: "person",
        name: maskName(p.name, { anonymous: p.anonymous, ownerUserId: p.ownerUserId }, viewer),
      };
    }
  }
  if (donorIds.household.size) {
    const hhRows = await conn
      .select({ id: households.id, name: households.name })
      .from(households)
      .where(inArray(households.id, [...donorIds.household]));
    for (const h of hhRows) {
      donors[donorKey("household", h.id)] = { kind: "household", name: h.name };
    }
  }

  // Backfill each gift's donor display name now that donors are resolved.
  for (const g of Object.values(gifts)) {
    if (g.donorKind && g.donorId) {
      g.donorName = donors[donorKey(g.donorKind, g.donorId)]?.name ?? null;
    }
  }

  return { donors, gifts };
}

async function scoreCharge(c: {
  id: string;
  grossAmount: string | null;
  feeAmount: string | null;
  netAmount: string | null;
  dateReceived: string | null;
  payerName: string | null;
  payerEmail: string | null;
  description: string | null;
  statementDescriptor: string | null;
  status: string;
  exclusionReason: StagedPaymentExclusionReason | null;
  matchedGiftId: string | null;
  createdGiftId: string | null;
}): Promise<ScoredSourceRow> {
  const committedGiftId =
    c.status === "reconciled" || c.createdGiftId || c.matchedGiftId
      ? (c.createdGiftId ?? c.matchedGiftId)
      : null;
  const match = committedGiftId
    ? {
        donor: { organizationId: null, individualGiverPersonId: null, householdId: null },
        intermediaryId: null,
        matchedGiftId: null,
        giftCandidateCount: 0,
        score: 0,
        method: null,
        tier: "none" as const,
      }
    : await scoreStripeCharge({
        payerName: c.payerName,
        payerEmail: c.payerEmail,
        description: c.description,
        statementDescriptor: c.statementDescriptor,
        grossAmount: c.grossAmount,
        dateReceived: c.dateReceived,
      });
  return {
    rowKey: c.id,
    stripeChargeId: c.id,
    stagedPaymentId: null,
    amount: c.grossAmount,
    feeAmount: c.feeAmount,
    netAmount: c.netAmount,
    dateReceived: c.dateReceived,
    payerName: c.payerName,
    payerEmail: c.payerEmail,
    status: c.status,
    exclusionReason: c.exclusionReason,
    committedGiftId,
    match,
  };
}

/**
 * Load + auto-derive the bundle base for an anchor (no overrides applied). The
 * pure `deriveProposal` then folds overrides in. `conn` lets the confirm path
 * run this inside its FOR UPDATE transaction.
 */
export async function loadBundleBase(opts: {
  anchorType: BundleAnchorType;
  anchorId: string;
  overrides: StoredBundleOverrides;
  viewer: Viewer;
  conn?: DbLike;
}): Promise<BundleBase | null> {
  const conn = opts.conn ?? db;

  // Resolve the payout + deposit lump for the anchor.
  let payout:
    | {
        id: string;
        amount: string | null;
        netTotal: string | null;
        chargeCount: number | null;
        status: PayoutReconciliationStatus;
        matchedQbStagedPaymentId: string | null;
        proposedQbStagedPaymentId: string | null;
        qbConflictStagedPaymentId: string | null;
        qbConflictGiftId: string | null;
      }
    | null = null;

  if (opts.anchorType === "stripe_payout") {
    const [p] = await conn
      .select({
        id: stripePayouts.id,
        amount: stripePayouts.amount,
        netTotal: stripePayouts.netTotal,
        chargeCount: stripePayouts.chargeCount,
        status: stripePayouts.qbReconciliationStatus,
        matchedQbStagedPaymentId: stripePayouts.matchedQbStagedPaymentId,
        proposedQbStagedPaymentId: stripePayouts.proposedQbStagedPaymentId,
        qbConflictStagedPaymentId: stripePayouts.qbConflictStagedPaymentId,
        qbConflictGiftId: stripePayouts.qbConflictGiftId,
      })
      .from(stripePayouts)
      .where(eq(stripePayouts.id, opts.anchorId));
    if (!p) return null;
    payout = p;
  } else {
    // QB deposit anchor — is a Stripe payout tied to it?
    const [p] = await conn
      .select({
        id: stripePayouts.id,
        amount: stripePayouts.amount,
        netTotal: stripePayouts.netTotal,
        chargeCount: stripePayouts.chargeCount,
        status: stripePayouts.qbReconciliationStatus,
        matchedQbStagedPaymentId: stripePayouts.matchedQbStagedPaymentId,
        proposedQbStagedPaymentId: stripePayouts.proposedQbStagedPaymentId,
        qbConflictStagedPaymentId: stripePayouts.qbConflictStagedPaymentId,
        qbConflictGiftId: stripePayouts.qbConflictGiftId,
      })
      .from(stripePayouts)
      .where(
        or(
          eq(stripePayouts.matchedQbStagedPaymentId, opts.anchorId),
          eq(stripePayouts.proposedQbStagedPaymentId, opts.anchorId),
          // Defense in depth: a conflict tie also means this deposit belongs to
          // the payout bundle, never standalone QB. Callers should canonicalize
          // first, but detect it here too so a tied QB anchor can never assemble
          // as pure-QB money.
          eq(stripePayouts.qbConflictStagedPaymentId, opts.anchorId),
        ),
      );
    payout = p ?? null;
  }

  let rows: BaseChargeRow[] = [];
  let tie: TieBase | null = null;
  const fpParts: unknown[] = [opts.anchorType, opts.anchorId];

  if (payout) {
    // Stripe-backed bundle: rows = the payout's charges; tie = payout↔deposit.
    // conflict_approved keeps the deposit in qbConflictStagedPaymentId (not
    // matched/proposed), so include it or the conflict tie can't be confirmed
    // through the workbench (deriveTie needs a depositId to emit confirm_tie).
    const depositId =
      payout.matchedQbStagedPaymentId ??
      payout.proposedQbStagedPaymentId ??
      payout.qbConflictStagedPaymentId;
    let depositAmount: string | null = null;
    if (depositId) {
      const [d] = await conn
        .select({ amount: stagedPayments.amount })
        .from(stagedPayments)
        .where(eq(stagedPayments.id, depositId));
      depositAmount = d?.amount ?? null;
    }
    const charges = await conn
      .select({
        id: stripeStagedCharges.id,
        grossAmount: stripeStagedCharges.grossAmount,
        feeAmount: stripeStagedCharges.feeAmount,
        netAmount: stripeStagedCharges.netAmount,
        dateReceived: stripeStagedCharges.dateReceived,
        payerName: stripeStagedCharges.payerName,
        payerEmail: stripeStagedCharges.payerEmail,
        description: stripeStagedCharges.description,
        statementDescriptor: stripeStagedCharges.statementDescriptor,
        status: stripeStagedCharges.status,
        exclusionReason: stripeStagedCharges.exclusionReason,
        matchedGiftId: stripeStagedCharges.matchedGiftId,
        createdGiftId: stripeStagedCharges.createdGiftId,
      })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.stripePayoutId, payout.id))
      .orderBy(stripeStagedCharges.id);

    const scored = await Promise.all(charges.map((c) => scoreCharge(c)));
    rows = scored.map(baseRowFrom);
    tie = {
      payoutId: payout.id,
      depositStagedPaymentId: depositId,
      status: payout.status,
      payoutNetAmount: payout.amount ?? payout.netTotal,
      depositAmount,
      chargeCount: charges.length,
      qbConflictGiftId: payout.qbConflictGiftId,
    };
    fpParts.push({
      payout: {
        id: payout.id,
        amount: payout.amount,
        status: payout.status,
        deposit: depositId,
      },
      charges: charges.map((c) => ({
        id: c.id,
        amount: c.grossAmount,
        status: c.status,
        gift: c.createdGiftId ?? c.matchedGiftId,
      })),
    });
  } else {
    // Pure-QB money: the single staged_payments row is the only unit of money.
    const [s] = await conn
      .select({
        id: stagedPayments.id,
        amount: stagedPayments.amount,
        dateReceived: stagedPayments.dateReceived,
        payerName: stagedPayments.payerName,
        payerEmail: stagedPayments.payerEmail,
        rawReference: stagedPayments.rawReference,
        lineDescription: stagedPayments.lineDescription,
        status: stagedPayments.status,
        exclusionReason: stagedPayments.exclusionReason,
        matchedGiftId: stagedPayments.matchedGiftId,
        createdGiftId: stagedPayments.createdGiftId,
        groupReconciledGiftId: stagedPayments.groupReconciledGiftId,
      })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, opts.anchorId));
    if (!s) return null;

    const committedGiftId =
      s.status === "reconciled" || s.status === "approved" ? candidateGiftId(s) : candidateGiftId(s);
    const match = committedGiftId
      ? {
          donor: { organizationId: null, individualGiverPersonId: null, householdId: null },
          intermediaryId: null,
          matchedGiftId: null,
          giftCandidateCount: 0,
          score: 0,
          method: null,
          tier: "none" as const,
        }
      : await scoreStagedPayment({
          payerName: s.payerName,
          payerEmail: s.payerEmail,
          rawReference: s.rawReference,
          lineDescription: s.lineDescription,
          amount: s.amount,
          dateReceived: s.dateReceived,
        });

    rows = [
      baseRowFrom({
        rowKey: s.id,
        stripeChargeId: null,
        stagedPaymentId: s.id,
        amount: s.amount,
        feeAmount: null,
        netAmount: null,
        dateReceived: s.dateReceived,
        payerName: s.payerName,
        payerEmail: s.payerEmail,
        status: s.status,
        exclusionReason: s.exclusionReason,
        committedGiftId,
        match,
      }),
    ];
    tie = null;
    fpParts.push({
      staged: { id: s.id, amount: s.amount, status: s.status, gift: committedGiftId },
    });
  }

  const bundleStagedIds = rows.map((r) => r.stagedPaymentId).filter((x): x is string => !!x);
  const bundleChargeIds = rows.map((r) => r.stripeChargeId).filter((x): x is string => !!x);
  const facts = await loadFacts(
    conn,
    rows,
    opts.overrides,
    opts.viewer,
    bundleStagedIds,
    bundleChargeIds,
  );

  return {
    anchorType: opts.anchorType,
    anchorId: opts.anchorId,
    rows,
    tie,
    facts,
    sourceFingerprint: fingerprint(fpParts),
  };
}

/**
 * Assemble the full settlement-bundle proposal for an anchor: load the base from
 * live DB state, then apply the persisted overrides through the pure derive
 * boundary. Returns null when the anchor doesn't exist.
 */
export async function assembleBundleProposal(opts: {
  anchorType: BundleAnchorType;
  anchorId: string;
  overrides: StoredBundleOverrides;
  viewer: Viewer;
  conn?: DbLike;
}): Promise<AssembledBundle | null> {
  const base = await loadBundleBase(opts);
  if (!base) return null;
  return deriveProposal(base, opts.overrides);
}
