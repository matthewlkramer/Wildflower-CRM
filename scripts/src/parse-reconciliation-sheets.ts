// Generator (run once, re-runnable) for the Historical Transaction Reconciliation
// Cross-Check. Reads the three transaction-level spreadsheet exports from
// attached_assets/ and writes a normalized, committed TypeScript data module the
// api-server imports at runtime:
//
//   • "StripeDonorbox Donations"        (FY25 workbook) — Donorbox/Stripe gifts
//   • "815 Stripe Transaction Details"  (FY26 workbook) — raw Stripe charges
//   • "FY25 Review"                     (FY25 workbook) — QuickBooks Statement of
//                                                          Activity (Detail)
//
// This is a build-time normalizer ONLY — it never touches the database and never
// mints/imports anything. The cross-check itself (matching these rows against the
// CRM's synced Stripe/QuickBooks data) happens at request time in the api-server.
//
// Run with:  pnpm --filter @workspace/scripts run parse:reconciliation-sheets
//
// TZ is pinned to UTC before importing xlsx so Excel date serials are decoded
// deterministically (no machine-timezone day-shift).
process.env.TZ = "UTC";

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const ASSETS = resolve(REPO_ROOT, "attached_assets");
const OUT = resolve(
  REPO_ROOT,
  "artifacts/api-server/src/data/reconciliationCrosscheckData.ts",
);

const FY25 = resolve(
  ASSETS,
  "FY25_Donation_Revenue_Coding_Form_(Responses)_1782510326692.xlsx",
);
const FY26 = resolve(
  ASSETS,
  "FY26_Donation_Revenue_Coding_Form_(Responses)_1782510326692.xlsx",
);

type Source = "stripe_donorbox" | "stripe_815" | "qbo_fy25";

interface RawRow {
  source: Source;
  rowRef: string;
  date: string | null;
  donorName: string | null;
  donorEmail: string | null;
  grossAmount: number | null;
  feeAmount: number | null;
  netAmount: number | null;
  stripeChargeId: string | null;
  qboType: string | null;
  qboNum: string | null;
  qboAccount: string | null;
  qboLocation: string | null;
  qboMemo: string | null;
}

function loadSheet(file: string, sheet: string): unknown[][] {
  const wb = XLSX.read(readFileSync(file), { cellDates: true });
  const ws = wb.Sheets[sheet];
  if (!ws) throw new Error(`Sheet not found: ${sheet} in ${file}`);
  return XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  });
}

function toIsoDate(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "number") {
    // Excel serial fallback (TZ pinned to UTC above).
    const d = XLSX.SSF ? new Date(Math.round((v - 25569) * 86400 * 1000)) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  }
  if (typeof v === "string") {
    const t = v.trim();
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// ── 1. StripeDonorbox Donations (FY25 workbook) ──────────────────────────────
// Header row 0; columns by name. Stripe Charge Id at index 33. PayPal rows have
// no charge id (Paypal Transaction Id instead) — kept, but with a null charge id
// so the cross-check reports them as unmatched on the Stripe-charge basis.
function parseStripeDonorbox(): RawRow[] {
  const rows = loadSheet(FY25, "StripeDonorbox Donations");
  const out: RawRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const name = str(r[0]);
    const gross = num(r[6]);
    const charge = str(r[33]);
    // Skip fully-empty trailing rows.
    if (!name && gross == null && !charge && !str(r[3])) continue;
    out.push({
      source: "stripe_donorbox",
      rowRef: `stripe_donorbox#${i}`,
      date: toIsoDate(r[18]),
      donorName: name,
      donorEmail: str(r[3]),
      grossAmount: gross,
      feeAmount: num(r[13]),
      netAmount: num(r[14]),
      stripeChargeId: charge,
      qboType: null,
      qboNum: null,
      qboAccount: null,
      qboLocation: null,
      qboMemo: str(r[16]),
    });
  }
  return out;
}

