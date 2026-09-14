import { db } from "@workspace/db";
import { regionAliases, regions } from "@workspace/db/schema";
import { isNull } from "drizzle-orm";
import { z } from "zod";
import { deriveContainment } from "./regionContainment";

type RegionRow = {
  id: string;
  name: string;
  displayPath: string;
  stateAbbreviation: string | null;
  type: string | null;
  parentRegionId: string | null;
};

type Location = {
  city: string | null;
  state: string | null;
  targetGeography: string | null;
  displayText?: string | null;
};

type Support = {
  type: string;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  owner: string | null;
  guide: string | null;
  lastModified: string | null;
  active: boolean;
  archived: boolean;
};

export type MeetingPrepSchool = {
  id: string;
  name: string;
  status: string | null;
  stage: string | null;
  projectedOpen: string | null;
  readiness: string | null;
  narrative: string | null;
  riskFactors: string | null;
  watchlist: string | null;
  targetGeography: string | null;
  locations: Location[];
  supports: Support[];
  archived: boolean;
};
type School = MeetingPrepSchool;

/**
 * The WFTLS response is intentionally kept as a small, versioned contract.
 */
const nullableText = z.string().nullable().default(null);
const meetingPrepSupportSchema = z
  .object({
    supportEntryId: z.string().min(1),
    type: nullableText,
    assignmentTypes: z.array(z.string()),
    matchingClassifications: z.array(z.string()),
    status: nullableText,
    startDate: nullableText,
    endDate: nullableText,
    ownerOrGuide: nullableText,
    lastModifiedAt: nullableText,
    summaryOrUpdate: nullableText,
  })
  .strict();
const meetingPrepSchoolSchema = z
  .object({
    schoolId: z.string().min(1),
    schoolName: z.string(),
    schoolStatus: z.enum(["emerging", "open"]),
    ssjStage: nullableText,
    projectedOpenDate: nullableText,
    projectedOpenYear: z.number().int().nullable(),
    currentReadinessRating: nullableText,
    currentStatusNarrative: nullableText,
    riskFactors: nullableText,
    watchlist: nullableText,
    targetGeography: nullableText,
    physicalLocation: nullableText,
    supportEntries: z.array(meetingPrepSupportSchema),
  })
  .strict();
const meetingPrepResponseSchema = z
  .object({
    apiVersion: z.literal("v1"),
    generatedAt: z.string().datetime(),
    schools: z.array(meetingPrepSchoolSchema),
  })
  .strict();

type WftlsMeetingPrepResponse = z.infer<typeof meetingPrepResponseSchema>;

/** Translate the source-owned v1 contract into the briefing's internal model. */
function adaptWftlsSchool(row: WftlsMeetingPrepResponse["schools"][number]): MeetingPrepSchool {
  const locations: Location[] = [];
  if (row.physicalLocation) locations.push(wftlsLocation(row.physicalLocation, null));
  if (row.targetGeography) locations.push(wftlsLocation(row.targetGeography, row.targetGeography));
  return {
    id: row.schoolId,
    name: row.schoolName,
    status: row.schoolStatus,
    stage: row.ssjStage,
    projectedOpen: row.projectedOpenDate ?? (row.projectedOpenYear == null ? null : String(row.projectedOpenYear)),
    readiness: row.currentReadinessRating,
    narrative: row.currentStatusNarrative,
    riskFactors: row.riskFactors,
    watchlist: row.watchlist,
    targetGeography: row.targetGeography,
    locations,
    // WFTLS includes only current, non-archived schools and support entries.
    archived: false,
    supports: row.supportEntries.flatMap((support) =>
      [...new Set(support.matchingClassifications.map((value) => value.trim().toLowerCase()))]
        .filter((value) => value === "inflection" || value === "crisis")
        .map((value) => ({
          type: value === "inflection" ? "Inflection" : "Crisis",
          status: support.status,
          startDate: support.startDate,
          endDate: support.endDate,
          owner: support.ownerOrGuide,
          guide: null,
          lastModified: support.lastModifiedAt,
          active: true,
          archived: false,
        })),
    ),
  };
}

export class WftlsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WftlsConfigurationError";
  }
}

export class WftlsTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WftlsTransportError";
  }
}

export class WftlsHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`WFTLS meeting-prep request failed with HTTP ${status}`);
    this.name = "WftlsHttpError";
    this.status = status;
  }
}

export class WftlsResponseValidationError extends Error {
  constructor() {
    super("WFTLS meeting-prep response did not match its contract");
    this.name = "WftlsResponseValidationError";
  }
}

