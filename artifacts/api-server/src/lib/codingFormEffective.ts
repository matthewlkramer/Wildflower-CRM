// Single source of truth for reading coding-form staging-row VALUES.
//
// Every field a downstream step consumes (cross-checks, apply, matching,
// serialization) must be read through the effective accessors here, which
// resolve per field as: AI reinterpretation ?? deterministic parse ?? raw.
// The AI payload is a single Zod-validated jsonb blob (`ai_interpretation`);
// an invalid/missing payload degrades cleanly to the parsed/raw values, so
// deterministic behavior never depends on AI availability.
//
// Also home to the two deterministic classifiers the import pipeline shares:
//   - `cleanText` — junk-token suppression ("n/a", "none", "-", …)
//   - `classifyCircle` — "Hub: X" → region id / Black Wildflowers Fund → entity
// These are authoritative; the AI payload can only ADD suppression (flag a
// field as junk/redundant) — it can never resurrect a deterministically-junk
// value or invent a region/entity mapping.

import { z } from "zod";

// ── AI interpretation payload ───────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate an ISO date string round-trips through Date (rejects 2026-13-40). */
export function isValidIsoDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === v;
}

const isoDateOrNull = z
  .string()
  .nullable()
  .superRefine((v, ctx) => {
    if (v !== null && !isValidIsoDate(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid ISO date" });
    }
  });

/**
 * Row fields the AI may flag as junk/redundant (suppressed from tag/notes
 * writes and cross-checks). `donorNameRaw` is deliberately NOT includable —
 * the row's identity is its donor text; the AI normalizes it instead.
 */
export const AI_JUNKABLE_FIELDS = [
  "internalMemo",
  "restrictionLanguage",
  "additionalNotes",
  "circleRaw",
  "seriesTypeRaw",
  "donorNameAddressRaw",
  "reportRequiredRaw",
] as const;
export type AiJunkableField = (typeof AI_JUNKABLE_FIELDS)[number];

export const aiInterpretationSchema = z
  .object({
    /** Normalized donor display name (typo-fixed, org-vs-person cleaned). */
    donorName: z.string().trim().min(1).nullable(),
    /** Structured address re-parsed from the free-text name+address blob. */
    address: z
      .object({
        street: z.string().trim().min(1).nullable(),
        city: z.string().trim().min(1).nullable(),
        state: z.string().trim().min(1).nullable(),
        postal: z.string().trim().min(1).nullable(),
        country: z.string().trim().min(1).nullable(),
      })
      .nullable(),
    /** Reinterpreted "written report required?" answer. */
    reportRequired: z.boolean().nullable(),
    reportDueDate: isoDateOrNull,
    /** Fields whose content is junk or merely repeats amount/donor/date. */
    junkFields: z.array(z.enum(AI_JUNKABLE_FIELDS)).default([]),
    /** Short human-readable rationale for the reviewer UI. */
    notes: z.string().trim().max(1000).nullable(),
  })
  .strict();

export type AiInterpretation = z.infer<typeof aiInterpretationSchema>;

/** Parse the stored jsonb payload; invalid/missing → null (degrade to parsed/raw). */
export function parseAiInterpretation(value: unknown): AiInterpretation | null {
  if (value == null) return null;
  const parsed = aiInterpretationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ── Junk-token suppression ──────────────────────────────────────────────────

// Deterministic junk answers people type into required form fields. Matched
// whole-string, case-insensitive, ignoring trailing periods. Deliberately
// conservative: "no" is NOT junk (it's a meaningful report answer) — field-
// specific semantics stay in the parsers.
const JUNK_TOKENS = new Set(["n/a", "na", "none", "-", "--", "–", "tbd", "x", "?"]);

/** Trim; return null for empty or pure junk tokens ("n/a", "none", "-"…). */
export function cleanText(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (!t) return null;
  const norm = t.toLowerCase().replace(/\.+$/, "").trim();
  if (JUNK_TOKENS.has(norm)) return null;
  return t;
}

// ── Circle / hub classification ─────────────────────────────────────────────

export type CircleClassification =
  /** Geographic hub → allocation region + donor_restricted regional axis. */
  | { kind: "hub_region"; regionId: string; label: string }
  /** Black Wildflowers Fund circle → allocation entity. */
  | { kind: "entity"; entityId: "black_wildflowers_fund"; label: string }
  /** Meaningful text with no deterministic mapping (e.g. "Hub: Radicle"). */
  | { kind: "other"; label: string };

// Alias → region id. Region ids verified against prod `regions` (2026-07):
// united_states__colorado / __puerto_rico / __minnesota / __mid_atlantic;
// "Hub: DC" → the DC Metro Area region under Maryland.
const HUB_REGION_ALIASES: [RegExp, string][] = [
  [/colorado|^co$/i, "united_states__colorado"],
  [/puerto\s*rico|^pr$/i, "united_states__puerto_rico"],
  [/minnesota|^mn$/i, "united_states__minnesota"],
  [/mid[\s-]*atlantic|formerly\s+pennsylvania/i, "united_states__mid_atlantic"],
  [/washington\s*,?\s*d\.?c\.?|d\.?c\.?\s*metro|^d\.?c\.?$/i, "united_states__maryland__dc_metro_area"],
];

/**
 * Deterministically classify a circle/hub cell. Junk/empty → null. The alias
 * map is intentionally closed — unmapped hubs (e.g. "Hub: Radicle", a cohort
 * name, not a place) come back as `other` and produce no allocation write.
 */
export function classifyCircle(raw: string | null | undefined): CircleClassification | null {
  const text = cleanText(raw ?? null);
  if (!text) return null;

  // Black Wildflowers Fund circles ("SPO: Black Wildflowers Fund", "Black
  // Wildflowers Fund") → fund entity, regardless of any Hub:/SPO: prefix.
  if (/black\s+wildflowers?\s+fund/i.test(text)) {
    return { kind: "entity", entityId: "black_wildflowers_fund", label: text };
  }

  // Strip a leading "Hub:" / "Hub -" prefix; the remainder names the hub.
  const hubMatch = text.match(/^\s*hub\s*[:\-]?\s*(.+)$/i);
  const candidate = (hubMatch ? hubMatch[1] : text).trim();

  for (const [re, regionId] of HUB_REGION_ALIASES) {
    if (re.test(candidate)) return { kind: "hub_region", regionId, label: text };
  }
  return { kind: "other", label: text };
}

// ── Effective accessors ─────────────────────────────────────────────────────

/** Structural subset of a coding_form_rows row the accessors need. */
export interface CodingFormRowValues {
  donorNameRaw: string | null;
  internalMemo: string | null;
  restrictionLanguage: string | null;
  additionalNotes: string | null;
  circleRaw: string | null;
  seriesTypeRaw: string | null;
  donorNameAddressRaw: string | null;
  reportRequiredRaw: string | null;
  addrStreet: string | null;
  addrCity: string | null;
  addrState: string | null;
  addrPostal: string | null;
  addrCountry: string | null;
  reportRequired: boolean | null;
  reportDueDate: string | null;
  aiInterpretation: unknown;
}

function junked(ai: AiInterpretation | null, field: AiJunkableField): boolean {
  return ai?.junkFields.includes(field) ?? false;
}

/** AI-normalized donor name ?? raw. Never null for seeded rows (donor gates the seed). */
export function effectiveDonorName(row: CodingFormRowValues): string | null {
  const ai = parseAiInterpretation(row.aiInterpretation);
  return ai?.donorName ?? cleanText(row.donorNameRaw);
}

export interface EffectiveAddress {
  street: string | null;
  city: string | null;
  state: string | null;
  postal: string | null;
  country: string | null;
  /** Which layer produced the value (reviewer UI provenance). */
  source: "ai" | "parsed" | "raw";
}

/**
 * AI address ?? parsed addr_* columns ?? whole raw blob as street. Returns
 * null when there is nothing usable (empty/junk raw). The raw fallback keeps
 * the current apply behavior: a lossy string still lands as a street line
 * rather than being dropped.
 */
export function effectiveAddress(row: CodingFormRowValues): EffectiveAddress | null {
  const ai = parseAiInterpretation(row.aiInterpretation);
  if (ai?.address) {
    const a = ai.address;
    if (a.street || a.city || a.state || a.postal || a.country) {
      return { ...a, source: "ai" };
    }
  }
  if (junked(ai, "donorNameAddressRaw")) return null;
  if (row.addrStreet || row.addrCity || row.addrState || row.addrPostal || row.addrCountry) {
    return {
      street: row.addrStreet,
      city: row.addrCity,
      state: row.addrState,
      postal: row.addrPostal,
      country: row.addrCountry,
      source: "parsed",
    };
  }
  const raw = cleanText(row.donorNameAddressRaw);
  if (raw) return { street: raw, city: null, state: null, postal: null, country: null, source: "raw" };
  return null;
}

export interface EffectiveReport {
  required: boolean | null;
  dueDate: string | null;
  source: "ai" | "parsed";
}

/** AI report interpretation ?? parsed report columns. */
export function effectiveReport(row: CodingFormRowValues): EffectiveReport {
  const ai = parseAiInterpretation(row.aiInterpretation);
  // The AI layer applies only when it actually reinterpreted the answer:
  // required non-null, or an explicit junk flag on the raw answer (→ no report).
  if (ai) {
    if (junked(ai, "reportRequiredRaw")) return { required: false, dueDate: null, source: "ai" };
    if (ai.reportRequired !== null) {
      return { required: ai.reportRequired, dueDate: ai.reportDueDate, source: "ai" };
    }
  }
  return { required: row.reportRequired, dueDate: row.reportDueDate, source: "parsed" };
}

/**
 * Junk-suppressed free-text field: deterministic junk tokens AND AI junk
 * flags both suppress; otherwise the trimmed raw text passes through.
 */
export function effectiveText(
  row: CodingFormRowValues,
  field: AiJunkableField | "internalMemo",
): string | null {
  const ai = parseAiInterpretation(row.aiInterpretation);
  const raw = row[field as keyof CodingFormRowValues];
  if (typeof raw !== "string" && raw !== null) return null;
  if (junked(ai, field as AiJunkableField)) return null;
  return cleanText(raw);
}

/** Circle classification of the EFFECTIVE circle text (junk-suppressed). */
export function effectiveCircle(row: CodingFormRowValues): CircleClassification | null {
  return classifyCircle(effectiveText(row, "circleRaw"));
}
