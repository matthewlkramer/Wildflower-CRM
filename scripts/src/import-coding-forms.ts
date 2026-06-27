// One-time, re-runnable import of the Wildflower Donation Coding Forms into the
// `coding_form_rows` staging table. Parses the FY24 / FY25 / FY26 Google Form
// exports plus the Girasol / Act-60 sheet (inside the FY25 workbook) and upserts
// each gift line.
//
// RE-RUN SAFETY (compare-don't-clobber): rows are keyed by a deterministic id
// (`cfr_<source>_<rowIndex>`); ON CONFLICT only ever refreshes the RAW /
// normalized captured values. It never touches the proposed/confirmed match, the
// reviewer `decisions`, the `status`, or any applied-artifact ids — so a re-run
// picks up corrected spreadsheets without discarding human review.
//
// Usage (dev):  pnpm --filter @workspace/scripts run import:coding-forms
// For prod, a human runs it once with DATABASE_URL pointed at prod (see the
// 0084 runbook); the agent never writes prod directly.

import { createRequire } from "node:module";
import path from "node:path";
import { pool } from "@workspace/db";
import {
  parseFormSheet,
  parseGirasolSheet,
  type ParsedCodingFormRow,
} from "./lib/coding-forms-parse";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const ROOT = path.resolve(import.meta.dirname, "../..");
const ASSETS = path.join(ROOT, "attached_assets");

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

async function upsert(row: ParsedCodingFormRow): Promise<void> {
  const id = `cfr_${row.source}_${row.sourceRowIndex}`;
  await pool.query(
    `INSERT INTO coding_form_rows (
       id, source, source_row_index, raw_data,
       donor_name_raw, internal_memo, donor_type_raw, series_type_raw,
       restriction_language, donor_name_address_raw, report_required_raw,
       drive_link, circle_raw, additional_notes, payment_method_raw,
       stripe_fees_raw, class_raw, submitter_email, wildflower_partner,
       amount, donation_date, deposit_date,
       addr_street, addr_city, addr_state, addr_postal, addr_country,
       report_required, report_due_date, intended_usage_suggested
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10, $11,
       $12, $13, $14, $15,
       $16, $17, $18, $19,
       $20, $21, $22,
       $23, $24, $25, $26, $27,
       $28, $29, $30
     )
     ON CONFLICT (id) DO UPDATE SET
       raw_data = EXCLUDED.raw_data,
       donor_name_raw = EXCLUDED.donor_name_raw,
       internal_memo = EXCLUDED.internal_memo,
       donor_type_raw = EXCLUDED.donor_type_raw,
       series_type_raw = EXCLUDED.series_type_raw,
       restriction_language = EXCLUDED.restriction_language,
       donor_name_address_raw = EXCLUDED.donor_name_address_raw,
       report_required_raw = EXCLUDED.report_required_raw,
       drive_link = EXCLUDED.drive_link,
       circle_raw = EXCLUDED.circle_raw,
       additional_notes = EXCLUDED.additional_notes,
       payment_method_raw = EXCLUDED.payment_method_raw,
       stripe_fees_raw = EXCLUDED.stripe_fees_raw,
       class_raw = EXCLUDED.class_raw,
       submitter_email = EXCLUDED.submitter_email,
       wildflower_partner = EXCLUDED.wildflower_partner,
       amount = EXCLUDED.amount,
       donation_date = EXCLUDED.donation_date,
       deposit_date = EXCLUDED.deposit_date,
       addr_street = EXCLUDED.addr_street,
       addr_city = EXCLUDED.addr_city,
       addr_state = EXCLUDED.addr_state,
       addr_postal = EXCLUDED.addr_postal,
       addr_country = EXCLUDED.addr_country,
       report_required = EXCLUDED.report_required,
       report_due_date = EXCLUDED.report_due_date,
       intended_usage_suggested = EXCLUDED.intended_usage_suggested,
       updated_at = now()`,
    [
      id,
      row.source,
      row.sourceRowIndex,
      JSON.stringify(row.rawData),
      row.donorNameRaw,
      row.internalMemo,
      row.donorTypeRaw,
      row.seriesTypeRaw,
      row.restrictionLanguage,
      row.donorNameAddressRaw,
      row.reportRequiredRaw,
      row.driveLink,
      row.circleRaw,
      row.additionalNotes,
      row.paymentMethodRaw,
      row.stripeFeesRaw,
      row.classRaw,
      row.submitterEmail,
      row.wildflowerPartner,
      row.amount,
      row.donationDate,
      row.depositDate,
      row.addrStreet,
      row.addrCity,
      row.addrState,
      row.addrPostal,
      row.addrCountry,
      row.reportRequired,
      row.reportDueDate,
      row.intendedUsageSuggested,
    ],
  );
}

async function main(): Promise<void> {
  const rows = collectRows();
  const bySource: Record<string, number> = {};
  for (const r of rows) bySource[r.source] = (bySource[r.source] ?? 0) + 1;

  let n = 0;
  for (const row of rows) {
    await upsert(row);
    n++;
  }

  console.log(`Imported/updated ${n} coding-form rows:`);
  for (const [src, count] of Object.entries(bySource)) {
    console.log(`  ${src}: ${count}`);
  }
  await pool.end();
}

await main();
