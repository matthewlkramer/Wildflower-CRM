import { sql, type SQL } from "drizzle-orm";
import {
  stagedPayments,
  stripeStagedCharges,
  settlementLinks,
  paymentApplications,
} from "@workspace/db/schema";

/**
 * SINGLE SOURCE OF TRUTH for the derived reconciliation status of staged
 * QuickBooks payments (`staged_payments`) and staged Stripe charges
 * (`stripe_staged_charges`).
 *
 * There is NO stored status column on either table — status is a pure
 * derivation over facts, so a row can never claim a state its facts don't
 * support and nothing can silently go stale. Precedence order:
 *
 *   excluded        ⇐ exclusion_reason IS NOT NULL. The row was classified as
 *                     non-donation noise (auto or manual) — out of the money
 *                     flow entirely.
 *   match_proposed  ⇐ auto_applied AND match_confirmed_at IS NULL AND a
 *                     gift link (QB: a counted payment_applications row;
 *                     Stripe/Donorbox: matched/created gift columns). The
 *                     system applied a high-confidence match that a human has
 *                     not yet reviewed.
 *   match_confirmed ⇐ the money is booked to a CRM gift, evidenced by ANY of:
 *                       - a counted payment_applications ledger row anchored
 *                         on this row (QB — the SOLE gift-link record; covers
 *                         direct links, mints, group members, and splits; the
 *                         legacy staged gift-link columns are @deprecated,
 *                         never read, never written)
 *                       - a CONFIRMED settlement link naming this row as the
 *                         QB deposit lump (QB only — the deposit is settled
 *                         against a Stripe payout, its money booked per-charge)
 *                       - matched_gift_id / created_gift_id (Stripe charges
 *                         and Donorbox donations only)
 *   pending         ⇐ none of the above — open work awaiting review.
 *
 * `match_proposed` is checked BEFORE `match_confirmed` because a proposed row
 * also carries a gift link; human confirmation (match_confirmed_at) or
 * autoApplied=false is what promotes it.
 *
 * NOTE (drizzle footgun): these fragments reference the BASE tables. Columns
 * of an alias() table render UNQUALIFIED inside sql`` — do not pass these
 * fragments into queries that alias staged_payments / stripe_staged_charges;
 * build alias-local predicates at the call site instead.
 */

export const DERIVED_STATUSES = [
  "pending",
  "match_proposed",
  "match_confirmed",
  "excluded",
] as const;
export type DerivedStatus = (typeof DERIVED_STATUSES)[number];

/* ── staged_payments (QuickBooks) ──────────────────────────────────────── */

/** EXISTS: a confirmed settlement link names this row as the deposit lump. */
export const stagedConfirmedSettlementLinkExists: SQL<boolean> = sql`EXISTS (
  SELECT 1 FROM ${settlementLinks}
  WHERE ${settlementLinks.depositStagedPaymentId} = ${stagedPayments.id}
    AND ${settlementLinks.lifecycle} = 'confirmed'
)`;

/** EXISTS: a counted cash-application ledger row is anchored on this row. */
export const stagedCountedApplicationExists: SQL<boolean> = sql`EXISTS (
  SELECT 1 FROM ${paymentApplications}
  WHERE ${paymentApplications.paymentId} = ${stagedPayments.id}
    AND ${paymentApplications.linkRole} = 'counted'
)`;

// A system-proposed (worker/rule) application awaiting human review. The
// counted ledger row is the sole gift-link source (read cutover — the legacy
// matched/created/group columns are no longer consulted); group and split
// resolutions always carry match_confirmed_at, so only worker auto-matches and
// rule auto-mints can sit here.
const stagedProposedCondition: SQL<boolean> = sql`(
  ${stagedPayments.autoApplied} = true
  AND ${stagedPayments.matchConfirmedAt} IS NULL
  AND ${stagedCountedApplicationExists}
)`;

const stagedConfirmedEvidence: SQL<boolean> = sql`(
  ${stagedCountedApplicationExists}
  OR ${stagedConfirmedSettlementLinkExists}
)`;

/** SELECTable CASE expression emitting the derived status for a staged payment. */
export const stagedStatusSql: SQL<DerivedStatus> = sql`CASE
  WHEN ${stagedPayments.exclusionReason} IS NOT NULL THEN 'excluded'
  WHEN ${stagedProposedCondition} THEN 'match_proposed'
  WHEN ${stagedConfirmedEvidence} THEN 'match_confirmed'
  ELSE 'pending'
END`.mapWith(String) as SQL<DerivedStatus>;

