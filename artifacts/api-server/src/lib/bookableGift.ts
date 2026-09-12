// ─── Bookable-gift standard — the ONE incomplete-gift derivation ─────────────
//
// Task #585. A gift is "bookable" (ready to record correctly in QuickBooks) when
// it carries all the critical coding info the finance team needs. Anything
// missing makes it "incomplete" and surfaces in the reconciliation workbench's
// "Incomplete gift record" report.
//
// This module holds BOTH halves of the standard and they MUST stay in lockstep:
//   1. `deriveGiftBookable` — the pure TS predicate producing the per-gift
//      list of missing-info reasons (used by the report endpoint to explain
//      each row, and safe to reuse anywhere a gift + its allocations are known).
//   2. `giftIsIncompleteExpr` — the SQL boolean that the report query filters
//      on. It encodes the EXACT same checklist so the queue and the reasons
//      never disagree.
//
// The checklist (off-books gifts are EXEMPT, mirroring quickbooks_tie_status):
//   1. Donor XOR — exactly one of organization / individual / household.
//   2. Amount and date received present.
//   3. Entity attribution — every allocation has a non-null entityId.
//   4. Fiscal year — every allocation has a grantYear.
//   5. Restriction reviewed — represented by entity + intendedUsage being set
//      (design-note resolution: the 3 axes are NOT NULL DEFAULT 'unrestricted',
//      so a reviewer is known to have looked only once they set entity + usage;
//      those are already required by #3 and #6, so no separate flag is needed).
//   6. Intended usage — every allocation has an intendedUsage; when it is
//      'project', a fundableProjectId is set.
//   7. Restriction evidence — if ANY axis is donor_restricted, the gift needs
//      BOTH the exact governing source language on each restricted allocation
//      and either a grant letter or an online-source link.
//   8. Reporting deadline — if the linked opportunity says reporting is
//      required, a reporting_deadline task must exist for that opportunity.
//
// CORRELATION follows the bare-column rule (literal gift-id SQL expr) — see
// giftPaymentSummary.ts / .agents/memory/drizzle-sql-template-bare-column.md.
import { sql, type SQL } from "drizzle-orm";
import { anyDonorRestricted } from "@workspace/api-zod";
import { DEFAULT_GIFT_ID_SQL, giftIsOffBooksExpr } from "./giftPaymentSummary.js";

// ── Reason taxonomy ─────────────────────────────────────────────────────────
export const BOOKABLE_REASONS = [
  "missing_donor",
  "missing_amount",
  "missing_date",
  "no_allocations",
  "missing_allocation_amount",
  "missing_entity",
  "missing_fiscal_year",
  "missing_intended_usage",
  "missing_fundable_project",
  "missing_restriction_evidence",
  "missing_restriction_language",
  "missing_reporting_requirement_decision",
  "missing_reporting_deadline",
] as const;
export type BookableReason = (typeof BOOKABLE_REASONS)[number];

/** Human-readable label for each reason (shared with the UI via the API). */
export const BOOKABLE_REASON_LABELS: Record<BookableReason, string> = {
  missing_donor: "Donor not set (needs exactly one)",
  missing_amount: "Amount missing",
  missing_date: "Date received missing",
  no_allocations: "No allocation rows",
  missing_allocation_amount: "Amount missing on an allocation",
  missing_entity: "Entity attribution missing on an allocation",
  missing_fiscal_year: "Fiscal year missing on an allocation",
  missing_intended_usage: "Intended usage missing on an allocation",
  missing_fundable_project: "Fundable project missing for a project allocation",
  missing_restriction_evidence:
    "Restricted gift needs a grant letter or online-source link",
  missing_restriction_language:
    "Restricted allocation needs the exact governing source language",
  missing_reporting_requirement_decision:
    "Donor reporting requirement has not been reviewed",
  missing_reporting_deadline: "Reporting deadline task missing",
};

// ── Pure TS predicate ───────────────────────────────────────────────────────
export interface BookableGiftAllocationInput {
  subAmount: string | null;
  entityId: string | null;
  grantYear: string | null;
  intendedUsage: string | null;
  fundableProjectId: string | null;
  regionalRestrictionType: string | null;
  otherRestrictionType: string | null;
  timeRestrictionType: string | null;
  purposeVerbatim: string | null;
}

export interface BookableGiftInput {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
  amount: string | null;
  dateReceived: string | null;
  /** Grant letter on the gift or its linked opportunity/pledge. */
  grantLetterUrl: string | null;
  sourceRecordUrl: string | null;
  /** Whether the gift is off-books (all allocations on non-payment entities). */
  isOffBooks: boolean;
  allocations: BookableGiftAllocationInput[];
  hasOpportunity: boolean;
  /** Linked opportunity's explicit reporting decision; null means unreviewed. */
  reportRequired: boolean | null;
  /** A reporting_deadline task exists for the linked opportunity. */
  hasReportingDeadlineTask: boolean;
}

function present(v: string | null | undefined): boolean {
  return v != null && v !== "";
}

/**
 * The pure bookable-gift predicate. Off-books gifts are always bookable
 * (exempt). Otherwise returns the list of every failing checklist item.
 *
 * KEEP IN LOCKSTEP with `giftIsIncompleteExpr` below.
 */
