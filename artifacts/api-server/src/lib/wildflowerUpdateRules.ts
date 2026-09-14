export type WildflowerPreparationStatus =
  | "eligible"
  | "hold_for_confirmation";

export type WildflowerEventDate = {
  precision: "exact" | "month" | "year" | "season" | "date_range" | "school_year" | "month_range" | "unknown";
  startDate?: string | null;
  endDate?: string | null;
  year?: number | null;
  startYear?: number | null;
  startMonth?: number | null;
  endYear?: number | null;
  endMonth?: number | null;
  month?: number | null;
  season?: string | null;
};

export type WildflowerDateInterval = { start: string; end: string };

export function normalizeWildflowerSourceUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (
      url.hostname === "mail.google.com" &&
      (url.pathname === "/mail" || url.pathname.startsWith("/mail/"))
    ) {
      // Gmail message URLs use the fragment as the message identity
      // (for example #all/19c96778...). Unlike ordinary web-page fragments,
      // dropping it merges distinct source messages.
      url.hash = new URL(value.trim()).hash;
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return value.trim().toLowerCase().replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

export function wildflowerEventDateKey(date: {
  precision: WildflowerEventDate["precision"];
  startDate?: string | null;
  endDate?: string | null;
  year?: number | null;
  startYear?: number | null;
  startMonth?: number | null;
  endYear?: number | null;
  endMonth?: number | null;
  month?: number | null;
  season?: string | null;
}): string {
  const legacy = [
    date.precision,
    date.startDate ?? "",
    date.endDate ?? "",
    date.year ?? "",
    date.month ?? "",
    date.season?.trim().toLowerCase() ?? "",
  ];
  if (date.precision === "school_year") {
    return [
      ...legacy.slice(0, 4),
      date.startYear ?? "",
      date.endYear ?? "",
      ...legacy.slice(4),
    ].join("|");
  }
  if (date.precision === "month_range") {
    return [
      ...legacy,
      date.startYear ?? "",
      date.startMonth ?? "",
      date.endYear ?? "",
      date.endMonth ?? "",
    ].join("|");
  }
  return legacy.join("|");
}

/** Resolve only dates whose recorded precision supports a bounded interval. */
export function wildflowerDateInterval(
  date: WildflowerEventDate,
): WildflowerDateInterval | null {
  if (date.precision === "exact" && date.startDate) {
    return { start: date.startDate, end: date.startDate };
  }
  if (date.precision === "date_range" && date.startDate && date.endDate) {
    return { start: date.startDate, end: date.endDate };
  }
  if (
    date.precision === "school_year" &&
    date.startYear &&
    date.endYear &&
    date.startYear <= date.endYear
  ) {
    return {
      start: `${date.startYear}-01-01`,
      end: `${date.endYear}-12-31`,
    };
  }
  if (
    date.precision === "month_range" &&
    date.startYear &&
    date.startMonth &&
    date.endYear &&
    date.endMonth &&
    (date.startYear < date.endYear ||
      (date.startYear === date.endYear && date.startMonth <= date.endMonth))
  ) {
    const nextMonth =
      date.endMonth === 12
        ? `${date.endYear + 1}-01-01`
        : `${date.endYear}-${String(date.endMonth + 1).padStart(2, "0")}-01`;
    const end = new Date(`${nextMonth}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() - 1);
    return {
      start: `${date.startYear}-${String(date.startMonth).padStart(2, "0")}-01`,
      end: end.toISOString().slice(0, 10),
    };
  }
  if (
    (date.precision === "year" || date.precision === "month") &&
    date.year
  ) {
    const month = date.precision === "month" ? date.month : 1;
    if (!month) return null;
    const start = `${date.year}-${String(month).padStart(2, "0")}-01`;
    const nextMonth =
      month === 12
        ? `${date.year + 1}-01-01`
        : `${date.year}-${String(month + 1).padStart(2, "0")}-01`;
    const monthEnd = new Date(`${nextMonth}T00:00:00Z`);
    monthEnd.setUTCDate(monthEnd.getUTCDate() - 1);
    return {
      start: date.precision === "year" ? `${date.year}-01-01` : start,
      end:
        date.precision === "year"
          ? `${date.year}-12-31`
          : monthEnd.toISOString().slice(0, 10),
    };
  }
  if (date.precision === "season" && date.year && date.season) {
    const season = date.season.trim().toLowerCase();
    const ranges: Record<string, [number, number, number, number]> = {
      spring: [3, 1, 5, 31],
      summer: [6, 1, 8, 31],
      autumn: [9, 1, 11, 30],
      fall: [9, 1, 11, 30],
      winter: [12, 1, 2, 28],
    };
    const range = ranges[season];
    if (!range) return null;
    const [startMonth, startDay, endMonth, endDay] = range;
    const endYear = season === "winter" ? date.year + 1 : date.year;
    const winterEndDay =
      season === "winter" &&
      (endYear % 4 === 0 && (endYear % 100 !== 0 || endYear % 400 === 0))
        ? 29
        : endDay;
    return {
      start: `${date.year}-${String(startMonth).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`,
      end: `${endYear}-${String(endMonth).padStart(2, "0")}-${String(winterEndDay).padStart(2, "0")}`,
    };
  }
  return null;
}

export function wildflowerIntervalsOverlap(
  left: WildflowerDateInterval | null,
  right: WildflowerDateInterval,
): boolean {
  return left != null && left.start <= right.end && left.end >= right.start;
}

export function nonEmptyWildflowerText(value: string): boolean {
  return value.trim().length > 0;
}

export function wildflowerDateRangeIsOrdered(
  start: string | null | undefined,
  end: string | null | undefined,
): boolean {
  return Boolean(start && end && start <= end);
}

export function isWildflowerPreparationEligible(
  status: WildflowerPreparationStatus,
): boolean {
  return status === "eligible";
}