const WFTLS_MEETING_PREP_PATH = "/api/integrations/wfcrm/v1/schools/meeting-prep";
const WFTLS_TIMEOUT_MS = 8_000;
const WFTLS_MAX_ATTEMPTS = 3;

export type SchoolGeographyPrepInput = {
  fundingRegionIds: string[];
  regions: RegionRow[];
  aliases?: Array<{ regionId: string; alias: string }>;
  containment: Map<string, string[]>;
  schools: MeetingPrepSchool[];
};

const NOT_RECORDED = "Not recorded";

function norm(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const STATE_NAMES = new Map<string, string>([
  ["al", "alabama"], ["ak", "alaska"], ["az", "arizona"], ["ar", "arkansas"],
  ["ca", "california"], ["co", "colorado"], ["ct", "connecticut"], ["de", "delaware"],
  ["fl", "florida"], ["ga", "georgia"], ["hi", "hawaii"], ["id", "idaho"],
  ["il", "illinois"], ["in", "indiana"], ["ia", "iowa"], ["ks", "kansas"],
  ["ky", "kentucky"], ["la", "louisiana"], ["me", "maine"], ["md", "maryland"],
  ["ma", "massachusetts"], ["mi", "michigan"], ["mn", "minnesota"],
  ["ms", "mississippi"], ["mo", "missouri"], ["mt", "montana"], ["ne", "nebraska"],
  ["nv", "nevada"], ["nh", "newhampshire"], ["nj", "newjersey"], ["nm", "newmexico"],
  ["ny", "newyork"], ["nc", "northcarolina"], ["nd", "northdakota"], ["oh", "ohio"],
  ["ok", "oklahoma"], ["or", "oregon"], ["pa", "pennsylvania"], ["ri", "rhodeisland"],
  ["sc", "southcarolina"], ["sd", "southdakota"], ["tn", "tennessee"], ["tx", "texas"],
  ["ut", "utah"], ["vt", "vermont"], ["va", "virginia"], ["wa", "washington"],
  ["wv", "westvirginia"], ["wi", "wisconsin"], ["wy", "wyoming"],
  ["dc", "districtofcolumbia"], ["pr", "puertorico"],
]);

function stateVariants(value: string | null | undefined): Set<string> {
  const normalized = norm(value);
  const variants = new Set<string>(normalized ? [normalized] : []);
  for (const [abbreviation, name] of STATE_NAMES) {
    if (normalized === abbreviation || normalized === name) {
      variants.add(abbreviation);
      variants.add(name);
    }
  }
  return variants;
}

function sameState(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftVariants = stateVariants(left);
  const rightVariants = stateVariants(right);
  return [...leftVariants].some((value) => rightVariants.has(value));
}

/** WFTLS formats locations as comma-separated components, with state + ZIP. */
function wftlsLocation(text: string, targetGeography: string | null): Location {
  const parts = text.split(",").map((part) => part.trim());
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const state = parts[index].replace(/\s+\d{5}(?:-\d{4})?$/, "");
    const key = norm(state);
    if (STATE_NAMES.has(key) || [...STATE_NAMES.values()].some((name) => norm(name) === key)) {
      return { city: index > 0 ? parts[index - 1] || null : null, state, targetGeography, displayText: text };
    }
  }
  // Preserve source text without guessing a city or state from an unknown format.
  return { city: null, state: null, targetGeography, displayText: text };
}

function stateForRegion(region: RegionRow, byId: Map<string, RegionRow>): RegionRow | null {
  let cursor: RegionRow | undefined = region;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    if (cursor.type === "state") return cursor;
    seen.add(cursor.id);
    cursor = cursor.parentRegionId ? byId.get(cursor.parentRegionId) : undefined;
  }
  return null;
}

function displayLocation(locations: Location[]): string {
  const sourceText = locations.find((entry) => entry.displayText)?.displayText;
  if (sourceText) return sourceText;
  const location = locations.find((entry) => entry.city || entry.state);
  if (location) {
    return [location.city, location.state].filter(Boolean).join(", ") || NOT_RECORDED;
  }
  return locations.find((entry) => entry.targetGeography)?.targetGeography ?? NOT_RECORDED;
}

