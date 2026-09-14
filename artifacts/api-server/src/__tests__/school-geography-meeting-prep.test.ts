import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWftlsMeetingPrep,
  formatSchoolsInGeographiesOfInterest,
  WftlsConfigurationError,
  WftlsHttpError,
  WftlsResponseValidationError,
  type SchoolGeographyPrepInput,
  type MeetingPrepSchool,
} from "../lib/schoolGeographyMeetingPrep";

const state = {
  id: "ma",
  name: "Massachusetts",
  displayPath: "Massachusetts",
  stateAbbreviation: "MA",
  type: "state",
  parentRegionId: null,
};
const boston = {
  id: "boston",
  name: "Boston",
  displayPath: "Boston, MA",
  stateAbbreviation: null,
  type: "city",
  parentRegionId: "ma",
};
const bostonMetro = {
  id: "boston-metro",
  name: "Greater Boston",
  displayPath: "Greater Boston, MA",
  stateAbbreviation: null,
  type: "metro_area",
  parentRegionId: "ma",
};
const dc = {
  id: "dc",
  name: "District of Columbia",
  displayPath: "District of Columbia",
  stateAbbreviation: "DC",
  type: "state",
  parentRegionId: null,
};
const pr = {
  id: "pr",
  name: "Puerto Rico",
  displayPath: "Puerto Rico",
  stateAbbreviation: "PR",
  type: "state",
  parentRegionId: null,
};

function school(
  id: string,
  name: string,
  status: string,
  extras: Partial<MeetingPrepSchool> = {},
): MeetingPrepSchool {
  return {
    id,
    name,
    status,
    stage: null,
    projectedOpen: null,
    readiness: null,
    narrative: null,
    riskFactors: null,
    watchlist: null,
    targetGeography: null,
    locations: [],
    supports: [],
    archived: false,
    ...extras,
  };
}

function location(city: string | null, stateName: string | null, targetGeography: string | null = null) {
  return { city, state: stateName, targetGeography };
}

function input(overrides: Partial<SchoolGeographyPrepInput> = {}): SchoolGeographyPrepInput {
  return {
    fundingRegionIds: ["ma"],
    regions: [state, boston, bostonMetro, dc, pr],
    containment: new Map([["ma", ["boston", "boston-metro"]], ["boston-metro", ["boston"]]]),
    schools: [],
    ...overrides,
  };
}

