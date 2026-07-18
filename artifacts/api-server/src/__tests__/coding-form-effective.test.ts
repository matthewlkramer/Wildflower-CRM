// Unit tests for the coding-form effective-value accessor: junk suppression,
// circle classification, and the AI ?? parsed ?? raw resolution order.

import { describe, expect, it } from "vitest";
import {
  aiInterpretationSchema,
  classifyCircle,
  cleanText,
  effectiveAddress,
  effectiveCircle,
  effectiveDonorName,
  effectiveReport,
  effectiveText,
  isValidIsoDate,
  parseAiInterpretation,
  type CodingFormRowValues,
} from "../lib/codingFormEffective";

function rowWith(overrides: Partial<CodingFormRowValues> = {}): CodingFormRowValues {
  return {
    donorNameRaw: "Acme Foundation",
    internalMemo: null,
    restrictionLanguage: null,
    additionalNotes: null,
    circleRaw: null,
    seriesTypeRaw: null,
    donorNameAddressRaw: null,
    reportRequiredRaw: null,
    addrStreet: null,
    addrCity: null,
    addrState: null,
    addrPostal: null,
    addrCountry: null,
    reportRequired: null,
    reportDueDate: null,
    aiInterpretation: null,
    ...overrides,
  };
}

const AI_BASE = {
  donorName: null,
  address: null,
  reportRequired: null,
  reportDueDate: null,
  junkFields: [] as string[],
  notes: null,
};

describe("cleanText", () => {
  it("passes real text through trimmed", () => {
    expect(cleanText("  hello world  ")).toBe("hello world");
  });
  it("suppresses junk tokens case-insensitively with trailing periods", () => {
    for (const junk of ["n/a", "N/A", "N/A.", "na", "none", "None.", "-", "--", "–", "x", "X", "tbd", "TBD", "?"]) {
      expect(cleanText(junk)).toBeNull();
    }
  });
  it("does NOT suppress meaningful short answers", () => {
    expect(cleanText("no")).toBe("no");
    expect(cleanText("PR")).toBe("PR");
  });
  it("handles null/empty", () => {
    expect(cleanText(null)).toBeNull();
    expect(cleanText("   ")).toBeNull();
  });
});

describe("classifyCircle", () => {
  it("maps the geographic hubs to region ids", () => {
    expect(classifyCircle("Hub: Colorado")).toMatchObject({ kind: "hub_region", regionId: "united_states__colorado" });
    expect(classifyCircle("Hub: PR")).toMatchObject({ kind: "hub_region", regionId: "united_states__puerto_rico" });
    expect(classifyCircle("Hub: Puerto Rico")).toMatchObject({ kind: "hub_region", regionId: "united_states__puerto_rico" });
    expect(classifyCircle("Hub: MN")).toMatchObject({ kind: "hub_region", regionId: "united_states__minnesota" });
    expect(classifyCircle("Hub: Minnesota")).toMatchObject({ kind: "hub_region", regionId: "united_states__minnesota" });
    expect(classifyCircle("Hub: DC")).toMatchObject({
      kind: "hub_region",
      regionId: "united_states__maryland__dc_metro_area",
    });
  });
  it("maps Mid Atlantic variants including 'formerly Pennsylvania'", () => {
    expect(classifyCircle("Hub: Mid Atlantic")).toMatchObject({ kind: "hub_region", regionId: "united_states__mid_atlantic" });
    expect(classifyCircle("Hub: Mid-Atlantic")).toMatchObject({ kind: "hub_region", regionId: "united_states__mid_atlantic" });
    expect(classifyCircle("Hub: Mid Atlantic (formerly Pennsylvania)")).toMatchObject({
      kind: "hub_region",
      regionId: "united_states__mid_atlantic",
    });
  });
  it("maps Black Wildflowers Fund circles to the fund entity", () => {
    expect(classifyCircle("SPO: Black Wildflowers Fund")).toMatchObject({
      kind: "entity",
      entityId: "black_wildflowers_fund",
    });
    expect(classifyCircle("Black Wildflowers Fund")).toMatchObject({ kind: "entity" });
  });
  it("returns other for unmapped hubs (Radicle is a cohort, not a place)", () => {
    expect(classifyCircle("Hub: Radicle")).toMatchObject({ kind: "other" });
    expect(classifyCircle("Something else")).toMatchObject({ kind: "other" });
  });
  it("returns null for junk/empty", () => {
    expect(classifyCircle(null)).toBeNull();
    expect(classifyCircle("n/a")).toBeNull();
    expect(classifyCircle("  ")).toBeNull();
  });
  it("does not map bare 'CO'-containing words (e.g. 'Community')", () => {
    expect(classifyCircle("Hub: Community")).toMatchObject({ kind: "other" });
  });
});

