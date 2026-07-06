import { db } from "@workspace/db";
import { fiscalYears } from "@workspace/db/schema";
import { and, asc, gte, isNotNull, isNull, lte } from "drizzle-orm";

/**
 * "Governing fiscal year" — the single FY whose external-audit close FREEZES a
 * money record. Once that FY's `auditClosedAt` is set, the record is immutable
 * and any correction must be booked as a NEW record in the current open FY (see
 * the gift-booking-lifecycle / audit-close model).
 *
 * Both gifts and pledges are governed by the FY whose [startDate, endDate] window
 * contains the record's RECOGNITION date — they differ only in which date supplies
 * it:
 *   - A GIFT is recognized on its `date_received` (cash lands in one fiscal year).
 *   - A PLEDGE is recognized in the year the commitment was MADE — its
 *     `actual_completion_date` (the won/close date) — NOT its allocation grant
 *     years. A multi-year pledge whose first allocation is a year or two out still
 *     freezes as a whole record based on the year it was made. (Confirmed with the
 *     finance lead.) Because of this, editing an allocation's grant_year never
 *     changes the pledge's governing FY.
 *
 * A record with no recognition date (null date_received / null
 * actual_completion_date, or a date outside every FY window) has NO governing FY →
 * it is always mutable (freeze can't apply to an undated record).
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

/** The FY whose [startDate, endDate] window contains `date`, or null when `date`
 * is unset or no FY range contains it. */
async function fiscalYearContainingDate(
  date: string | null | undefined,
): Promise<GoverningFiscalYear | null> {
  if (!date) return null;
  const [row] = await db
    .select(govCols)
    .from(fiscalYears)
    .where(
      and(
        isNotNull(fiscalYears.startDate),
        isNotNull(fiscalYears.endDate),
        lte(fiscalYears.startDate, date),
        gte(fiscalYears.endDate, date),
      ),
    )
    .orderBy(asc(fiscalYears.startDate))
    .limit(1);
  return row ?? null;
}

/** GIFT governing FY = the FY window containing `date_received`. */
export function getGiftGoverningFiscalYear(
  dateReceived: string | null | undefined,
): Promise<GoverningFiscalYear | null> {
  return fiscalYearContainingDate(dateReceived);
}

/** PLEDGE governing FY = the FY window containing the pledge's made/won date
 * (`actual_completion_date`). Pass the value directly — including the merged
 * post-update value in a PATCH — so the freeze guard can check the FY the record
 * would land in, not just the one it is in now. */
export function getPledgeGoverningFiscalYear(
  actualCompletionDate: string | null | undefined,
): Promise<GoverningFiscalYear | null> {
  return fiscalYearContainingDate(actualCompletionDate);
}

/** Today's date as a YYYY-MM-DD string in America/Chicago (the timezone the FY
 * windows are defined in). Used to find the current open fiscal year and to
 * stamp the recognition date of audit-close correction records. */
export function todayInChicago(): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the FY window date format.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
  }).format(new Date());
}

/**
 * The current OPEN fiscal year — the FY whose [startDate, endDate] window
 * contains today (America/Chicago) AND whose external audit has NOT been closed
 * (`auditClosedAt IS NULL`). This is where audit-close corrections (pledge
 * write-offs, gift over-payment surplus gifts) are BOOKED.
 *
 * Returns null when there is no such FY — either no FY window contains today, or
 * the FY containing today is already audit-closed. There is deliberately NO
 * fall-forward to the next FY: if the present year is frozen, corrections have
 * nowhere to legitimately land, so the caller must surface a 409 rather than
 * silently booking money into a future year.
 */
export async function getCurrentOpenFiscalYear(): Promise<GoverningFiscalYear | null> {
  const today = todayInChicago();
  const [row] = await db
    .select(govCols)
    .from(fiscalYears)
    .where(
      and(
        isNotNull(fiscalYears.startDate),
        isNotNull(fiscalYears.endDate),
        lte(fiscalYears.startDate, today),
        gte(fiscalYears.endDate, today),
        isNull(fiscalYears.auditClosedAt),
      ),
    )
    .orderBy(asc(fiscalYears.startDate))
    .limit(1);
  return row ?? null;
}