describe("Schools in Geographies of Interest", () => {
  it("matches state, city, metro, aliases, and excludes a wrong-state same-named city", () => {
    const section = formatSchoolsInGeographiesOfInterest(
      input({
        fundingRegionIds: ["boston-metro"],
        aliases: [{ regionId: "boston", alias: "Beantown" }],
        schools: [
          school("correct", "Boston Correct", "Emerging", {
            locations: [location("Beantown", "MA")],
          }),
          school("wrong", "Boston Wrong State", "Emerging", {
            locations: [location("Boston", "Maine")],
          }),
        ],
      }),
    );
    expect(section).toContain("Boston Correct");
    expect(section).not.toContain("Boston Wrong State");
  });

  it("deduplicates a school across multiple matched funder geographies", () => {
    const section = formatSchoolsInGeographiesOfInterest(
      input({
        fundingRegionIds: ["ma", "boston"],
        schools: [school("one", "One School", "Open", { locations: [location("Boston", "Massachusetts")] })],
      }),
    );
    expect(section.match(/One School/g)).toHaveLength(1);
    expect(section).toContain("Massachusetts • Boston, MA");
  });

  it("matches District of Columbia and Puerto Rico", () => {
    const section = formatSchoolsInGeographiesOfInterest(
      input({
        fundingRegionIds: ["dc", "pr"],
        schools: [
          school("dc-school", "DC School", "Open", { locations: [location("Washington", "DC")] }),
          school("pr-school", "PR School", "Emerging", { locations: [location("San Juan", "Puerto Rico")] }),
        ],
      }),
    );
    expect(section).toContain("DC School");
    expect(section).toContain("PR School");
  });

  it("uses a canonical target geography before a school has a physical location", () => {
    const section = formatSchoolsInGeographiesOfInterest(
      input({
        schools: [school("target-only", "Target Geography School", "Emerging", {
          targetGeography: "Boston, MA",
        })],
      }),
    );
    expect(section).toContain("Target Geography School — Boston, MA");
  });

  it("shows explicit missing fields and the no-flag open state", () => {
    const section = formatSchoolsInGeographiesOfInterest(
      input({
        schools: [
          school("incomplete", "Incomplete Emerging", "Emerging", {
            locations: [location("Boston", "Massachusetts")],
          }),
          school("clear", "Clear Open School", "Open", {
            locations: [location("Boston", "Massachusetts")],
          }),
        ],
      }),
    );
    expect(section).toContain("SSJ Stage: Not recorded");
    expect(section).toContain("Projected open: Not recorded");
    expect(section).toContain("Readiness: Not recorded");
    expect(section).toContain("Current status: Not recorded");
    expect(section).toContain("No current risk or support flags");
  });

  it("includes valid supports and excludes inactive, archived, and wrong support types", () => {
    const section = formatSchoolsInGeographiesOfInterest(
      input({
        schools: [school("flagged", "Flagged Open School", "Open", {
          locations: [location("Boston", "Massachusetts")],
          riskFactors: "Lease uncertainty",
          watchlist: "Enrollment watch",
          supports: [
            { type: "Inflection", status: "Active planning", startDate: "2026-09-01", endDate: null,
              owner: "Jordan Guide", guide: null, lastModified: null, active: true, archived: false },
            { type: "Crisis", status: null, startDate: null, endDate: null, owner: null,
              guide: null, lastModified: null, active: true, archived: true },
            { type: "Coaching", status: null, startDate: null, endDate: null, owner: null,
              guide: null, lastModified: null, active: true, archived: false },
            { type: "Crisis", status: null, startDate: null, endDate: null, owner: null,
              guide: null, lastModified: null, active: false, archived: false },
          ],
        })],
      }),
    );
    expect(section).toContain("Risk factors: Lease uncertainty");
    expect(section).toContain("Watchlist: Enrollment watch");
    expect(section).toContain("Inflection — Status: Active planning; Owner: Jordan Guide; Start: 2026-09-01");
    expect(section).not.toContain("Crisis —");
    expect(section).not.toContain("Coaching");
  });
});

describe("WFTLS meeting-prep contract", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the narrow GET endpoint and bearer auth without exposing the token", async () => {
    vi.stubEnv("WFTLS_BASE_URL", "https://wftls.example.test/");
    vi.stubEnv("WFTLS_MEETING_PREP_API_TOKEN", "secret-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schools: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchWftlsMeetingPrep();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://wftls.example.test/api/integrations/wfcrm/v1/schools/meeting-prep");
    expect(options.method).toBe("GET");
    expect(options.headers.Authorization).toBe("Bearer secret-token");
  });

  it("fails clearly when config is missing", async () => {
    vi.stubEnv("WFTLS_BASE_URL", "");
    vi.stubEnv("WFTLS_MEETING_PREP_API_TOKEN", "");
    await expect(fetchWftlsMeetingPrep()).rejects.toBeInstanceOf(WftlsConfigurationError);
  });

  it("retries transient 429/5xx responses, but does not retry a permanent HTTP error", async () => {
    vi.stubEnv("WFTLS_BASE_URL", "https://wftls.example.test");
    vi.stubEnv("WFTLS_MEETING_PREP_API_TOKEN", "token");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ schools: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchWftlsMeetingPrep();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    await expect(fetchWftlsMeetingPrep()).rejects.toMatchObject({ constructor: WftlsHttpError, status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed responses instead of falling back", async () => {
    vi.stubEnv("WFTLS_BASE_URL", "https://wftls.example.test");
    vi.stubEnv("WFTLS_MEETING_PREP_API_TOKEN", "token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schools: [{ id: 4 }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWftlsMeetingPrep()).rejects.toBeInstanceOf(WftlsResponseValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});