function matchingRoots(
  school: School,
  fundingRegionIds: string[],
  containment: Map<string, string[]>,
  byId: Map<string, RegionRow>,
  aliasesByRegion: Map<string, string[]>,
): string[] {
  const locations = school.locations.length
    ? school.locations
    : [{ city: null, state: null, targetGeography: school.targetGeography }];
  const matches: string[] = [];

  for (const rootId of fundingRegionIds) {
    const root = byId.get(rootId);
    if (!root) continue;
    const scope = [rootId, ...(containment.get(rootId) ?? [])]
      .map((id) => byId.get(id))
      .filter((region): region is RegionRow => Boolean(region));

    const match = locations.some((location) =>
      scope.some((region) => {
        if (region.type === "state") {
          return sameState(location.state, region.stateAbbreviation ?? region.name);
        }
        if (region.type === "city") {
          const state = stateForRegion(region, byId);
          return (
            [region.name, ...(aliasesByRegion.get(region.id) ?? [])]
              .map(norm)
              .includes(norm(location.city)) &&
            state != null &&
            sameState(location.state, state.stateAbbreviation ?? state.name)
          );
        }
        return false;
      }) ||
      scope.some((region) => {
        const targetGeographies = [
          school.targetGeography,
          ...school.locations.map((entry) => entry.targetGeography),
        ].filter((value): value is string => Boolean(value));
        return targetGeographies.some((target) => {
          // A target city without its state is ambiguous (e.g. Boston, MA vs
          // Boston, ME), so only use canonical full display paths for city
          // matching. State names and abbreviations are safe equivalences.
          if (region.type === "state") {
            return sameState(target, region.stateAbbreviation ?? region.name);
          }
          return norm(target) === norm(region.displayPath);
        });
      }),
    );
    if (match) matches.push(root.displayPath || root.name);
  }
  return matches;
}

function makeSchools(input: SchoolGeographyPrepInput): School[] {
  return input.schools
    .filter((school) => !school.archived)
    .map((school) => ({
      ...school,
      locations: school.locations.length
        ? school.locations
        : [{ city: null, state: null, targetGeography: school.targetGeography }],
      supports: school.supports.filter(
        (support) =>
          support.active &&
          !support.archived &&
          (support.type === "Inflection" || support.type === "Crisis"),
      ),
    }));
}

function wftlsUrl(): { url: string; token: string } {
  const base = process.env["WFTLS_BASE_URL"]?.trim();
  const token = process.env["WFTLS_MEETING_PREP_API_TOKEN"]?.trim();
  if (!base || !token) {
    throw new WftlsConfigurationError(
      "WFTLS meeting-prep integration is not configured (set WFTLS_BASE_URL and WFTLS_MEETING_PREP_API_TOKEN)",
    );
  }
  let url: URL;
  try {
    url = new URL(WFTLS_MEETING_PREP_PATH, `${base}/`);
  } catch {
    throw new WftlsConfigurationError("WFTLS_BASE_URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WftlsConfigurationError("WFTLS_BASE_URL must use HTTP or HTTPS");
  }
  return { url: url.toString(), token };
}

function retryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function waitForRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25 * 2 ** (attempt - 1)));
}

/**
 * Fetch the source-owned school meeting-preparation view. This is deliberately
 * the only WFTLS request in this module: no alternate source fallback is permitted.
 */
export async function fetchWftlsMeetingPrep(): Promise<{ schools: MeetingPrepSchool[] }> {
  const { url, token } = wftlsUrl();
  let lastTransportError: unknown;
  for (let attempt = 1; attempt <= WFTLS_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(WFTLS_TIMEOUT_MS),
      });
      if (!response.ok) {
        if (retryableStatus(response.status) && attempt < WFTLS_MAX_ATTEMPTS) {
          await waitForRetry(attempt);
          continue;
        }
        throw new WftlsHttpError(response.status);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new WftlsResponseValidationError();
      }
      const parsed = meetingPrepResponseSchema.safeParse(body);
      if (!parsed.success) throw new WftlsResponseValidationError();
      return { schools: parsed.data.schools.map(adaptWftlsSchool) };
    } catch (error) {
      if (error instanceof WftlsHttpError || error instanceof WftlsResponseValidationError) {
        throw error;
      }
      lastTransportError = error;
      if (attempt < WFTLS_MAX_ATTEMPTS) {
        await waitForRetry(attempt);
        continue;
      }
    }
  }
  throw new WftlsTransportError("WFTLS meeting-prep request could not be completed", {
    cause: lastTransportError,
  });
}

function supportLine(support: Support): string {
  const details = [
    `Status: ${support.status ?? NOT_RECORDED}`,
    support.owner ? `Owner: ${support.owner}` : support.guide ? `Guide: ${support.guide}` : null,
    support.startDate ? `Start: ${support.startDate}` : null,
    support.endDate ? `End: ${support.endDate}` : null,
    support.lastModified ? `Updated: ${support.lastModified}` : null,
  ].filter(Boolean);
  return `${support.type} — ${details.join("; ")}`;
}

