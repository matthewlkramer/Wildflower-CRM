import { describe, expect, it } from "vitest";
import {
  isExternalEnrichmentEnabled,
  selectAddressRegionSuggestion,
  type AddressSignal,
  type RegionSignal,
} from "../lib/enrichment";

const stateRegion: RegionSignal = {
  id: "region-mt",
  displayPath: "Montana",
  stateAbbreviation: "MT",
  type: "state",
};
const cityRegion: RegionSignal = {
  id: "region-missoula",
  displayPath: "Missoula, Montana",
  stateAbbreviation: "MT",
  type: "city",
};

function address(overrides: Partial<AddressSignal> = {}): AddressSignal {
  return {
    cityRegionId: null,
    stateRegionId: null,
    stateCode: null,
    cityName: null,
    postalCode: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    priority: 1,
    sourceLabel: "Direct address",
    ...overrides,
  };
}

describe("selectAddressRegionSuggestion", () => {
  it("prefers a linked city region over broader state evidence", () => {
    expect(
      selectAddressRegionSuggestion(
        [
          address({
            cityRegionId: cityRegion.id,
            stateRegionId: stateRegion.id,
            cityName: "Missoula",
            stateCode: "MT",
            postalCode: "59801",
          }),
        ],
        [stateRegion, cityRegion],
      ),
    ).toEqual({
      regionId: cityRegion.id,
      label: "Missoula, Montana",
      sourceLabel: "Direct address",
      sourceDetail: "Missoula, MT 59801",
    });
  });

  it("falls back from a state code to the canonical state region", () => {
    expect(
      selectAddressRegionSuggestion(
        [address({ stateCode: "mt" })],
        [stateRegion],
      )?.regionId,
    ).toBe(stateRegion.id);
  });

  it("uses direct evidence before a newer, indirect address", () => {
    expect(
      selectAddressRegionSuggestion(
        [
          address({ cityRegionId: cityRegion.id, priority: 1 }),
          address({
            stateRegionId: stateRegion.id,
            priority: 2,
            updatedAt: new Date("2026-09-01T00:00:00Z"),
            sourceLabel: "Primary household address",
          }),
        ],
        [stateRegion, cityRegion],
      )?.regionId,
    ).toBe(cityRegion.id);
  });

  it("returns no proposal when none of the evidence resolves", () => {
    expect(
      selectAddressRegionSuggestion(
        [address({ cityRegionId: "archived-or-missing" })],
        [stateRegion],
      ),
    ).toBeNull();
  });
});

describe("external enrichment gate", () => {
  it("is disabled by default and requires an explicit true value", () => {
    expect(isExternalEnrichmentEnabled({})).toBe(false);
    expect(
      isExternalEnrichmentEnabled({ ENRICHMENT_EXTERNAL_ENABLED: "false" }),
    ).toBe(false);
    expect(
      isExternalEnrichmentEnabled({ ENRICHMENT_EXTERNAL_ENABLED: "true" }),
    ).toBe(true);
  });
});