describe("aiInterpretationSchema", () => {
  it("accepts a full valid payload", () => {
    const parsed = aiInterpretationSchema.safeParse({
      ...AI_BASE,
      donorName: "The Acme Foundation",
      address: { street: "1 Main St", city: "Denver", state: "CO", postal: "80202", country: null },
      reportRequired: true,
      reportDueDate: "2026-06-30",
      junkFields: ["restrictionLanguage"],
      notes: "Restriction text repeats the amount.",
    });
    expect(parsed.success).toBe(true);
  });
  it("rejects invalid calendar dates (round-trip check)", () => {
    expect(isValidIsoDate("2026-13-40")).toBe(false);
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("2026-02-28")).toBe(true);
    const parsed = aiInterpretationSchema.safeParse({ ...AI_BASE, reportDueDate: "2026-13-40" });
    expect(parsed.success).toBe(false);
  });
  it("rejects unknown junk fields and unknown keys", () => {
    expect(aiInterpretationSchema.safeParse({ ...AI_BASE, junkFields: ["donorNameRaw"] }).success).toBe(false);
    expect(aiInterpretationSchema.safeParse({ ...AI_BASE, extra: 1 }).success).toBe(false);
  });
  it("parseAiInterpretation degrades invalid payloads to null", () => {
    expect(parseAiInterpretation({ garbage: true })).toBeNull();
    expect(parseAiInterpretation(null)).toBeNull();
    expect(parseAiInterpretation(AI_BASE)).not.toBeNull();
  });
});

describe("effectiveDonorName", () => {
  it("prefers the AI-normalized name", () => {
    const row = rowWith({ aiInterpretation: { ...AI_BASE, donorName: "Acme Fdn (normalized)" } });
    expect(effectiveDonorName(row)).toBe("Acme Fdn (normalized)");
  });
  it("falls back to raw when AI is absent or silent", () => {
    expect(effectiveDonorName(rowWith())).toBe("Acme Foundation");
    expect(effectiveDonorName(rowWith({ aiInterpretation: AI_BASE }))).toBe("Acme Foundation");
  });
});

describe("effectiveAddress", () => {
  it("prefers the AI address", () => {
    const row = rowWith({
      addrStreet: "old street",
      aiInterpretation: {
        ...AI_BASE,
        address: { street: "1 Main St", city: "Denver", state: "CO", postal: "80202", country: null },
      },
    });
    expect(effectiveAddress(row)).toMatchObject({ street: "1 Main St", city: "Denver", source: "ai" });
  });
  it("falls back to parsed columns, then the raw blob as street", () => {
    expect(effectiveAddress(rowWith({ addrCity: "Denver", addrState: "CO" }))).toMatchObject({
      city: "Denver",
      source: "parsed",
    });
    expect(effectiveAddress(rowWith({ donorNameAddressRaw: "some unparseable blob" }))).toMatchObject({
      street: "some unparseable blob",
      source: "raw",
    });
    expect(effectiveAddress(rowWith())).toBeNull();
  });
  it("suppresses the raw fallback when AI junks the address field", () => {
    const row = rowWith({
      donorNameAddressRaw: "just the donor name again",
      aiInterpretation: { ...AI_BASE, junkFields: ["donorNameAddressRaw"] },
    });
    expect(effectiveAddress(row)).toBeNull();
  });
  it("ignores an all-null AI address object", () => {
    const row = rowWith({
      addrCity: "Denver",
      aiInterpretation: {
        ...AI_BASE,
        address: { street: null, city: null, state: null, postal: null, country: null },
      },
    });
    expect(effectiveAddress(row)).toMatchObject({ city: "Denver", source: "parsed" });
  });
});

describe("effectiveReport", () => {
  it("prefers AI reinterpretation when present", () => {
    const row = rowWith({
      reportRequired: false,
      aiInterpretation: { ...AI_BASE, reportRequired: true, reportDueDate: "2026-06-30" },
    });
    expect(effectiveReport(row)).toEqual({ required: true, dueDate: "2026-06-30", source: "ai" });
  });
  it("AI junk flag on the raw answer means no report", () => {
    const row = rowWith({
      reportRequired: null,
      aiInterpretation: { ...AI_BASE, junkFields: ["reportRequiredRaw"] },
    });
    expect(effectiveReport(row)).toEqual({ required: false, dueDate: null, source: "ai" });
  });
  it("falls back to parsed columns when AI is silent", () => {
    const row = rowWith({ reportRequired: true, reportDueDate: "2025-12-31", aiInterpretation: AI_BASE });
    expect(effectiveReport(row)).toEqual({ required: true, dueDate: "2025-12-31", source: "parsed" });
  });
});

describe("effectiveText / effectiveCircle", () => {
  it("suppresses deterministic junk and AI-flagged junk", () => {
    expect(effectiveText(rowWith({ restrictionLanguage: "n/a" }), "restrictionLanguage")).toBeNull();
    const row = rowWith({
      restrictionLanguage: "$5,000 from Acme Foundation",
      aiInterpretation: { ...AI_BASE, junkFields: ["restrictionLanguage"] },
    });
    expect(effectiveText(row, "restrictionLanguage")).toBeNull();
    expect(effectiveText(rowWith({ restrictionLanguage: "For teacher training only" }), "restrictionLanguage")).toBe(
      "For teacher training only",
    );
  });
  it("effectiveCircle classifies the junk-suppressed circle text", () => {
    expect(effectiveCircle(rowWith({ circleRaw: "Hub: Colorado" }))).toMatchObject({
      kind: "hub_region",
      regionId: "united_states__colorado",
    });
    expect(effectiveCircle(rowWith({ circleRaw: "n/a" }))).toBeNull();
    const junked = rowWith({
      circleRaw: "Hub: Colorado",
      aiInterpretation: { ...AI_BASE, junkFields: ["circleRaw"] },
    });
    expect(effectiveCircle(junked)).toBeNull();
  });
});
