import { describe, expect, it } from "vitest";
import {
  OPPORTUNITY_STATUS_LABEL,
  opportunityStatusLabel,
} from "./opportunity-status";

describe("OPPORTUNITY_STATUS_LABEL", () => {
  it("pins the five canonical labels", () => {
    expect(OPPORTUNITY_STATUS_LABEL).toEqual({
      open: "Open",
      pledge: "Waiting for payment",
      cash_in: "Cash in",
      dormant: "Dormant",
      lost: "Lost",
    });
  });
});

describe("opportunityStatusLabel", () => {
  it("returns the canonical label for each known status", () => {
    expect(opportunityStatusLabel("open")).toBe("Open");
    expect(opportunityStatusLabel("pledge")).toBe("Waiting for payment");
    expect(opportunityStatusLabel("cash_in")).toBe("Cash in");
    expect(opportunityStatusLabel("dormant")).toBe("Dormant");
    expect(opportunityStatusLabel("lost")).toBe("Lost");
  });

  it("returns null for null, undefined, and empty string", () => {
    expect(opportunityStatusLabel(null)).toBeNull();
    expect(opportunityStatusLabel(undefined)).toBeNull();
    expect(opportunityStatusLabel("")).toBeNull();
  });

  it("falls back to the raw value for an unrecognized status", () => {
    expect(opportunityStatusLabel("some_new_status")).toBe("some_new_status");
  });

  it("never returns a raw enum value for a status the map knows about", () => {
    for (const [value, label] of Object.entries(OPPORTUNITY_STATUS_LABEL)) {
      expect(opportunityStatusLabel(value)).toBe(label);
      expect(opportunityStatusLabel(value)).not.toBe(value);
    }
  });
});
