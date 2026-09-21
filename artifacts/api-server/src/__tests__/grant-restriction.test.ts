import { describe, expect, it } from "vitest";
import { deriveGrantRestrictionRollup } from "../lib/grantRestriction";

const unrestrictedAllocation = {
  regionalRestrictionType: "unrestricted",
  otherRestrictionType: "unrestricted",
  timeRestrictionType: "unrestricted",
  entityId: "entity-bwf",
};

describe("deriveGrantRestrictionRollup", () => {
  it("treats a force-restricted entity as restricted", () => {
    expect(
      deriveGrantRestrictionRollup(
        [unrestrictedAllocation],
        [
          {
            entityId: "entity-bwf",
            entityName: "Black Wildflowers Fund",
            forceRestricted: true,
            enabled: true,
          },
        ],
      ),
    ).toEqual({
      restricted: true,
      restrictionBasis: ["Restricted to Black Wildflowers Fund"],
    });
  });

  it("does not treat an internal designation as a donor restriction", () => {
    expect(
      deriveGrantRestrictionRollup(
        [
          {
            ...unrestrictedAllocation,
            regionalRestrictionType: "wf_restricted",
            otherRestrictionType: "wf_restricted",
            timeRestrictionType: "wf_restricted",
          },
        ],
        [],
      ),
    ).toEqual({ restricted: false, restrictionBasis: [] });
  });

  it("does not claim unrestricted when no allocations exist yet", () => {
    expect(deriveGrantRestrictionRollup([], [])).toEqual({
      restricted: null,
      restrictionBasis: [],
    });
  });

  it("does not claim unrestricted while allocation coding is incomplete", () => {
    expect(
      deriveGrantRestrictionRollup(
        [
          {
            regionalRestrictionType: null,
            otherRestrictionType: null,
            timeRestrictionType: null,
            entityId: null,
          },
        ],
        [],
      ),
    ).toEqual({ restricted: null, restrictionBasis: [] });
  });

  it("can conclude unrestricted after a human accepts a no-restriction review", () => {
    expect(deriveGrantRestrictionRollup([], [], [], true)).toEqual({
      restricted: false,
      restrictionBasis: [],
    });
  });

  it("uses an accepted provisional restriction before allocations exist", () => {
    expect(
      deriveGrantRestrictionRollup(
        [],
        [],
        [
          {
            restrictionDimension: "entity",
            summary: "Restricted to Black Wildflowers Fund",
          },
        ],
      ),
    ).toEqual({
      restricted: true,
      restrictionBasis: ["Restricted to Black Wildflowers Fund"],
    });
  });
});