/**
 * Deterministic, source-backed section appended to every generated relationship
 * briefing. It deliberately does not ask the model to choose, summarize, or omit
 * schools, so staff see the complete current result from the canonical source.
 */
export function formatSchoolsInGeographiesOfInterest(
  input: SchoolGeographyPrepInput,
): string {
  if (input.fundingRegionIds.length === 0) {
    return "Schools in Geographies of Interest\nNo funding geographies are recorded for this funder.";
  }

  const byId = new Map(input.regions.map((region) => [region.id, region]));
  const aliasesByRegion = new Map<string, string[]>();
  for (const { regionId, alias } of input.aliases ?? []) {
    aliasesByRegion.set(regionId, [...(aliasesByRegion.get(regionId) ?? []), alias]);
  }
  const matches = makeSchools(input)
    .map((school) => ({
      school,
      geographies: matchingRoots(
        school,
        input.fundingRegionIds,
        input.containment,
        byId,
        aliasesByRegion,
      ),
    }))
    .filter((entry) => entry.geographies.length > 0);

  const formatGroup = (
    title: string,
    entries: typeof matches,
    render: (school: School) => string[],
  ): string[] => {
    if (!entries.length) return [`${title}\nNo matching ${title.toLowerCase()}.`];
    const groups = new Map<string, typeof matches>();
    for (const entry of entries) {
      const key = entry.geographies.join(" • ");
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    const lines = [title];
    for (const [geographies, group] of groups) {
      lines.push(geographies);
      for (const { school } of group.sort((a, b) => a.school.name.localeCompare(b.school.name))) {
        lines.push(...render(school).map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`)));
      }
    }
    return lines;
  };

  const emerging = matches.filter((entry) => norm(entry.school.status) === "emerging");
  const open = matches.filter((entry) => norm(entry.school.status) === "open");
  const lines = ["Schools in Geographies of Interest"];
  lines.push(
    ...formatGroup("Emerging Schools", emerging, (school) => [
      `${school.name} — ${displayLocation(school.locations)}`,
      `School Status: ${school.status ?? NOT_RECORDED}; SSJ Stage: ${school.stage ?? NOT_RECORDED}; Projected open: ${school.projectedOpen ?? NOT_RECORDED}; Readiness: ${school.readiness ?? NOT_RECORDED}`,
      `Current status: ${school.narrative ?? NOT_RECORDED}`,
    ]),
  );
  lines.push(
    ...formatGroup("Open Schools", open, (school) => {
      const flags = [
        school.riskFactors ? `Risk factors: ${school.riskFactors}` : null,
        school.watchlist ? `Watchlist: ${school.watchlist}` : null,
        ...school.supports.map(supportLine),
      ].filter(Boolean) as string[];
      return [
        `${school.name} — ${displayLocation(school.locations)}`,
        `Current/open status: ${school.status ?? NOT_RECORDED}`,
        ...(flags.length ? flags : ["No current risk or support flags"]),
      ];
    }),
  );

  if (!matches.length) {
    lines.splice(1, 0, "No matching schools exist in the funder’s geographies of interest.");
  }
  return lines.join("\n");
}

/**
 * Fetch canonical school records afresh for each prep generation. Nothing is
 * persisted in WFCRM; the existing local Schools mirror remains independent.
 */
export async function getSchoolsInGeographiesOfInterest(
  fundingRegionIds: string[],
): Promise<string> {
  if (!fundingRegionIds.length) {
    return formatSchoolsInGeographiesOfInterest({
      fundingRegionIds,
      regions: [],
      aliases: [],
      containment: new Map(),
      schools: [],
    });
  }

  const [regionRows, aliasRows, containment, wftls] = await Promise.all([
    db
      .select({
        id: regions.id,
        name: regions.name,
        displayPath: regions.displayPath,
        stateAbbreviation: regions.stateAbbreviation,
        type: regions.type,
        parentRegionId: regions.parentRegionId,
      })
      .from(regions)
      .where(isNull(regions.archivedAt)),
    db.select({ regionId: regionAliases.regionId, alias: regionAliases.alias }).from(regionAliases),
    deriveContainment(fundingRegionIds),
    fetchWftlsMeetingPrep(),
  ]);
  return formatSchoolsInGeographiesOfInterest({
    fundingRegionIds,
    regions: regionRows,
    aliases: aliasRows,
    containment,
    schools: wftls.schools,
  });
}
