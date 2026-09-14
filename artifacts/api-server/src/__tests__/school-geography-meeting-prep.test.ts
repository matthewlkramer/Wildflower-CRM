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
  const v1 = (schools: unknown[] = []) => ({
    apiVersion: "v1", generatedAt: "2026-09-14T17:30:00.000Z", schools,
  });
  const sourceSchool = (overrides: Record<string, unknown> = {}) => ({
    schoolId: "example-school", schoolName: "Example School", schoolStatus: "emerging",
    physicalLocation: null, targetGeography: "Boston, Massachusetts, United States",
    ssjStage: "planning", projectedOpenDate: null, projectedOpenYear: 2027,
    currentReadinessRating: "Medium", currentStatusNarrative: "Seeking a site",
    riskFactors: null, watchlist: null, supportEntries: [], ...overrides,
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the narrow GET endpoint and bearer auth without exposing the token", async () => {
    vi.stubEnv("WFTLS_BASE_URL", "https://wftls.example.test/");
    vi.stubEnv("WFTLS_MEETING_PREP_API_TOKEN", "secret-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(v1()), {
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
      .mockResolvedValueOnce(new Response(JSON.stringify(v1()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchWftlsMeetingPrep();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    await expect(fetchWftlsMeetingPrep()).rejects.toMatchObject({ constructor: WftlsHttpError, status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("adapts the WFTLS v1 response through geography matching and briefing output", async () => {
    vi.stubEnv("WFTLS_BASE_URL", "https://wftls.example.test");
    vi.stubEnv("WFTLS_MEETING_PREP_API_TOKEN", "token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(v1([
      sourceSchool(),
      sourceSchool({
        schoolId: "open-school", schoolName: "Open School", schoolStatus: "open",
        targetGeography: null, physicalLocation: "123 Example St, Boston, MA 02108, United States",
        riskFactors: "Lease uncertainty", watchlist: "Enrollment watch",
        supportEntries: [{
          supportEntryId: "support-1", type: "Ops Guide", assignmentTypes: ["Inflection"],
          matchingClassifications: ["Inflection"], status: "current", ownerOrGuide: "Example Guide",
          startDate: "2026-09-01", endDate: null, lastModifiedAt: "2026-09-10T12:00:00.000Z",
          summaryOrUpdate: null,
        }],
      }),
      sourceSchool({ schoolId: "other-state", schoolName: "Wrong State School", targetGeography: "Boston, ME" }),
    ])), { status: 200 })));
    const result = await fetchWftlsMeetingPrep();
    expect(result.schools[0]).toMatchObject({ id: "example-school", projectedOpen: "2027", archived: false });
    const section = formatSchoolsInGeographiesOfInterest(input({ fundingRegionIds: ["boston"], schools: result.schools }));
    expect(section).toContain("Example School — Boston, Massachusetts, United States");
    expect(section).toContain("Projected open: 2027; Readiness: Medium");
    expect(section).toContain("Open School — 123 Example St, Boston, MA 02108, United States");
    expect(section).toContain("Inflection — Status: current; Owner: Example Guide");
    expect(section).toContain("Risk factors: Lease uncertainty");
    expect(section).not.toContain("Wrong State School");
  });

  it("preserves nulls and does not infer geography or support classifications", async () => {
    vi.stubEnv("WFTLS_BASE_URL", "https://wftls.example.test");
    vi.stubEnv("WFTLS_MEETING_PREP_API_TOKEN", "token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(v1([
      sourceSchool({
        targetGeography: "Boston", projectedOpenYear: null, currentReadinessRating: null,
        supportEntries: [{ supportEntryId: "support-2", type: "Ops Guide", assignmentTypes: ["Coaching"],
          matchingClassifications: [], status: "current", startDate: null, endDate: null,
          ownerOrGuide: null, lastModifiedAt: null, summaryOrUpdate: null }],
      }),
    ])), { status: 200 })));
    const result = await fetchWftlsMeetingPrep();
    expect(result.schools[0]).toMatchObject({ projectedOpen: null, readiness: null, supports: [] });
    expect(formatSchoolsInGeographiesOfInterest(input({ schools: result.schools }))).not.toContain("Example School");
  });

  it.each([
    { schools: [] },
    { ...v1(), apiVersion: "v2" },
    v1([{ id: 4 }]),
    v1([sourceSchool({ supportEntries: "invalid" })]),
  ])("rejects malformed or incompatible responses instead of falling back", async (body) => {
    vi.stubEnv("WFTLS_BASE_URL", "https://wftls.example.test");
    vi.stubEnv("WFTLS_MEETING_PREP_API_TOKEN", "token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWftlsMeetingPrep()).rejects.toBeInstanceOf(WftlsResponseValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
