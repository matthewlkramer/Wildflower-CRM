import { anthropic, batchProcess } from "@workspace/integrations-anthropic-ai";
import { db } from "@workspace/db";
import { codingFormRows } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  AI_JUNKABLE_FIELDS,
  aiInterpretationSchema,
  type AiInterpretation,
} from "./codingFormEffective";
import { logger } from "./logger";

/**
 * AI reinterpretation of coding-form staging rows (single Zod-validated jsonb
 * payload per row; see codingFormEffective.ts for how downstream code reads
 * the EFFECTIVE values as AI ?? parsed ?? raw).
 *
 * Scope is deliberately narrow — the model may only:
 *   - normalize the donor display name (typos, "org vs person" cleanup),
 *   - re-parse the free-text name+address blob into a structured address,
 *   - reinterpret the "written report required?" answer + due date,
 *   - flag fields as junk/redundant (suppressing tag/notes/address writes).
 * It NEVER maps circles to regions/entities (classifyCircle is deterministic
 * and closed) and never touches amounts, dates, or donor identity/matching.
 *
 * Failure model: a per-row failure is recorded on the row (`ai_error`) and
 * the prior payload is left untouched; success clears the error. Bulk runs
 * therefore never lose work and can be safely re-run for the failures.
 */

const MODEL = "claude-sonnet-4-6";
const MAX_FIELD_CHARS = 2_000;

export type CodingFormRowSelect = typeof codingFormRows.$inferSelect;

const SYSTEM = `You are cleaning up rows from a fundraising team's hand-filled "coding form" spreadsheet before they are imported into a CRM. Each row describes one donation.

Output STRICT JSON with this exact shape and nothing else (no markdown, no code fences, no commentary):
{
  "donorName": "string or null — the donor's display name, normalized: fix obvious typos, strip stray punctuation/whitespace, drop embedded addresses or notes. Keep the SAME donor — never substitute a different name. null when you cannot improve on the raw name.",
  "address": {
    "street": "string or null",
    "city": "string or null",
    "state": "string or null — 2-letter US state code when identifiable",
    "postal": "string or null",
    "country": "string or null — only when clearly not the US"
  },
  "reportRequired": "boolean or null — the reinterpreted answer to 'is a written report required?'. true/false only when the raw answer clearly says so (e.g. 'Yes - annual report', 'no report needed', 'N' → false). null when the answer is ambiguous or absent.",
  "reportDueDate": "YYYY-MM-DD or null — only when the raw answer states an explicit due date. Resolve partial dates conservatively (e.g. '6/30/25' → '2025-06-30'); null if you cannot resolve a full calendar date.",
  "junkFields": ["zero or more of: ${AI_JUNKABLE_FIELDS.join(", ")}"],
  "notes": "string or null — ONE short sentence for the human reviewer explaining anything non-obvious you did. null when nothing noteworthy."
}

Rules:
- "address" is null unless the name+address blob contains a usable mailing address. Parse ONLY what is written — never invent components.
- A field belongs in "junkFields" when its content is meaningless filler (e.g. 'see above', 'same', punctuation) OR merely repeats the amount, donor name, or donation date that already have their own columns. When unsure, DO NOT flag it.
- "donorNameAddressRaw" in junkFields means the blob holds NO usable address (e.g. it just repeats the donor name) — then also return "address": null.
- "reportRequiredRaw" in junkFields means the answer cell is filler with no real answer — then also return "reportRequired": null.
- Never flag a field just because it is long or informal; real information must be preserved.
- Do not guess. null / omission is always safer than an invented value.`;

/** Truncate a raw cell for the prompt (cells are normally tiny; belt+braces). */
function cell(v: string | null): string {
  if (v == null) return "(empty)";
  const t = v.trim();
  if (!t) return "(empty)";
  return t.length > MAX_FIELD_CHARS ? `${t.slice(0, MAX_FIELD_CHARS)}…` : t;
}

function buildUserPrompt(row: CodingFormRowSelect): string {
  return [
    `Donor name (raw): ${cell(row.donorNameRaw)}`,
    `Donor name + mailing address blob (raw): ${cell(row.donorNameAddressRaw)}`,
    `Amount: ${row.amount != null ? String(row.amount) : "(empty)"}`,
    `Donation date: ${row.donationDate ? String(row.donationDate) : "(empty)"}`,
    `Written report required? (raw answer): ${cell(row.reportRequiredRaw)}`,
    `Restriction language: ${cell(row.restrictionLanguage)}`,
    `Circle / coding: ${cell(row.circleRaw)}`,
    `Stand-alone vs multi-series: ${cell(row.seriesTypeRaw)}`,
    `Additional notes: ${cell(row.additionalNotes)}`,
    `Internal memo: ${cell(row.internalMemo)}`,
  ].join("\n");
}

function extractJson(text: string): unknown {
  // Tolerate accidental code fences / prose around the JSON object.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object in model output");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type ReinterpretOutcome =
  | { rowId: string; ok: true; interpretation: AiInterpretation }
  | { rowId: string; ok: false; error: string };

/**
 * Reinterpret ONE row and persist the outcome. Success writes the validated
 * payload + provenance stamps and clears `ai_error`; any failure (API error,
 * unparseable output, Zod rejection) records `ai_error` and leaves the
 * previous payload untouched. Never throws.
 */
export async function reinterpretRow(
  row: CodingFormRowSelect,
): Promise<ReinterpretOutcome> {
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM,
      messages: [{ role: "user", content: buildUserPrompt(row) }],
    });
    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }
    const parsed = aiInterpretationSchema.safeParse(extractJson(text));
    if (!parsed.success) {
      throw new Error(
        `model output failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    await db
      .update(codingFormRows)
      .set({
        aiInterpretation: parsed.data,
        aiInterpretedAt: new Date(),
        aiModel: MODEL,
        aiError: null,
        updatedAt: new Date(),
      })
      .where(eq(codingFormRows.id, row.id));
    return { rowId: row.id, ok: true, interpretation: parsed.data };
  } catch (err) {
    // Privacy: log only the error class/message — SDK errors can echo the
    // prompt, which contains donor PII.
    const message = errMessage(err).slice(0, 500);
    logger.warn(
      { rowId: row.id, errMessage: message },
      "coding-form AI reinterpretation failed",
    );
    await db
      .update(codingFormRows)
      .set({ aiError: message, updatedAt: new Date() })
      .where(eq(codingFormRows.id, row.id));
    return { rowId: row.id, ok: false, error: message };
  }
}

/**
 * Reinterpret many rows through the shared rate-limit-aware batch runner
 * (concurrency 2). Per-row failures are contained by `reinterpretRow` (which
 * never throws), so one bad row never aborts the batch.
 */
export async function reinterpretRows(
  rows: CodingFormRowSelect[],
): Promise<ReinterpretOutcome[]> {
  return batchProcess(rows, (row) => reinterpretRow(row), {
    concurrency: 2,
  });
}
