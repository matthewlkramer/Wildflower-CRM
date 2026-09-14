import { describe, expect, it } from "vitest";
import {
  isWildflowerPreparationEligible,
  normalizeWildflowerSourceUrl,
  nonEmptyWildflowerText,
  wildflowerDateInterval,
  wildflowerDateRangeIsOrdered,
  wildflowerIntervalsOverlap,
  wildflowerEventDateKey,
} from "./wildflowerUpdateRules";

describe("Wildflower update rules", () => {
  it("normalizes source URL variants for item-scoped deduplication", () => {
    expect(normalizeWildflowerSourceUrl("HTTPS://Example.com/story/#section")).toBe(
      "https://example.com/story",
    );
  });

  it("preserves Gmail message fragments while canonicalizing host and path", () => {
    expect(
      normalizeWildflowerSourceUrl("https://MAIL.GOOGLE.COM/mail/#all/abc123"),
    ).toBe("https://mail.google.com/mail#all/abc123");
    expect(
      normalizeWildflowerSourceUrl("https://example.com/article#section"),
    ).toBe("https://example.com/article");
  });

  it("keeps partial date precision in the identity without inventing a day", () => {
    expect(
      wildflowerEventDateKey({
        precision: "season",
        year: 2026,
        season: "Spring",
      }),
    ).toBe("season|||2026||spring");
  });

  it("excludes held records from preparation", () => {
    expect(isWildflowerPreparationEligible("eligible")).toBe(true);
    expect(isWildflowerPreparationEligible("hold_for_confirmation")).toBe(false);
  });

  it("uses precision-aware bounded intervals and excludes unknown dates", () => {
    const bound = { start: "2026-05-01", end: "2026-05-31" };
    expect(
      wildflowerIntervalsOverlap(
        wildflowerDateInterval({
          precision: "month",
          year: 2026,
          month: 5,
        }),
        bound,
      ),
    ).toBe(true);
    expect(
      wildflowerIntervalsOverlap(
        wildflowerDateInterval({ precision: "unknown" }),
        bound,
      ),
    ).toBe(false);
    expect(
      wildflowerIntervalsOverlap(
        wildflowerDateInterval({
          precision: "exact",
          startDate: "2026-05-01",
        }),
        bound,
      ),
    ).toBe(true);
    expect(
      wildflowerDateInterval({
        precision: "month_range",
        startYear: 2025,
        startMonth: 9,
        endYear: 2026,
        endMonth: 2,
      }),
    ).toEqual({ start: "2025-09-01", end: "2026-02-28" });
  });

  it("rejects reversed source ranges and whitespace-only provenance", () => {
    expect(wildflowerDateRangeIsOrdered("2026-06-02", "2026-06-01")).toBe(false);
    expect(wildflowerDateRangeIsOrdered("2026-06-01", "2026-06-02")).toBe(true);
    expect(nonEmptyWildflowerText(" \t")).toBe(false);
    expect(nonEmptyWildflowerText("source")).toBe(true);
  });
});