// ── 2. 815 Stripe Transaction Details (FY26 workbook) ────────────────────────
// The sheet's used range starts at column B, so sheet_to_json yields arrays whose
// index 0 maps to column B: Type(0) ID/charge(1) Created(2) Description(3)
// Amount(4) Currency(5) Converted(6) Fees(7) Net(8) ConvertedCcy(9) Details(10)
// Customer ID(11) Customer Email(12) Customer Name(13). Header is at returned
// index 0; data from index 1. Keep only Type === "Charge" rows (Refund / Payout /
// Transfer rows are not donor charges).
function parse815(): RawRow[] {
  const rows = loadSheet(FY26, "815 Stripe Transaction Details");
  const out: RawRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    if (str(r[0]) !== "Charge") continue;
    const charge = str(r[1]);
    if (!charge) continue;
    out.push({
      source: "stripe_815",
      rowRef: `stripe_815#${i}`,
      date: toIsoDate(r[2]),
      donorName: str(r[13]) ?? str(r[12]),
      donorEmail: str(r[12]),
      grossAmount: num(r[4]),
      feeAmount: num(r[7]),
      netAmount: num(r[8]),
      stripeChargeId: charge,
      qboType: null,
      qboNum: null,
      qboAccount: null,
      qboLocation: null,
      qboMemo: str(r[3]),
    });
  }
  return out;
}

// ── 3. FY25 Review — QuickBooks Statement of Activity Detail (FY25 workbook) ──
// A formatted report: section headers ("Income"), GL-account headers
// ("4100.1 Restricted Donations - Individual"), subtotal rows ("Total for ...")
// and real transaction rows. A real transaction row is exactly the row whose
// first cell is a date. We track the most recent GL-account header (a string in
// col 0 that begins with a 4-digit account code) so each transaction carries its
// account.
function parseQboFy25(): RawRow[] {
  const rows = loadSheet(FY25, "FY25 Review");
  const out: RawRow[] = [];
  let currentAccount: string | null = null;
  for (let i = 5; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const c0 = r[0];
    if (c0 instanceof Date) {
      out.push({
        source: "qbo_fy25",
        rowRef: `qbo_fy25#${i}`,
        date: toIsoDate(c0),
        donorName: str(r[3]),
        donorEmail: null,
        grossAmount: num(r[8]),
        feeAmount: null,
        netAmount: null,
        stripeChargeId: null,
        qboType: str(r[1]),
        qboNum: str(r[2]),
        qboAccount: currentAccount,
        qboLocation: str(r[4]),
        qboMemo: str(r[6]),
      });
      continue;
    }
    const label = str(c0);
    if (label && /^\d{4}(\.\d+)?\b/.test(label)) {
      currentAccount = label;
    }
  }
  return out;
}

function main(): void {
  const all = [
    ...parseStripeDonorbox(),
    ...parse815(),
    ...parseQboFy25(),
  ];
  const counts = all.reduce<Record<string, number>>((acc, r) => {
    acc[r.source] = (acc[r.source] ?? 0) + 1;
    return acc;
  }, {});

  const header = `// AUTO-GENERATED by scripts/src/parse-reconciliation-sheets.ts — DO NOT EDIT.
//
// Normalized, read-only snapshot of the three historical transaction spreadsheet
// exports used by the Reconciliation Cross-Check report. Regenerate with:
//   pnpm --filter @workspace/scripts run parse:reconciliation-sheets
//
// Source rows: ${JSON.stringify(counts)}

export type ReconciliationCrosscheckSource =
  | "stripe_donorbox"
  | "stripe_815"
  | "qbo_fy25";

export interface ReconciliationCrosscheckSourceRow {
  source: ReconciliationCrosscheckSource;
  /** Stable per-row id (source + sheet row index). */
  rowRef: string;
  /** ISO yyyy-mm-dd transaction date, when present. */
  date: string | null;
  donorName: string | null;
  donorEmail: string | null;
  /** Gross / fee / net in major units (dollars). */
  grossAmount: number | null;
  feeAmount: number | null;
  netAmount: number | null;
  /** Stripe charge id (ch_...) for the two Stripe sheets; null for QBO/PayPal. */
  stripeChargeId: string | null;
  /** QuickBooks-only context (null for the Stripe sheets). */
  qboType: string | null;
  qboNum: string | null;
  qboAccount: string | null;
  qboLocation: string | null;
  qboMemo: string | null;
}

export const reconciliationCrosscheckRows: readonly ReconciliationCrosscheckSourceRow[] = `;

  const body = JSON.stringify(all, null, 2);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${header}${body} as const;\n`);
  console.log(`Wrote ${all.length} rows to ${OUT}`);
  console.log("Counts:", counts);
}

main();
