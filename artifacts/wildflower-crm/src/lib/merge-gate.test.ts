import { describe, it, expect } from "vitest";
import { allSelectedLoaded } from "./merge-gate";

describe("allSelectedLoaded", () => {
  it("is true only when every selected gift has loaded", () => {
    expect(allSelectedLoaded(3, 3, false)).toBe(true);
  });

  it("blocks a partially loaded subset (would otherwise merge fewer rows)", () => {
    expect(allSelectedLoaded(2, 3, false)).toBe(false);
    expect(allSelectedLoaded(1, 3, false)).toBe(false);
  });

  it("blocks when any selected gift failed to load", () => {
    expect(allSelectedLoaded(3, 3, true)).toBe(false);
  });

  it("blocks when nothing is selected/expected", () => {
    expect(allSelectedLoaded(0, 0, false)).toBe(false);
  });
});
