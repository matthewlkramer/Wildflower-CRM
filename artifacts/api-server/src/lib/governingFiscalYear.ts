import { db } from "@workspace/db";
import { fiscalYears, pledgeAllocations } from "@workspace/db/schema";
import { and, asc, eq, gte, isNotNull, lte } from "drizzle-orm";

/**
 * "Governing fiscal year" — the single FY whose external-audit close FREEZES a
 * money record. Once that FY's `auditClosedAt` is set, the record is immutable
 * and any correction must be booked as a NEW record in the current open FY (see
 * the gift-booking-lifecycle / audit-close model).
 *
 *   - A GIFT is governed by the FY whose [startDate, endDate] window contains its
 *     `date_received` — cash lands in exactly one fiscal year.
 *   - A PLEDGE is governed by its "recognized" FY. A pledge can carry allocations
 *     across several grant years (a multi-year grant), so we take the EARLIEST
 *     grant-year allocation (by FY start date) as the recognition year — the year
 *     the commitment was first booked.
 *
 *     ASSUMPTION (flagged for confirmation): earliest-grant-year = recognized FY.
 *     This is advisory in the pre-close checklist and only GATES writes once the
 *     freeze guards land; revisit here if the team recognizes multi-year pledges
 *     per-allocation instead of whole-record.
 */

export interface GoverningFiscalYear {
  id: string;
  label: string;
  auditClosedAt: Date | null;
}

const govCols = {
  id: fiscalYears.id,
  label: fiscalYears.label,
  auditClosedAt: fiscalYears.auditClosedAt,
};

/** True once this FY's external audit has been closed (record is frozen). */
export function isFiscalYearAuditClosed(
  fy: Pick<GoverningFiscalYear, "auditClosedAt"> | null | undefined,
): boolean {
  return !!fy?.auditClosedAt;
}

/** The FY whose date window contains a gift's `date_received`, or null when the
 * date is unset or no FY range contains it. */
export async function getGiftGoverningFiscalYear(
  dateReceived: string | null | undefined,
): Promise<GoverningFiscalYear | null> {
  if (!dateReceived) return null;
  const [row] = await db
    .select(govCols)
    .from(fiscalYears)
    .where(
      and(
        isNotNull(fiscalYears.startDate),
        isNotNull(fiscalYears.endDate),
        lte(fiscalYears.startDate, dateReceived),
        gte(fiscalYears.endDate, dateReceived),
      ),
    )
    .orderBy(asc(fiscalYears.startDate))
    .limit(1);
  return row ?? null;
}

/** The earliest-grant-year FY across a pledge/opportunity's allocations, or null
 * when the row has no fiscal-year-dated allocations. */
export async function getPledgeGoverningFiscalYear(
  opportunityId: string,
): Promise<GoverningFiscalYear | null> {
  const [row] = await db
    .select(govCols)
    .from(pledgeAllocations)
    .innerJoin(fiscalYears, eq(pledgeAllocations.grantYear, fiscalYears.id))
    .where(eq(pledgeAllocations.pledgeOrOpportunityId, opportunityId))
    .orderBy(asc(fiscalYears.startDate), asc(fiscalYears.id))
    .limit(1);
  return row ?? null;
}
