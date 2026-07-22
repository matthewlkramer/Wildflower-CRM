import { describe, it, expect } from "vitest";
import type { Region } from "@workspace/api-client-react";
import { regionDisplayName, buildRegionIndex } from "./region-picker";

// Minimal Region factory — only the fields the label helpers read matter.
function region(partial: Partial<Region> & Pick<Region, "id" | "name">): Region {
  return {
    displayPath: "",
    stateAbbreviation: null,
    type: null,
    parentRegionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  } as Region;
}

// A representative US hierarchy mirroring the seed data AFTER the
// membership reclassification (migration 0154): groupings (multi-state
// regions, metros) no longer sit on the canonical parent chain — states
// parent straight to the country and cities straight to their state, with
// the old grouping links preserved as region_memberships (not modeled here;
// these label helpers only read canonical parentage).
//   United States (country)
//     ├─ Great Lakes Region (multi_state_region grouping; member: MN)
//     ├─ New England (multi_state_region grouping; member: MA)
//     ├─ Minnesota (state, abbr MN)
//     └─ Massachusetts (state, abbr MA)
//          ├─ Western Massachusetts (region_within_state)
//          ├─ Greater Boston (metro_area grouping; member: Boston)
//          └─ Boston (city)                     ← parent is the STATE
//               └─ Roxbury (neighborhood)
const unitedStates = region({
  id: "united_states",
  name: "United States",
  displayPath: "United States",
  type: "country",
});

const greatLakes = region({
  id: "great_lakes",
  name: "Great Lakes Region",
  displayPath: "United States, Great Lakes Region",
  type: "multi_state_region",
  parentRegionId: "united_states",
});

const minnesota = region({
  id: "united_states__minnesota",
  name: "Minnesota",
  displayPath: "United States, Minnesota",
  stateAbbreviation: "MN",
  type: "state",
  parentRegionId: "united_states",
});

const newEngland = region({
  id: "new_england",
  name: "New England",
  displayPath: "United States, New England",
  type: "multi_state_region",
  parentRegionId: "united_states",
});

const massachusetts = region({
  id: "united_states__massachusetts",
  name: "Massachusetts",
  displayPath: "United States, Massachusetts",
  stateAbbreviation: "MA",
  type: "state",
  parentRegionId: "united_states",
});

// A region_within_state sits inside its state on the canonical chain,
// e.g. "Western Massachusetts" inside Massachusetts.
const westernMass = region({
  id: "united_states__massachusetts__western_massachusetts",
  name: "Western Massachusetts",
  displayPath: "United States, Massachusetts, Western Massachusetts",
  type: "region_within_state",
  parentRegionId: "united_states__massachusetts",
});

const greaterBoston = region({
  id: "united_states__massachusetts__greater_boston",
  name: "Greater Boston",
  displayPath: "United States, Massachusetts, Greater Boston",
  type: "metro_area",
  parentRegionId: "united_states__massachusetts",
});

const boston = region({
  id: "united_states__massachusetts__boston",
  name: "Boston",
  displayPath: "United States, Massachusetts, Boston",
  type: "city",
  parentRegionId: "united_states__massachusetts",
});

const roxbury = region({
  id: "united_states__massachusetts__boston__roxbury",
  name: "Roxbury",
  displayPath: "United States, Massachusetts, Boston, Roxbury",
  type: "neighborhood",
  parentRegionId: "united_states__massachusetts__boston",
});

// Non-US hierarchy: the seed data has no stateAbbreviation and no
// "United States" displayPath prefix, so labels fall back to displayPath.
const asia = region({
  id: "asia",
  name: "Asia",
  displayPath: "Asia",
  type: "continent",
});

const china = region({
  id: "asia__china",
  name: "China",
  displayPath: "Asia, China",
  type: "country",
  parentRegionId: "asia",
});

const beijing = region({
  id: "asia__china__beijing",
  name: "Beijing",
  displayPath: "Asia, China, Beijing",
  type: "city",
  parentRegionId: "asia__china",
});

const allRegions = [
  unitedStates,
  greatLakes,
  minnesota,
  newEngland,
  massachusetts,
  westernMass,
  greaterBoston,
  boston,
  roxbury,
  asia,
  china,
  beijing,
];

const byId = buildRegionIndex(allRegions);

describe("buildRegionIndex", () => {
  it("maps every region id to its region", () => {
    expect(byId.size).toBe(allRegions.length);
    expect(byId.get(minnesota.id)).toBe(minnesota);
    expect(byId.get(boston.id)).toBe(boston);
  });
});

describe("regionDisplayName — type-aware labels", () => {
  it("renders a state as its bare name", () => {
    expect(regionDisplayName(minnesota, byId)).toBe("Minnesota");
  });

  it("renders a metro area as 'Name, ST'", () => {
    expect(regionDisplayName(greaterBoston, byId)).toBe("Greater Boston, MA");
  });

  it("renders a city as 'Name, ST'", () => {
    expect(regionDisplayName(boston, byId)).toBe("Boston, MA");
  });

  it("renders a neighborhood as 'Name, City, ST'", () => {
    expect(regionDisplayName(roxbury, byId)).toBe("Roxbury, Boston, MA");
  });

  it("renders a multi-state region as its bare name", () => {
    expect(regionDisplayName(greatLakes, byId)).toBe("Great Lakes Region");
    expect(regionDisplayName(newEngland, byId)).toBe("New England");
  });

  it("renders a region within a state as 'Name, ST'", () => {
    expect(regionDisplayName(westernMass, byId)).toBe(
      "Western Massachusetts, MA",
    );
  });
});

describe("regionDisplayName — non-US fallback", () => {
  it("leads with the country for a non-US city", () => {
    expect(regionDisplayName(beijing, byId)).toBe("Asia, China, Beijing");
  });

  it("uses the displayPath for non-US continents/countries", () => {
    expect(regionDisplayName(asia, byId)).toBe("Asia");
    expect(regionDisplayName(china, byId)).toBe("Asia, China");
  });
});

describe("regionDisplayName — multi-state name never leaks", () => {
  // The state/metro/city/neighborhood labels must never embed the
  // multi_state_region aggregation layer ("Great Lakes Region",
  // "New England") that sits between them and the country.
  it("omits the multi-state region from state labels", () => {
    expect(regionDisplayName(minnesota, byId)).not.toContain(
      "Great Lakes Region",
    );
    expect(regionDisplayName(massachusetts, byId)).not.toContain("New England");
  });

  it("omits the multi-state region from region-within-state labels", () => {
    expect(regionDisplayName(westernMass, byId)).not.toContain("New England");
  });

  it("omits the multi-state region from metro labels", () => {
    expect(regionDisplayName(greaterBoston, byId)).not.toContain("New England");
  });

  it("omits the multi-state region from city labels", () => {
    expect(regionDisplayName(boston, byId)).not.toContain("New England");
  });

  it("omits the multi-state region from neighborhood labels", () => {
    expect(regionDisplayName(roxbury, byId)).not.toContain("New England");
  });
});

describe("regionDisplayName — without an index", () => {
  it("falls back to the displayPath label (US prefix stripped)", () => {
    expect(regionDisplayName(boston)).toBe("MA, Boston");
    expect(regionDisplayName(minnesota)).toBe("MN");
  });

  it("renders the bare United States country as empty", () => {
    expect(regionDisplayName(unitedStates)).toBe("");
  });
});
