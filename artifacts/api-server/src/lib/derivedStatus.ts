import { sql, type SQL } from "drizzle-orm";
import {
  stagedPayments,
  stripeStagedCharges,
  settlementLinks,
  paymentApplications,
} from "@workspace/db/schema";

/**
 * SINGLE SOURCE OF TRUTH for reconciliation status.
 *
 * Stripe status is ledger-authoritative: proposed and confirmed states come
 * from payment_applications lifecycle rows anchored to the immutable charge id.
 * Legacy matched_gift_id / created_gift_id columns no longer determine queue
 * membership. QuickBooks remains in its staged cutover until grouped/proposal
 * semantics are fully represented in the ledger.
 */

export const DERIVED_STATUSES = [
  "pending",
  "match_proposed",
  "match_confirmed",
  "excluded",
] as const;
export type DerivedStatus = (typeof DERIVED_STATUSES)[number];

/* ── staged_payments (QuickBooks) ──────────────────────────────────────── */

export const stagedConfirmedSettlementLinkExists: SQL<boolean> = sql`EXISTS (
  SELECT 1 FROM ${settlementLinks}
  WHERE ${settlementLinks.depositStagedPaymentId} = ${stagedPayments.id}
    AND ${settlementLinks.lifecycle} = 'confirmed'
)`;

export const stagedCountedApplicationExists: SQL<boolean> = sql`EXISTS (
  SELECT 1 FROM ${paymentApplications}
  WHERE ${paymentApplications.paymentId} = ${stagedPayments.id}
    AND ${paymentApplications.linkRole} = 'counted'
    AND ${paymentApplications.lifecycle} = 'confirmed'
)`;

export const stagedAnyGiftLink: SQL<boolean> = sql`(
  ${stagedPayments.matchedGiftId} IS NOT NULL
  OR ${stagedPayments.createdGiftId} IS NOT NULL
  OR ${stagedPayments.groupReconciledGiftId} IS NOT NULL
)`;

const stagedProposedCondition: SQL<boolean> = sql`(
  ${stagedPayments.autoApplied} = true
  AND ${stagedPayments.matchConfirmedAt} IS NULL
  AND (${stagedPayments.matchedGiftId} IS NOT NULL OR ${stagedPayments.createdGiftId} IS NOT NULL)
)`;

const stagedConfirmedEvidence: SQL<boolean> = sql`(
  ${stagedAnyGiftLink}
  OR ${stagedConfirmedSettlementLinkExists}
  OR ${stagedCountedApplicationExists}
)`;

export const stagedStatusSql: SQL<DerivedStatus> = sql`CASE
  WHEN ${stagedPayments.exclusionReason} IS NOT NULL THEN 'excluded'
  WHEN ${stagedProposedCondition} THEN 'match_proposed'
  WHEN ${stagedConfirmedEvidence} THEN 'match_confirmed'
  ELSE 'pending'
END`.mapWith(String) as SQL<DerivedStatus>;

export const stagedStatusWhere: Record<DerivedStatus, SQL<boolean>> = {
  excluded: sql`${stagedPayments.exclusionReason} IS NOT NULL`,
  match_proposed: sql`(
    ${stagedPayments.exclusionReason} IS NULL
    AND ${stagedProposedCondition}
  )`,
  match_confirmed: sql`(
    ${stagedPayments.exclusionReason} IS NULL
    AND NOT ${stagedProposedCondition}
    AND ${stagedConfirmedEvidence}
  )`,
  pending: sql`(
    ${stagedPayments.exclusionReason} IS NULL
    AND ${stagedPayments.matchedGiftId} IS NULL
    AND ${stagedPayments.createdGiftId} IS NULL
    AND ${stagedPayments.groupReconciledGiftId} IS NULL
    AND NOT ${stagedConfirmedSettlementLinkExists}
    AND NOT ${stagedCountedApplicationExists}
  )`,
};

