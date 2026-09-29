import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * A rolling close date is calculated from today's Chicago calendar date, not
 * stored. Adding months preserves the day number when possible; otherwise it
 * uses the last day of the destination month (Jan 31 + 1 month = Feb 28/29).
 */
export function addCalendarMonths(date: string, months: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match || !Number.isInteger(months) || months < 1) {
    throw new Error(
      "A rolling projected close requires a positive whole number of months.",
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const targetMonth = month + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = targetMonth % 12;
  const lastDay = new Date(
    Date.UTC(targetYear, normalizedMonth + 1, 0),
  ).getUTCDate();
  return `${targetYear}-${String(normalizedMonth + 1).padStart(2, "0")}-${String(
    Math.min(day, lastDay),
  ).padStart(2, "0")}`;
}

export function chicagoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
  }).format(now);
}

export function effectiveProjectedCloseDate(
  projectedCloseDate: string | null | undefined,
  projectedCloseMonthsOut: number | null | undefined,
  today = chicagoToday(),
): string | null {
  if (projectedCloseDate) return projectedCloseDate;
  return projectedCloseMonthsOut == null
    ? null
    : addCalendarMonths(today, projectedCloseMonthsOut);
}

type ProjectedCloseTimingWrite = {
  projectedCloseDate?: string | null;
  projectedCloseMonthsOut?: number | null;
};

/**
 * Keep the two persisted projected-close timing modes mutually exclusive.
 * Editors send the active value together with a null inactive value, so the
 * non-null value—not key presence—selects the mode. If both values are
 * non-null, leave them intact so the shared invariant validator rejects the
 * ambiguous request.
 */
export function normalizeProjectedCloseTimingWrite<
  T extends ProjectedCloseTimingWrite,
>(body: T): T {
  const normalized = { ...body };
  const hasSpecificDate = body.projectedCloseDate != null;
  const hasRollingMonths = body.projectedCloseMonthsOut != null;

  if (hasSpecificDate && !hasRollingMonths) {
    normalized.projectedCloseMonthsOut = null;
  } else if (hasRollingMonths && !hasSpecificDate) {
    normalized.projectedCloseDate = null;
  }

  return normalized;
}

/** SQL counterpart of effectiveProjectedCloseDate, evaluated in Chicago. */
export function effectiveProjectedCloseDateSql(
  projectedCloseDate: SQLWrapper,
  projectedCloseMonthsOut: SQLWrapper,
): SQL<string | null> {
  return sql<string | null>`COALESCE(
    ${projectedCloseDate},
    CASE WHEN ${projectedCloseMonthsOut} IS NULL THEN NULL
    ELSE (((now() AT TIME ZONE 'America/Chicago')::date + (${projectedCloseMonthsOut} * INTERVAL '1 month'))::date)
    END
  )`;
}
