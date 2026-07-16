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
 *                     counted payment_applications row anchored on this row
 *                     (QB and Stripe alike — the ledger is the SOLE gift-link
 *                     record). The system applied a high-confidence match that
 *                     a human has not yet reviewed.
 *   match_confirmed ⇐ the money is booked to a CRM gift, evidenced by ANY of:
 *                       - a counted payment_applications ledger row anchored
 *                         on this row (the SOLE gift-link record for QB staged
 *                         payments AND Stripe charges; covers direct links,
 *                         mints, group members, and splits; ALL legacy gift-
 *                         pointer columns — staged_payments AND
 *                         stripe_staged_charges matched/created — are
 *                         @deprecated, never read, never written)
 *                       - a CONFIRMED settlement link naming this row as the
 *                         QB deposit lump (QB only — the deposit is settled
 *                         against a Stripe payout, its money booked per-charge)
 *                       - a CONFIRMED charge-grain tie claiming this row (QB
 *                         only — a Stripe charge of an individually-booked
 *                         payout names it via linked_qb_staged_payment_id;
 *                         the gift booking lives on the CHARGE, moved there
 *                         by chargeTieSupersede.ts)
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

/** EXISTS: a BOOKED charge-grain tie claims this row — some Stripe charge
 *  (of an individually-booked payout) names it as its QB record AND that
 *  charge carries a counted ledger row (the gift booking lives on the CHARGE,
 *  moved there by chargeTieSupersede.ts). Mere linkage is NOT evidence: a
 *  refunded or not-yet-booked tied charge leaves the QB row's own status
 *  untouched (the refund sweep and the workbench still own that work). */
export const stagedChargeTieExists: SQL<boolean> = sql`EXISTS (
  SELECT 1 FROM ${stripeStagedCharges}
  WHERE ${stripeStagedCharges.linkedQbStagedPaymentId} = ${stagedPayments.id}
    AND EXISTS (
      SELECT 1 FROM ${paymentApplications}
      WHERE ${paymentApplications.stripeChargeId} = ${stripeStagedCharges.id}
        AND ${paymentApplications.evidenceSource} = 'stripe'
        AND ${paymentApplications.linkRole} = 'counted'
    )
)`;

/** EXISTS: RAW charge-grain tie linkage — some Stripe charge names this row,
 *  booked or not. This is the CLAIM fact (pick-list blockers, eligibility
 *  filters): re-tying the row elsewhere would conflict even before the
 *  charge's money is booked. Never use it as status evidence — that is
 *  `stagedChargeTieExists` (which additionally requires the booking). */
export const stagedChargeTieLinkExists: SQL<boolean> = sql`EXISTS (
  SELECT 1 FROM ${stripeStagedCharges}
  WHERE ${stripeStagedCharges.linkedQbStagedPaymentId} = ${stagedPayments.id}
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
  OR ${stagedChargeTieExists}
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
    AND NOT ${stagedChargeTieExists}
  )`,
};

/** OR-combination of per-status predicates for queue/filter params. */
export function stagedStatusIn(statuses: readonly DerivedStatus[]): SQL<boolean> {
  const parts = statuses.map((s) => stagedStatusWhere[s]);
  if (parts.length === 0) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/* ── stripe_staged_charges ─────────────────────────────────────────────── */

/** EXISTS: a counted Stripe cash-application ledger row anchored on this charge. */
export const chargeCountedApplicationExists: SQL<boolean> = sql`EXISTS (
  SELECT 1 FROM ${paymentApplications}
  WHERE ${paymentApplications.stripeChargeId} = ${stripeStagedCharges.id}
    AND ${paymentApplications.evidenceSource} = 'stripe'
    AND ${paymentApplications.linkRole} = 'counted'
)`;

const chargeProposedCondition: SQL<boolean> = sql`(
  ${stripeStagedCharges.autoApplied} = true
  AND ${stripeStagedCharges.matchConfirmedAt} IS NULL
  AND ${chargeCountedApplicationExists}
)`;

const chargeConfirmedEvidence: SQL<boolean> = chargeCountedApplicationExists;

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
    AND NOT ${chargeCountedApplicationExists}
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
  /** EXISTS arm — a BOOKED charge-grain tie claims this row (some Stripe
   * charge's linked_qb_staged_payment_id names it AND that charge carries a
   * counted ledger row). Mere linkage is NOT evidence — pass true only when
   * the tied charge's booking is known-counted; default false. */
  hasConfirmedChargeTie?: boolean;
}

export function deriveStagedPaymentStatus(f: StagedStatusFacts): DerivedStatus {
  if (f.exclusionReason != null) return "excluded";
  if (f.autoApplied && f.matchConfirmedAt == null && f.hasCountedApplication) {
    return "match_proposed";
  }
  if (
    f.hasCountedApplication ||
    f.hasConfirmedSettlementLink === true ||
    f.hasConfirmedChargeTie === true
  ) {
    return "match_confirmed";
  }
  return "pending";
}

export interface ChargeStatusFacts {
  exclusionReason: string | null;
  autoApplied: boolean;
  matchConfirmedAt: Date | string | null;
  /**
   * EXISTS: a counted Stripe cash-application ledger row anchored on this
   * charge. The SOLE gift-link fact (read cutover) — the legacy
   * matched_gift_id / created_gift_id columns were dropped (0126). Callers
   * pass what they know about the ledger at echo time (link/mint echoes →
   * true; revert → false).
   */
  hasCountedApplication: boolean;
}

export function deriveStripeChargeStatus(f: ChargeStatusFacts): DerivedStatus {
  if (f.exclusionReason != null) return "excluded";
  if (f.autoApplied && f.matchConfirmedAt == null && f.hasCountedApplication) {
    return "match_proposed";
  }
  if (f.hasCountedApplication) return "match_confirmed";
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