export function deriveGiftBookable(input: BookableGiftInput): {
  bookable: boolean;
  reasons: BookableReason[];
} {
  if (input.isOffBooks) return { bookable: true, reasons: [] };

  const reasons: BookableReason[] = [];

  const donorCount = [
    input.organizationId,
    input.individualGiverPersonId,
    input.householdId,
  ].filter((v) => present(v)).length;
  if (donorCount !== 1) reasons.push("missing_donor");

  if (!present(input.amount)) reasons.push("missing_amount");
  if (!present(input.dateReceived)) reasons.push("missing_date");

  const allocs = input.allocations;
  if (allocs.length === 0) {
    reasons.push("no_allocations");
  } else {
    if (allocs.some((a) => !present(a.subAmount)))
      reasons.push("missing_allocation_amount");
    if (allocs.some((a) => !present(a.entityId))) reasons.push("missing_entity");
    if (allocs.some((a) => !present(a.grantYear)))
      reasons.push("missing_fiscal_year");
    if (allocs.some((a) => !present(a.intendedUsage)))
      reasons.push("missing_intended_usage");
    if (
      allocs.some(
        (a) => a.intendedUsage === "project" && !present(a.fundableProjectId),
      )
    )
      reasons.push("missing_fundable_project");
  }

  const restricted = allocs.some((a) =>
    anyDonorRestricted(
      a.regionalRestrictionType,
      a.otherRestrictionType,
      a.timeRestrictionType,
    ),
  );
  if (restricted && !present(input.grantLetterUrl) && !present(input.sourceRecordUrl))
    reasons.push("missing_restriction_evidence");
  if (
    allocs.some(
      (a) =>
        anyDonorRestricted(
          a.regionalRestrictionType,
          a.otherRestrictionType,
          a.timeRestrictionType,
        ) && !present(a.purposeVerbatim),
    )
  )
    reasons.push("missing_restriction_language");

  if (input.hasOpportunity && input.reportRequired == null)
    reasons.push("missing_reporting_requirement_decision");
  if (input.reportRequired === true && !input.hasReportingDeadlineTask)
    reasons.push("missing_reporting_deadline");

  return { bookable: reasons.length === 0, reasons };
}

// ── SQL helpers (lockstep with the TS predicate) ────────────────────────────

/**
 * True when the linked opportunity's CRM record requires donor reporting.
 * False when the gift has no linked opportunity.
 */
export function giftReportRequiredExpr(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM gifts_and_payments grr
    JOIN opportunities_and_pledges opr
      ON opr.id = grr.opportunity_id
    WHERE grr.opportunity_id IS NOT NULL
      AND grr.id = ${giftIdSql}
      AND opr.reporting_required = true
  )`;
}

/** True when a linked opportunity has not had its reporting requirement reviewed. */
export function giftReportingDecisionMissingExpr(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM gifts_and_payments grd
    JOIN opportunities_and_pledges opd
      ON opd.id = grd.opportunity_id
    WHERE grd.id = ${giftIdSql}
      AND opd.reporting_required IS NULL
  )`;
}

/**
 * True when a reporting_deadline task exists for the gift's linked opportunity.
 */
export function giftHasReportingTaskExpr(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM tasks t
    JOIN gifts_and_payments grt ON grt.id = ${giftIdSql}
    WHERE grt.opportunity_id IS NOT NULL
      AND t.kind = 'reporting_deadline'
      AND t.opportunity_ids @> ARRAY[grt.opportunity_id]
  )`;
}

/**
 * The SQL boolean that filters INCOMPLETE gifts for the report query. Encodes
 * the exact checklist in `deriveGiftBookable`. Off-books gifts are exempt.
 *
 * KEEP IN LOCKSTEP with `deriveGiftBookable` above.
 */
export function giftIsIncompleteExpr(
  giftIdSql: SQL = DEFAULT_GIFT_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`(
    NOT ${giftIsOffBooksExpr(giftIdSql)}
    AND (
      EXISTS (
        SELECT 1 FROM gifts_and_payments gi
        WHERE gi.id = ${giftIdSql}
          AND (
            num_nonnulls(gi.organization_id, gi.individual_giver_person_id, gi.household_id) <> 1
            OR gi.amount IS NULL
            OR gi.date_received IS NULL
            OR (
              gi.grant_letter_url IS NULL
              AND gi.source_record_url IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM opportunities_and_pledges ore
                WHERE ore.id = gi.opportunity_id
                  AND ore.grant_letter_url IS NOT NULL
              )
              AND EXISTS (
                SELECT 1 FROM gift_allocations gar
                WHERE gar.gift_id = ${giftIdSql}
                  AND (
                    gar.regional_restriction_type = 'donor_restricted'
                    OR gar.other_restriction_type = 'donor_restricted'
                    OR gar.time_restriction_type = 'donor_restricted'
                  )
              )
            )
          )
      )
      OR NOT EXISTS (
        SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = ${giftIdSql}
      )
      OR EXISTS (
        SELECT 1 FROM gift_allocations ga
        WHERE ga.gift_id = ${giftIdSql}
          AND (
            ga.sub_amount IS NULL
            OR ga.entity_id IS NULL
            OR ga.grant_year IS NULL
            OR ga.intended_usage IS NULL
            OR (ga.intended_usage = 'project' AND ga.fundable_project_id IS NULL)
            OR (
              (
                ga.regional_restriction_type = 'donor_restricted'
                OR ga.other_restriction_type = 'donor_restricted'
                OR ga.time_restriction_type = 'donor_restricted'
              )
              AND NULLIF(TRIM(ga.purpose_verbatim), '') IS NULL
            )
          )
      )
      OR (
        ${giftReportingDecisionMissingExpr(giftIdSql)}
      )
      OR (
        ${giftReportRequiredExpr(giftIdSql)}
        AND NOT ${giftHasReportingTaskExpr(giftIdSql)}
      )
    )
  )`;
}
