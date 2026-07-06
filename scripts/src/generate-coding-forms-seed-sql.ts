// Generator (run once, re-runnable) for the idempotent PRODUCTION seed of the
// Wildflower Donation Coding Forms into the `coding_form_rows` staging table.
//
// The agent cannot write prod, so instead of running the importer against prod we
// emit a STATIC, reviewable SQL file a human applies once with psql. The emitted
// file is a byte-for-byte mirror of what `scripts/src/import-coding-forms.ts`
// would write: the same deterministic id (`cfr_<source>_<rowIndex>`), the same 30
// captured columns, and the SAME `ON CONFLICT (id) DO UPDATE` set-list that only
// ever refreshes the RAW / normalized captured values (+ updated_at). It NEVER
// touches reviewer `decisions`, `status`, the proposed/confirmed `match_*`, the
// `applied_*` artifact ids, or the `grant_letter_*` import state — so applying it
// on top of a partially-reviewed prod table picks up corrected spreadsheets
// without discarding human review.
//
// TZ is pinned to UTC before importing xlsx so Excel date serials are decoded
// deterministically (no machine-timezone day-shift) — matches the importer's
// raw:false string reads but keeps any date-typed cells stable.
//
// Run with:  pnpm --filter @workspace/scripts run gen:coding-forms-seed
// Output:    lib/db/migrations/0100_seed_coding_form_rows.sql
process.env.TZ = "UTC";

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  parseFormSheet,
  parseGirasolSheet,
  type ParsedCodingFormRow,
} from "./lib/coding-forms-parse";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const ROOT = path.resolve(import.meta.dirname, "../..");
const ASSETS = path.join(ROOT, "attached_assets");
const OUT = path.join(ROOT, "lib/db/migrations/0100_seed_coding_form_rows.sql");

const FILES = {
  fy24: "FY24_Donation_Coding_Form_(Responses)_1782510326693.xlsx",
  fy25: "FY25_Donation_Revenue_Coding_Form_(Responses)_1782510326692.xlsx",
  fy26: "FY26_Donation_Revenue_Coding_Form_(Responses)_1782510326692.xlsx",
} as const;

const FORM_SHEET = "Form Responses 1";
const GIRASOL_SHEET = "Girasol  Act 60 donations"; // note: two spaces, inside FY25

function readSheet(file: string, sheet: string): unknown[][] {
  const wb = XLSX.readFile(path.join(ASSETS, file));
  const ws = wb.Sheets[sheet];
  if (!ws) throw new Error(`Missing sheet "${sheet}" in ${file}`);
  return XLSX.utils.sheet_to_json(ws, {
    header: 1,
    raw: false,
    defval: null,
  }) as unknown[][];
}

function collectRows(): ParsedCodingFormRow[] {
  const rows: ParsedCodingFormRow[] = [];
  rows.push(...parseFormSheet("fy24", readSheet(FILES.fy24, FORM_SHEET)));
  rows.push(...parseFormSheet("fy25", readSheet(FILES.fy25, FORM_SHEET)));
  rows.push(...parseFormSheet("fy26", readSheet(FILES.fy26, FORM_SHEET)));
  rows.push(...parseGirasolSheet(readSheet(FILES.fy25, GIRASOL_SHEET)));
  return rows;
}

// ── SQL literal helpers (standard_conforming_strings=on: only single quotes are
//    doubled; backslashes are literal). ──────────────────────────────────────
function txt(v: string | null): string {
  if (v == null) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

function jsonbLit(v: Record<string, unknown>): string {
  const json = JSON.stringify(v);
  return `'${json.replace(/'/g, "''")}'::jsonb`;
}

function intLit(v: number): string {
  if (!Number.isInteger(v)) throw new Error(`Non-integer: ${v}`);
  return String(v);
}

function numLit(v: string | null): string {
  if (v == null) return "NULL";
  if (!/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`Bad numeric literal: ${v}`);
  return v;
}

function dateLit(v: string | null): string {
  if (v == null) return "NULL";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`Bad date literal: ${v}`);
  return `DATE '${v}'`;
}

function boolLit(v: boolean | null): string {
  return v == null ? "NULL" : v ? "TRUE" : "FALSE";
}

// intended_usage enum — a bare quoted string assignment-casts to the column's
// enum type inside INSERT ... VALUES, so no explicit cast is needed here.
function enumLit(v: string | null): string {
  return v == null ? "NULL" : `'${v.replace(/'/g, "''")}'`;
}

// The 30 columns, in the exact order the importer inserts them.
const COLUMNS = [
  "id",
  "source",
  "source_row_index",
  "raw_data",
  "donor_name_raw",
  "internal_memo",
  "donor_type_raw",
  "series_type_raw",
  "restriction_language",
  "donor_name_address_raw",
  "report_required_raw",
  "drive_link",
  "circle_raw",
  "additional_notes",
  "payment_method_raw",
  "stripe_fees_raw",
  "class_raw",
  "submitter_email",
  "wildflower_partner",
  "amount",
  "donation_date",
  "deposit_date",
  "addr_street",
  "addr_city",
  "addr_state",
  "addr_postal",
  "addr_country",
  "report_required",
  "report_due_date",
  "intended_usage_suggested",
] as const;

