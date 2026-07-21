import { describe, it, expect } from "vitest";
import {
  fiscalYearEndYear,
  currentFiscalYearEndYear,
  currentFiscalYearSlug,
  fiscalYearFromDate,
} from "./format";

// Wildflower FY = Jul 1 – Jun 30, labelled by END year, in America/Chicago.
// These tests pin the June 30 / July 1 midnight-Chicago boundary so every
// client-side FY computation (report alias, allocation editors, kanban/
// pipeline fallback) resolves identically — and matches the server.

describe("fiscalYearEndYear", () => {
  it("June belongs to the ending FY, July to the next", () => {
    expect(fiscalYearEndYear(2026, 6)).toBe(2026);
    expect(fiscalYearEndYear(2026, 7)).toBe(2027);
    expect(fiscalYearEndYear(2026, 1)).toBe(2026);
    expect(fiscalYearEndYear(2026, 12)).toBe(2027);
  });
});

describe("currentFiscalYearEndYear / currentFiscalYearSlug (America/Chicago)", () => {
  // Chicago is UTC-5 (CDT) around July 1.
  it("just before midnight Chicago on June 30 is still the old FY", () => {
    // 2026-06-30 23:59:59 CDT == 2026-07-01T04:59:59Z
    const t = new Date("2026-07-01T04:59:59Z");
    expect(currentFiscalYearEndYear(t)).toBe(2026);
    expect(currentFiscalYearSlug(t)).toBe("fy2026");
  });

  it("midnight Chicago on July 1 rolls to the new FY", () => {
    // 2026-07-01 00:00:00 CDT == 2026-07-01T05:00:00Z
    const t = new Date("2026-07-01T05:00:00Z");
    expect(currentFiscalYearEndYear(t)).toBe(2027);
    expect(currentFiscalYearSlug(t)).toBe("fy2027");
  });

  it("does NOT roll early just because UTC has passed midnight July 1", () => {
    // 2026-07-01T02:00:00Z is still June 30 evening in Chicago.
    const t = new Date("2026-07-01T02:00:00Z");
    expect(currentFiscalYearEndYear(t)).toBe(2026);
  });
});

describe("fiscalYearFromDate", () => {
  it("date-only strings use their stated calendar date (no tz shifting)", () => {
    expect(fiscalYearFromDate("2026-06-30")).toBe("FY26");
    expect(fiscalYearFromDate("2026-07-01")).toBe("FY27");
    expect(fiscalYearFromDate("2026-01-15")).toBe("FY26");
    expect(fiscalYearFromDate("2026-12-15")).toBe("FY27");
  });

  it("date-time strings are evaluated in America/Chicago", () => {
    // Just before midnight Chicago June 30 (05:00Z crossover in CDT).
    expect(fiscalYearFromDate("2026-07-01T04:59:59Z")).toBe("FY26");
    // Midnight Chicago July 1.
    expect(fiscalYearFromDate("2026-07-01T05:00:00Z")).toBe("FY27");
  });

  it("returns null for empty or unparseable input", () => {
    expect(fiscalYearFromDate(null)).toBeNull();
    expect(fiscalYearFromDate(undefined)).toBeNull();
    expect(fiscalYearFromDate("")).toBeNull();
    expect(fiscalYearFromDate("not-a-date")).toBeNull();
  });
});
