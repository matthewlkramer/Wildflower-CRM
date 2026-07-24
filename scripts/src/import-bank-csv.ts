import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import {
  mergeWellsFargoTransactions,
  parseWellsFargoCsv,
  toIsoDate,
  toNumeric,
  wellsFargoId,
  WELLS_FARGO_SOURCE,
} from "./wellsFargoCsv";

const DEFAULT_GLOB = "/home/ubuntu/attachments";
const BATCH = 250;

async function filesUnder(root: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const dirs = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of dirs) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(full)));
    else if (/Wells_Fargo.*\.csv$/i.test(entry.name)) files.push(full);
  }
  return files.sort();
}

async function main(): Promise<void> {
  const files = await filesUnder(process.env.WELLS_FARGO_DIR ?? DEFAULT_GLOB);
  const all = [];
  const contentHashes = new Set<string>();
  for (const file of files) {
    const content = await readFile(file);
    const contentHash = createHash("sha256").update(content).digest("hex");
    if (contentHashes.has(contentHash)) {
      console.log(`${path.basename(file)}: duplicate file content, skipped`);
      continue;
    }
    contentHashes.add(contentHash);
    const rows = parseWellsFargoCsv(content.toString("utf8"), file);
    console.log(`${path.basename(file)}: ${rows.length} rows`);
    all.push(...rows);
  }
  const merged = mergeWellsFargoTransactions(all);
  console.log(`raw rows: ${all.length}; merged rows: ${merged.length}`);

  let inserted = 0;
  for (let i = 0; i < merged.length; i += BATCH) {
    const batch = merged.slice(i, i + BATCH);
    const params: (string | number | null)[] = [];
    const tuples = batch.map(({ row, dedupKey, occurrence }, index) => {
      params.push(
        wellsFargoId(dedupKey, occurrence),
        WELLS_FARGO_SOURCE,
        row.file,
        toIsoDate(row.date),
        row.received ? "deposit" : "payment",
        row.checkNo || null,
        row.fromTo || null,
        row.description || null,
        null,
        null,
        null,
        null,
        null,
        toNumeric(row.spent),
        toNumeric(row.received),
        null,
        row.qbPosting || null,
        row.donor || null,
        dedupKey,
        occurrence,
      );
      const start = index * 20;
      return `(${Array.from({ length: 20 }, (_, column) => `$${start + column + 1}`).join(", ")})`;
    });
    const result = await pool.query(
      `INSERT INTO bank_transactions (
         id, source, source_file, txn_date, txn_type, ref_no, payee, memo,
         class, account, location, reconciliation_status, added_in_banking,
         payment, deposit, balance, qb_posting, donor, dedup_key, occurrence
       ) VALUES ${tuples.join(", ")}
       ON CONFLICT (source, dedup_key, occurrence) DO NOTHING`,
      params,
    );
    inserted += result.rowCount ?? 0;
  }
  const count = await pool.query(
    `SELECT count(*)::int AS n, min(txn_date)::text AS min_date,
            max(txn_date)::text AS max_date,
            count(*) FILTER (WHERE deposit IS NOT NULL)::int AS money_in
       FROM bank_transactions WHERE source = $1`,
    [WELLS_FARGO_SOURCE],
  );
  console.log(`inserted: ${inserted}; table state:`, count.rows[0]);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
