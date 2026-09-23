import { describe, expect, it } from "vitest";
import { isValidEin, normalizeEin } from "./ein";

describe("EIN entry", () => {
  it("formats nine digits into the canonical EIN shape", () => {
    expect(normalizeEin("123456789")).toBe("12-3456789");
  });

  it("preserves a valid canonical EIN", () => {
    expect(normalizeEin(" 12-3456789 ")).toBe("12-3456789");
    expect(isValidEin(normalizeEin("12-3456789"))).toBe(true);
  });

  it("allows clearing and rejects malformed values", () => {
    expect(normalizeEin("   ")).toBeNull();
    expect(isValidEin(null)).toBe(true);
    expect(isValidEin(normalizeEin("12-345"))).toBe(false);
  });
});