// The subset the re-run refreshes on conflict — everything EXCEPT the identity
// columns (id / source / source_row_index). Mirrors import-coding-forms.ts.
const UPDATE_COLUMNS = COLUMNS.slice(3);

function valuesTuple(row: ParsedCodingFormRow): string {
  const id = `cfr_${row.source}_${row.sourceRowIndex}`;
  const cells = [
    txt(id),
    txt(row.source),
    intLit(row.sourceRowIndex),
    jsonbLit(row.rawData),
    txt(row.donorNameRaw),
    txt(row.internalMemo),
    txt(row.donorTypeRaw),
    txt(row.seriesTypeRaw),
    txt(row.restrictionLanguage),
    txt(row.donorNameAddressRaw),
    txt(row.reportRequiredRaw),
    txt(row.driveLink),
    txt(row.circleRaw),
    txt(row.additionalNotes),
    txt(row.paymentMethodRaw),
    txt(row.stripeFeesRaw),
    txt(row.classRaw),
    txt(row.submitterEmail),
    txt(row.wildflowerPartner),
    numLit(row.amount),
    dateLit(row.donationDate),
    dateLit(row.depositDate),
    txt(row.addrStreet),
    txt(row.addrCity),
    txt(row.addrState),
    txt(row.addrPostal),
    txt(row.addrCountry),
    boolLit(row.reportRequired),
    dateLit(row.reportDueDate),
    enumLit(row.intendedUsageSuggested),
  ];
  return `  (${cells.join(", ")})`;
}

function main(): void {
  const rows = collectRows();
  const bySource: Record<string, number> = {};
  for (const r of rows) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  const counts = JSON.stringify(bySource);

  const header = `-- Migration 0100: One-time PRODUCTION seed of the Wildflower Donation Coding
-- Form exports (FY24 / FY25 / FY26 Google Form responses + the Girasol / Act-60
-- sheet) into the coding_form_rows staging table.
--
-- AUTO-GENERATED by scripts/src/generate-coding-forms-seed-sql.ts — DO NOT EDIT.
-- Regenerate (re-runnable) with:
--   pnpm --filter @workspace/scripts run gen:coding-forms-seed
--
-- Source rows: ${counts} (total ${rows.length}).
--
-- WHAT IT DOES — the exact write scripts/src/import-coding-forms.ts performs,
-- rendered as static SQL so a human can apply it to prod (the agent cannot write
-- prod). Each row is keyed by the deterministic id cfr_<source>_<rowIndex> and
-- carries the 30 RAW / normalized captured columns.
--
-- IDEMPOTENT / RE-RUNNABLE — ON CONFLICT (id) DO UPDATE refreshes ONLY the raw /
-- normalized captured columns (+ updated_at). It NEVER writes source /
-- source_row_index (identity) and, critically, NEVER touches:
--   * reviewer decisions (decisions)
--   * lifecycle status (status, applied_at, applied_by_user_id)
--   * the proposed / confirmed match (organization_id, individual_giver_person_id,
--     household_id, matched_opportunity_id, matched_gift_id, match_score,
--     match_method, match_tier, match_confirmed_at, match_confirmed_by_user_id)
--   * applied artifact ids (applied_task_id, applied_address_id,
--     applied_allocation_id)
--   * grant-letter import state (grant_letter_imported_url / _filename / _at,
--     grant_letter_import_error)
-- So re-applying after review (or applying a corrected spreadsheet) picks up new
-- raw values without discarding any human decision.
--
-- ORDERING — the coding_form_rows table + the coding_form_row_status /
-- intended_usage enums ship via schema Publish (see migration 0084's runbook).
-- Apply Publish FIRST; this data seed will fail with "relation does not exist" if
-- the table is not present (see .agents/memory/data-migration-publish-ordering.md).
--
-- Apply with psql -1 (wraps the whole file in ONE transaction; do NOT add a
-- BEGIN/COMMIT here or it nests and warns):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0100_seed_coding_form_rows.sql   (prod)
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0100_seed_coding_form_rows.sql   (dev)

INSERT INTO coding_form_rows (
  ${COLUMNS.join(", ")}
) VALUES
`;

  const body = rows.map(valuesTuple).join(",\n");

  const onConflict = `
ON CONFLICT (id) DO UPDATE SET
${UPDATE_COLUMNS.map((c) => `  ${c} = EXCLUDED.${c}`).join(",\n")},
  updated_at = now();
`;

  const report = `
-- Operator report (non-aborting): how many rows now exist after the seed.
DO $$
DECLARE
  total bigint;
  by_source text;
BEGIN
  SELECT count(*) INTO total FROM coding_form_rows;
  SELECT string_agg(source || '=' || c, ', ' ORDER BY source)
    INTO by_source
    FROM (SELECT source, count(*) AS c FROM coding_form_rows GROUP BY source) s;
  RAISE NOTICE 'coding_form_rows after seed 0100: total=% (%).', total, by_source;
END $$;
`;

  writeFileSync(OUT, `${header}${body}${onConflict}${report}`);
  console.log(`Wrote ${rows.length} coding-form rows to ${OUT}`);
  console.log("Counts:", counts);
}

main();
