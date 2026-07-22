// Re-runnable import of the historical QuickBooks Online bank-register XLS
// exports into the `bank_transactions` raw-evidence table.
//
// The seven exports overlap in date range, so rows are merged and
// deduplicated before insert:
//   - dedup key = the raw register field values
//     date|ref|payee|memo|payment|deposit|type|balance joined with `|`;
//   - the same key can legitimately occur more than once WITHIN one export
//     (e.g. repeated voided payments at an identical running balance), so the
//     true multiplicity of a key is the MAX count observed in any single
//     file; `occurrence` (0-based) distinguishes those copies.
//
// RE-RUN SAFETY: ids are deterministic (`bnk_<sha256(source|key|occurrence)
// prefix>`) and the insert is ON CONFLICT DO NOTHING on the
// (source, dedup_key, occurrence) unique index — a re-run inserts nothing new
// and never touches existing rows.
//
// Usage (dev):  pnpm --filter @workspace/scripts run import:bank-register
// For prod, a human runs it once AFTER the 0156 migration, pointing the
// connection at prod via the $PROD_DATABASE_URL secret (never $DATABASE_URL,
// which is dev); the agent never writes prod directly:
//   DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/scripts run import:bank-register

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pool } from "@workspace/db";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const ROOT = path.resolve(import.meta.dirname, "../..");
const ASSETS = path.join(ROOT, "attached_assets");

const FILES = [
  "Register_1784754211249.xls",
  "Register_(1)_1784754958698.xls",
  "Register_(2)_1784754958697.xls",
  "Register_(3)_1784754958697.xls",
  "Register_(4)_1784754958697.xls",
  "Register_(5)_1784754958696.xls",
  "Register_(6)_1784754958696.xls",
];

const SOURCE = "qbo_register_export";
const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;

interface RegisterRow {
  file: string;
  date: string; // MM/DD/YYYY as exported
  ref: string;
  payee: string;
  memo: string;
  cls: string;
  payment: string;
  deposit: string;
  recon: string;
  balance: string;
  type: string;
  account: string;
  location: string;
  banking: string;
}

function parseFile(file: string): RegisterRow[] {
  const wb = XLSX.readFile(path.join(ASSETS, file));
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    raw: false,
    defval: "",
  }) as string[][];
  const hi = rows.findIndex((r) => r[0] === "Date" && r.includes("Balance"));
  if (hi < 0) throw new Error(`No header row in ${file}`);
  const col: Record<string, number> = {};
  rows[hi].forEach((h, i) => (col[h] = i));
  const need = (name: string): number => {
    const i = col[name];
    if (i === undefined) throw new Error(`Missing column "${name}" in ${file}`);
    return i;
  };
  return rows
    .slice(hi + 1)
    .filter((r) => DATE_RE.test(r[0] ?? ""))
    .map((r) => ({
      file,
      date: r[need("Date")],
      ref: r[col["Ref No."]] || "",
      payee: r[col["Payee"]] || "",
      memo: r[col["Memo"]] || "",
      cls: r[col["Class"]] || "",
      payment: r[col["Payment"]] || "",
      deposit: r[col["Deposit"]] || "",
      recon: r[col["Reconciliation Status"]] || "",
      balance: r[need("Balance")] || "",
      type: r[col["Type"]] || "",
      account: r[col["Account"]] || "",
      location: r[col["Location"]] || "",
      banking: r[col["Added in Banking"]] || "",
    }));
}

const dedupKey = (t: RegisterRow): string =>
  [t.date, t.ref, t.payee, t.memo, t.payment, t.deposit, t.type, t.balance].join("|");

/** Merge overlapping exports: per key keep the copies from the single file
 *  that saw the key the most times (its true intra-file multiplicity). */
function mergeAndDedup(all: RegisterRow[]): { row: RegisterRow; key: string; occurrence: number }[] {
  const groups = new Map<string, Map<string, RegisterRow[]>>();
  for (const t of all) {
    const k = dedupKey(t);
    let byFile = groups.get(k);
    if (!byFile) groups.set(k, (byFile = new Map()));
    let arr = byFile.get(t.file);
    if (!arr) byFile.set(t.file, (arr = []));
    arr.push(t);
  }
  const merged: { row: RegisterRow; key: string; occurrence: number }[] = [];
  for (const [k, byFile] of groups) {
    let best: RegisterRow[] | null = null;
    for (const arr of byFile.values()) {
      if (!best || arr.length > best.length) best = arr;
    }
    best!.forEach((row, i) => merged.push({ row, key: k, occurrence: i }));
  }
  return merged;
}

const toIsoDate = (mdy: string): string => {
  const [m, d, y] = mdy.split("/");
  return `${y}-${m}-${d}`;
};

const toNumeric = (s: string): string | null => {
  const v = s.replace(/,/g, "").trim();
  if (!v) return null;
  if (!/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`Unparseable amount: "${s}"`);
  return v;
};

const emptyToNull = (s: string): string | null => (s.trim() ? s : null);

const makeId = (key: string, occurrence: number): string =>
  `bnk_${createHash("sha256").update(`${SOURCE}|${key}|${occurrence}`).digest("hex").slice(0, 24)}`;

async function main(): Promise<void> {
  const all: RegisterRow[] = [];
  for (const f of FILES) {
    const rows = parseFile(f);
    console.log(`${f}: ${rows.length} rows`);
    all.push(...rows);
  }
  console.log(`raw rows across files: ${all.length}`);

  const merged = mergeAndDedup(all);
  console.log(
    `merged unique rows: ${merged.length} (removed ${all.length - merged.length} cross-file duplicates)`,
  );

  const COLS = 19;
  const BATCH = 250;
  let inserted = 0;
  for (let i = 0; i < merged.length; i += BATCH) {
    const batch = merged.slice(i, i + BATCH);
    const params: (string | number | null)[] = [];
    const tuples = batch.map(({ row, key, occurrence }, j) => {
      params.push(
        makeId(key, occurrence),
        SOURCE,
        row.file,
        toIsoDate(row.date),
        emptyToNull(row.type),
        emptyToNull(row.ref),
        emptyToNull(row.payee),
        emptyToNull(row.memo),
        emptyToNull(row.cls),
        emptyToNull(row.account),
        emptyToNull(row.location),
        emptyToNull(row.recon),
        emptyToNull(row.banking),
        toNumeric(row.payment),
        toNumeric(row.deposit),
        toNumeric(row.balance),
        key,
        occurrence,
        // created_at uses the column default
      );
      const base = j * (COLS - 1);
      return `(${Array.from({ length: COLS - 1 }, (_, c) => `$${base + c + 1}`).join(", ")})`;
    });
    const res = await pool.query(
      `INSERT INTO bank_transactions (
         id, source, source_file, txn_date, txn_type, ref_no, payee, memo,
         class, account, location, reconciliation_status, added_in_banking,
         payment, deposit, balance, dedup_key, occurrence
       ) VALUES ${tuples.join(", ")}
       ON CONFLICT (source, dedup_key, occurrence) DO NOTHING`,
      params,
    );
    inserted += res.rowCount ?? 0;
  }
  console.log(`inserted: ${inserted} (skipped ${merged.length - inserted} already present)`);

  const count = await pool.query(
    `SELECT count(*)::int AS n,
            min(txn_date)::text AS min_date,
            max(txn_date)::text AS max_date,
            count(*) FILTER (WHERE deposit IS NOT NULL)::int AS money_in
       FROM bank_transactions WHERE source = $1`,
    [SOURCE],
  );
  console.log("table state:", count.rows[0]);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