export function stagedStatusIn(statuses: readonly DerivedStatus[]): SQL<boolean> {
  const parts = statuses.map((status) => stagedStatusWhere[status]);
  if (parts.length === 0) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/* ── stripe_staged_charges ─────────────────────────────────────────────── */

/** Active system proposal anchored to this exact immutable charge id. */
export const chargeProposedApplicationExists: SQL<boolean> = sql`EXISTS (
  SELECT 1 FROM ${paymentApplications}
  WHERE ${paymentApplications.stripeChargeId} = ${stripeStagedCharges.id}
    AND ${paymentApplications.evidenceSource} = 'stripe'
    AND ${paymentApplications.linkRole} = 'counted'
    AND ${paymentApplications.lifecycle} = 'proposed'
)`;

/** Confirmed counted money application anchored to this exact charge id. */
export const chargeConfirmedApplicationExists: SQL<boolean> = sql`EXISTS (
  SELECT 1 FROM ${paymentApplications}
  WHERE ${paymentApplications.stripeChargeId} = ${stripeStagedCharges.id}
    AND ${paymentApplications.evidenceSource} = 'stripe'
    AND ${paymentApplications.linkRole} = 'counted'
    AND ${paymentApplications.lifecycle} = 'confirmed'
)`;

export const chargeStatusSql: SQL<DerivedStatus> = sql`CASE
  WHEN ${stripeStagedCharges.exclusionReason} IS NOT NULL THEN 'excluded'
  WHEN ${chargeProposedApplicationExists} THEN 'match_proposed'
  WHEN ${chargeConfirmedApplicationExists} THEN 'match_confirmed'
  ELSE 'pending'
END`.mapWith(String) as SQL<DerivedStatus>;

export const chargeStatusWhere: Record<DerivedStatus, SQL<boolean>> = {
  excluded: sql`${stripeStagedCharges.exclusionReason} IS NOT NULL`,
  match_proposed: sql`(
    ${stripeStagedCharges.exclusionReason} IS NULL
    AND ${chargeProposedApplicationExists}
  )`,
  match_confirmed: sql`(
    ${stripeStagedCharges.exclusionReason} IS NULL
    AND NOT ${chargeProposedApplicationExists}
    AND ${chargeConfirmedApplicationExists}
  )`,
  pending: sql`(
    ${stripeStagedCharges.exclusionReason} IS NULL
    AND NOT ${chargeProposedApplicationExists}
    AND NOT ${chargeConfirmedApplicationExists}
  )`,
};

export function chargeStatusIn(statuses: readonly DerivedStatus[]): SQL<boolean> {
  const parts = statuses.map((status) => chargeStatusWhere[status]);
  if (parts.length === 0) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/* ── TS-side derivation (for rows already in memory) ───────────────────── */

export interface StagedStatusFacts {
  exclusionReason: string | null;
  autoApplied: boolean;
  matchConfirmedAt: Date | string | null;
  matchedGiftId: string | null;
  createdGiftId: string | null;
  groupReconciledGiftId: string | null;
  hasConfirmedSettlementLink?: boolean;
  hasCountedApplication?: boolean;
}

export function deriveStagedPaymentStatus(facts: StagedStatusFacts): DerivedStatus {
  if (facts.exclusionReason != null) return "excluded";
  const linkedOrMinted =
    facts.matchedGiftId != null || facts.createdGiftId != null;
  if (facts.autoApplied && facts.matchConfirmedAt == null && linkedOrMinted) {
    return "match_proposed";
  }
  if (
    linkedOrMinted ||
    facts.groupReconciledGiftId != null ||
    facts.hasConfirmedSettlementLink === true ||
    facts.hasCountedApplication === true
  ) {
    return "match_confirmed";
  }
  return "pending";
}

export interface ChargeStatusFacts {
  exclusionReason: string | null;
  /** Ledger facts. Callers that select status in SQL do not need these. */
  hasProposedApplication?: boolean;
  hasConfirmedApplication?: boolean;
  /** Deprecated compatibility facts for in-memory legacy callers only. */
  autoApplied?: boolean;
  matchConfirmedAt?: Date | string | null;
  matchedGiftId?: string | null;
  createdGiftId?: string | null;
}

export function deriveStripeChargeStatus(facts: ChargeStatusFacts): DerivedStatus {
  if (facts.exclusionReason != null) return "excluded";
  if (facts.hasProposedApplication === true) return "match_proposed";
  if (facts.hasConfirmedApplication === true) return "match_confirmed";

  // Temporary compatibility fallback for in-memory callers that have not yet
  // selected ledger lifecycle facts. Operational SQL queues do not use this.
  const linkedOrMinted =
    facts.matchedGiftId != null || facts.createdGiftId != null;
  if (
    facts.autoApplied === true &&
    facts.matchConfirmedAt == null &&
    linkedOrMinted
  ) {
    return "match_proposed";
  }
  if (linkedOrMinted) return "match_confirmed";
  return "pending";
}

/**
 * Donorbox remains stored-status driven until its writer cutover is complete.
 */
export function donorboxEmittedStatus(
  stored: "pending" | "approved" | "rejected" | "excluded" | "reconciled",
): DerivedStatus {
  switch (stored) {
    case "approved":
    case "reconciled":
      return "match_confirmed";
    case "excluded":
    case "rejected":
      return "excluded";
    default:
      return "pending";
  }
}