/** Per-status WHERE predicates (mutually exclusive, exhaustive). */
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
    AND NOT ${stagedCountedApplicationExists}
    AND NOT ${stagedConfirmedSettlementLinkExists}
  )`,
};

/** OR-combination of per-status predicates for queue/filter params. */
export function stagedStatusIn(statuses: readonly DerivedStatus[]): SQL<boolean> {
  const parts = statuses.map((s) => stagedStatusWhere[s]);
  if (parts.length === 0) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/* ── stripe_staged_charges ─────────────────────────────────────────────── */

const chargeProposedCondition: SQL<boolean> = sql`(
  ${stripeStagedCharges.autoApplied} = true
  AND ${stripeStagedCharges.matchConfirmedAt} IS NULL
  AND (${stripeStagedCharges.matchedGiftId} IS NOT NULL OR ${stripeStagedCharges.createdGiftId} IS NOT NULL)
)`;

const chargeConfirmedEvidence: SQL<boolean> = sql`(
  ${stripeStagedCharges.matchedGiftId} IS NOT NULL
  OR ${stripeStagedCharges.createdGiftId} IS NOT NULL
)`;

/** SELECTable CASE expression emitting the derived status for a Stripe charge. */
export const chargeStatusSql: SQL<DerivedStatus> = sql`CASE
  WHEN ${stripeStagedCharges.exclusionReason} IS NOT NULL THEN 'excluded'
  WHEN ${chargeProposedCondition} THEN 'match_proposed'
  WHEN ${chargeConfirmedEvidence} THEN 'match_confirmed'
  ELSE 'pending'
END`.mapWith(String) as SQL<DerivedStatus>;

/** Per-status WHERE predicates (mutually exclusive, exhaustive). */
export const chargeStatusWhere: Record<DerivedStatus, SQL<boolean>> = {
  excluded: sql`${stripeStagedCharges.exclusionReason} IS NOT NULL`,
  match_proposed: sql`(
    ${stripeStagedCharges.exclusionReason} IS NULL
    AND ${chargeProposedCondition}
  )`,
  match_confirmed: sql`(
    ${stripeStagedCharges.exclusionReason} IS NULL
    AND NOT ${chargeProposedCondition}
    AND ${chargeConfirmedEvidence}
  )`,
  pending: sql`(
    ${stripeStagedCharges.exclusionReason} IS NULL
    AND ${stripeStagedCharges.matchedGiftId} IS NULL
    AND ${stripeStagedCharges.createdGiftId} IS NULL
  )`,
};

export function chargeStatusIn(statuses: readonly DerivedStatus[]): SQL<boolean> {
  const parts = statuses.map((s) => chargeStatusWhere[s]);
  if (parts.length === 0) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/* ── TS-side derivation (for rows already in memory) ───────────────────── */

export interface StagedStatusFacts {
  exclusionReason: string | null;
  autoApplied: boolean;
  matchConfirmedAt: Date | string | null;
  /**
   * EXISTS: a counted QB cash-application ledger row anchored on this payment.
   * The SOLE gift-link fact (read cutover) — the legacy matched/created/group
   * columns are no longer consulted. Callers must pass what they know about
   * the ledger at echo time (link/mint/split echoes → true; revert → false).
   */
  hasCountedApplication: boolean;
  /** EXISTS arm — pass when known; default false (QB-rare deposit shape). */
  hasConfirmedSettlementLink?: boolean;
}

export function deriveStagedPaymentStatus(f: StagedStatusFacts): DerivedStatus {
  if (f.exclusionReason != null) return "excluded";
  if (f.autoApplied && f.matchConfirmedAt == null && f.hasCountedApplication) {
    return "match_proposed";
  }
  if (f.hasCountedApplication || f.hasConfirmedSettlementLink === true) {
    return "match_confirmed";
  }
  return "pending";
}

export interface ChargeStatusFacts {
  exclusionReason: string | null;
  autoApplied: boolean;
  matchConfirmedAt: Date | string | null;
  matchedGiftId: string | null;
  createdGiftId: string | null;
}

export function deriveStripeChargeStatus(f: ChargeStatusFacts): DerivedStatus {
  if (f.exclusionReason != null) return "excluded";
  const linkedOrMinted = f.matchedGiftId != null || f.createdGiftId != null;
  if (f.autoApplied && f.matchConfirmedAt == null && linkedOrMinted) {
    return "match_proposed";
  }
  if (linkedOrMinted) return "match_confirmed";
  return "pending";
}

/**
 * Donorbox keeps its STORED status column (its lifecycle is genuinely
 * write-driven), but the API speaks the same derived vocabulary everywhere:
 * both legacy resolutions map to match_confirmed.
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
