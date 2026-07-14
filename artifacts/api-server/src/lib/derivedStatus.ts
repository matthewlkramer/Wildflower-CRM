import { sql, type SQL } from "drizzle-orm";
import {
  donorboxDonations,
  paymentApplications,
  settlementLinks,
  stagedPayments,
  stripeStagedCharges,
} from "@workspace/db/schema";

/**
 * Shared reconciliation lifecycle derivation.
 *
 * Stripe and Donorbox unit-to-gift status is authoritative in
 * payment_applications. QuickBooks remains in a staged cutover because direct,
 * grouped, and split QBO shapes are not all pointer-free yet.
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

export const chargeProposedApplicationExists: SQL<boolean> = sql`EXISTS (
  SELECT 1 FROM ${paymentApplications}
  WHERE ${paymentApplications.stripeChargeId} = ${stripeStagedCharges.id}
    AND ${paymentApplications.evidenceSource} = 'stripe'
    AND ${paymentApplications.linkRole} = 'counted'
    AND ${paymentApplications.lifecycle} = 'proposed'
)`;

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

/* ── donorbox_donations ────────────────────────────────────────────────── */

export const donorboxProposedApplicationExists: SQL<boolean> = sql`EXISTS (
  SELECT 1 FROM ${paymentApplications}
  WHERE ${paymentApplications.donorboxDonationId} = ${donorboxDonations.id}
    AND ${paymentApplications.evidenceSource} = 'donorbox'
    AND ${paymentApplications.linkRole} = 'counted'
    AND ${paymentApplications.lifecycle} = 'proposed'
)`;

export const donorboxConfirmedApplicationExists: SQL<boolean> = sql`EXISTS (
  SELECT 1 FROM ${paymentApplications}
  WHERE ${paymentApplications.donorboxDonationId} = ${donorboxDonations.id}
    AND ${paymentApplications.evidenceSource} = 'donorbox'
    AND ${paymentApplications.linkRole} = 'counted'
    AND ${paymentApplications.lifecycle} = 'confirmed'
)`;

const donorboxExcludedCondition: SQL<boolean> = sql`(
  ${donorboxDonations.exclusionReason} IS NOT NULL
  OR ${donorboxDonations.status} IN ('excluded', 'rejected')
)`;

export const donorboxStatusSql: SQL<DerivedStatus> = sql`CASE
  WHEN ${donorboxExcludedCondition} THEN 'excluded'
  WHEN ${donorboxProposedApplicationExists} THEN 'match_proposed'
  WHEN ${donorboxConfirmedApplicationExists} THEN 'match_confirmed'
  ELSE 'pending'
END`.mapWith(String) as SQL<DerivedStatus>;

export const donorboxStatusWhere: Record<DerivedStatus, SQL<boolean>> = {
  excluded: donorboxExcludedCondition,
  match_proposed: sql`(
    NOT ${donorboxExcludedCondition}
    AND ${donorboxProposedApplicationExists}
  )`,
  match_confirmed: sql`(
    NOT ${donorboxExcludedCondition}
    AND NOT ${donorboxProposedApplicationExists}
    AND ${donorboxConfirmedApplicationExists}
  )`,
  pending: sql`(
    NOT ${donorboxExcludedCondition}
    AND NOT ${donorboxProposedApplicationExists}
    AND NOT ${donorboxConfirmedApplicationExists}
  )`,
};

export function donorboxStatusIn(
  statuses: readonly DerivedStatus[],
): SQL<boolean> {
  const parts = statuses.map((status) => donorboxStatusWhere[status]);
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
  hasProposedApplication?: boolean;
  hasConfirmedApplication?: boolean;
  /** Deprecated compatibility facts for in-memory callers only. */
  autoApplied?: boolean;
  matchConfirmedAt?: Date | string | null;
  matchedGiftId?: string | null;
  createdGiftId?: string | null;
}

export function deriveStripeChargeStatus(facts: ChargeStatusFacts): DerivedStatus {
  if (facts.exclusionReason != null) return "excluded";
  if (facts.hasProposedApplication === true) return "match_proposed";
  if (facts.hasConfirmedApplication === true) return "match_confirmed";

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

export interface DonorboxStatusFacts {
  status: "pending" | "approved" | "rejected" | "excluded" | "reconciled";
  exclusionReason?: string | null;
  hasProposedApplication?: boolean;
  hasConfirmedApplication?: boolean;
}

export function deriveDonorboxDonationStatus(
  facts: DonorboxStatusFacts,
): DerivedStatus {
  if (
    facts.exclusionReason != null ||
    facts.status === "excluded" ||
    facts.status === "rejected"
  ) {
    return "excluded";
  }
  if (facts.hasProposedApplication === true) return "match_proposed";
  if (facts.hasConfirmedApplication === true) return "match_confirmed";

  // Compatibility only. Operational SQL queues use the ledger expressions above.
  if (facts.status === "approved" || facts.status === "reconciled") {
    return "match_confirmed";
  }
  return "pending";
}

/** Backward-compatible wrapper used by older response mappers. */
export function donorboxEmittedStatus(
  stored: DonorboxStatusFacts["status"],
): DerivedStatus {
  return deriveDonorboxDonationStatus({ status: stored });
}
