import { describe, expect, it } from "vitest";
import { validateOppProjectedCloseTiming } from "@workspace/api-zod";
import {
  addCalendarMonths,
  effectiveProjectedCloseDate,
  normalizeProjectedCloseTimingWrite,
} from "../lib/effectiveProjectedCloseDate";

describe("rolling projected close timing", () => {
  it("uses calendar month-end when the target month is shorter", () => {
    expect(addCalendarMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(addCalendarMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addCalendarMonths("2027-08-31", 1)).toBe("2027-09-30");
  });

  it("prefers a stored specific date and otherwise derives a rolling date", () => {
    expect(effectiveProjectedCloseDate("2027-12-15", 2, "2027-01-31")).toBe(
      "2027-12-15",
    );
    expect(effectiveProjectedCloseDate(null, 5, "2027-01-31")).toBe(
      "2027-06-30",
    );
  });

  it("allows rolling timing only at early stored stages", () => {
    expect(
      validateOppProjectedCloseTiming({
        stage: "in_conversation",
        projectedCloseDate: null,
        projectedCloseMonthsOut: 3,
      }),
    ).toEqual([]);
    expect(
      validateOppProjectedCloseTiming({
        stage: "convince",
        projectedCloseDate: null,
        projectedCloseMonthsOut: 3,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "projectedCloseMonthsOut" }),
      ]),
    );
  });

  it("rejects mutually exclusive or non-positive rolling timing", () => {
    expect(
      validateOppProjectedCloseTiming({
        stage: "cold_lead",
        projectedCloseDate: "2027-07-01",
        projectedCloseMonthsOut: 1,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "projectedCloseDate" }),
      ]),
    );
    expect(
      validateOppProjectedCloseTiming({
        stage: "cold_lead",
        projectedCloseDate: null,
        projectedCloseMonthsOut: 0,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "projectedCloseMonthsOut" }),
      ]),
    );
  });

  it("normalizes a detail-editor fixed-to-rolling switch by value", () => {
    expect(
      normalizeProjectedCloseTimingWrite({
        projectedCloseDate: null,
        projectedCloseMonthsOut: 6,
      }),
    ).toEqual({
      projectedCloseDate: null,
      projectedCloseMonthsOut: 6,
    });
  });

  it("normalizes a detail-editor rolling-to-fixed switch by value", () => {
    expect(
      normalizeProjectedCloseTimingWrite({
        projectedCloseDate: "2027-12-31",
        projectedCloseMonthsOut: null,
      }),
    ).toEqual({
      projectedCloseDate: "2027-12-31",
      projectedCloseMonthsOut: null,
    });
  });

  it("clears the inactive mode when only one active value is supplied", () => {
    expect(
      normalizeProjectedCloseTimingWrite({ projectedCloseMonthsOut: 4 }),
    ).toEqual({
      projectedCloseDate: null,
      projectedCloseMonthsOut: 4,
    });
    expect(
      normalizeProjectedCloseTimingWrite({ projectedCloseDate: "2027-07-01" }),
    ).toEqual({
      projectedCloseDate: "2027-07-01",
      projectedCloseMonthsOut: null,
    });
  });

  it("leaves conflicting active values for invariant validation", () => {
    const body = normalizeProjectedCloseTimingWrite({
      stage: "warm_lead",
      projectedCloseDate: "2027-07-01",
      projectedCloseMonthsOut: 6,
    });

    expect(body).toEqual({
      stage: "warm_lead",
      projectedCloseDate: "2027-07-01",
      projectedCloseMonthsOut: 6,
    });
    expect(validateOppProjectedCloseTiming(body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "projectedCloseDate" }),
      ]),
    );
  });
});
