/**
 * Task #788 — read-time planning derivations for the pledge detail.
 *
 * Single authority for the derived forecast values exposed on
 * GET /opportunities-and-pledges/{id}:
 *
 *   plannedCollectionAmount — SUM(sub_amount) across the pledge's allocations;
 *     the total the team currently plans to collect. For cost-reimbursement
 *     pledges this (NOT the award ceiling) is the forecast.
 *   plannedGoalCreditAmount — SUM(sub_amount) across allocations that count
 *     toward the fundraising goal. `direct`-tagged allocations are always
 *     excluded. On a COST-REIMBURSEMENT pledge an allocation with NULL
 *     reimbursementType is un-planned (excluded + surfaced as a planning gap);
 *     on fixed commitments untagged allocations keep counting (today's rule).
 *   unplannedAwardCapacity — cost-reimbursement only (null otherwise):
 *     ceiling minus plannedCollectionAmount, clamped at 0. INFORMATIONAL ONLY —
 *     never a drawdown balance, never spawns tasks or workflow.
 *   planningComplete / planningGaps — post-win planning-completeness signal
 *     (guidance badge, never a write block). Fixed commitment: allocations
 *     exist AND an installment schedule is entered. Cost reimbursement:
 *     allocations exist AND every allocation has fiscal year, amount,
 *     reimbursementType, recipient entity, and intended use (a project-tagged
 *     use also needs its fundable project; the restriction axes are NOT NULL
 *     with defaults, so they are always coded and never a gap). Vacuously
 *     complete for un-won records.
 *
 * Never persisted — no stored columns, no route-local twins.
 */

export interface PlanningAllocationInput {
  subAmount: string | null;
  grantYear: string | null;
  reimbursementType: string | null;
  entityId: string | null;
  intendedUsage: string | null;
  fundableProjectId: string | null;
}

export interface PlanningInput {
  // Derived header status ('open' | 'pledge' | 'cash_in' | 'lost' | 'dormant').
  status: string | null;
  disbursementModel: string | null; // 'fixed_commitment' | 'cost_reimbursement'
  awardedAmount: string | number | null;
  allocations: PlanningAllocationInput[];
  expectedPaymentCount: number;
}

export interface PlanningDerived {
  plannedCollectionAmount: string;
  plannedGoalCreditAmount: string;
  unplannedAwardCapacity: string | null;
  planningComplete: boolean;
  planningGaps: string[];
}

const money = (n: number): string => n.toFixed(2);

export function derivePledgePlanning(input: PlanningInput): PlanningDerived {
  const isCostReimbursement = input.disbursementModel === "cost_reimbursement";

  let planned = 0;
  let goalCredit = 0;
  let missingReimbursementType = 0;
  let missingFiscalYear = 0;
  let missingAmount = 0;
  let missingEntity = 0;
  let missingPurpose = 0;
  for (const a of input.allocations) {
    const amt = a.subAmount == null ? null : Number(a.subAmount);
    if (amt != null && Number.isFinite(amt)) planned += amt;
    if (a.reimbursementType == null) missingReimbursementType += 1;
    if (a.grantYear == null) missingFiscalYear += 1;
    if (amt == null || !Number.isFinite(amt)) missingAmount += 1;
    if (a.entityId == null) missingEntity += 1;
    // Purpose: intendedUsage is required; 'project' additionally needs the
    // fundable project it points at. (The three restriction axes are NOT NULL
    // with defaults, so they are always coded and never a gap here.)
    if (
      a.intendedUsage == null ||
      (a.intendedUsage === "project" && a.fundableProjectId == null)
    ) {
      missingPurpose += 1;
    }
    // Goal credit: direct always excluded; on cost-reimbursement an untagged
    // allocation is un-planned (excluded), on fixed it keeps counting.
    const countsForGoal =
      a.reimbursementType === "direct"
        ? false
        : a.reimbursementType != null || !isCostReimbursement;
    if (countsForGoal && amt != null && Number.isFinite(amt)) goalCredit += amt;
  }

  const awardedNum = Number(input.awardedAmount ?? 0);
  const unplannedAwardCapacity = isCostReimbursement
    ? money(Math.max(0, (Number.isFinite(awardedNum) ? awardedNum : 0) - planned))
    : null;

  // Planning completeness is a POST-WIN signal only.
  const won = input.status === "pledge" || input.status === "cash_in";
  const gaps: string[] = [];
  if (won) {
    if (input.allocations.length === 0) {
      gaps.push("No allocations entered — add the collection plan.");
    }
    if (isCostReimbursement) {
      if (missingReimbursementType > 0) {
        gaps.push(
          `${missingReimbursementType} allocation${missingReimbursementType === 1 ? "" : "s"} missing direct/indirect (reimbursement type) — excluded from goal credit until tagged.`,
        );
      }
      if (missingFiscalYear > 0) {
        gaps.push(
          `${missingFiscalYear} allocation${missingFiscalYear === 1 ? "" : "s"} missing a fiscal year.`,
        );
      }
      if (missingAmount > 0) {
        gaps.push(
          `${missingAmount} allocation${missingAmount === 1 ? "" : "s"} missing an amount.`,
        );
      }
      if (missingEntity > 0) {
        gaps.push(
          `${missingEntity} allocation${missingEntity === 1 ? "" : "s"} missing a recipient entity.`,
        );
      }
      if (missingPurpose > 0) {
        gaps.push(
          `${missingPurpose} allocation${missingPurpose === 1 ? "" : "s"} missing an intended use (or a fundable project for project-tagged use).`,
        );
      }
    } else {
      if (input.expectedPaymentCount === 0) {
        gaps.push("No installment schedule entered — add the expected payments.");
      }
    }
  }

  return {
    plannedCollectionAmount: money(planned),
    plannedGoalCreditAmount: money(goalCredit),
    unplannedAwardCapacity,
    planningComplete: gaps.length === 0,
    planningGaps: gaps,
  };
}
