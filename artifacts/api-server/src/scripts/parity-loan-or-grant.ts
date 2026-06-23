/**
 * A002 PARITY GATE — authoritative `loan_or_grant` vs. the legacy signals it
 * supersedes, across the three tables that carry it.
 *
 * For EVERY row it derives loan_or_grant from the LEGACY signal and compares it
 * to the PERSISTED `loan_or_grant` column:
 *   - gifts_and_payments         : legacy = giftTypeToLoanOrGrant(type)
 *   - opportunities_and_pledges  : legacy = legacyCategoryToLoanOrGrant(fundraising_category)
 *   - fiscal_year_entity_goals   : legacy = legacyCategoryToLoanOrGrant(category)
 *
 * Both sides go through the SAME pure mappers the dual-write uses, so any
 * mismatch is real drift between the legacy source and the persisted flag —
 * exactly what flipping reads onto `loan_or_grant` would expose. Because the
 * analytics buckets, the goals filter, and the revenue-coding loan branch all
 * read `loan_or_grant` after the cutover, zero per-row drift here proves the
 * flipped reads produce byte-identical results to the legacy reads.
 *
 * Exit 0 only when there is zero drift on all three tables. This is the DEV
 * gate; the same script is the human-run PROD gate (against $PROD_DATABASE_URL).
 *
 * Run: pnpm --filter @workspace/api-server run parity:loan-or-grant
 *      (optional `--out <path>` writes the full machine-readable report)
 */
import { writeFileSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  giftTypeToLoanOrGrant,
  legacyCategoryToLoanOrGrant,
  type LoanOrGrant,
} from "@workspace/api-zod";

interface LegacyRow {
  id: string;
  legacy_signal: string | null;
  persisted: string | null;
}

interface Mismatch {
  table: string;
  id: string;
  legacySignal: string | null;
  legacy: LoanOrGrant;
  persisted: string | null;
}

async function main(): Promise<void> {
  const outArgIdx = process.argv.indexOf("--out");
  const outPath = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : undefined;

  const giftRows = (
    await db.execute(sql`
      SELECT id, type::text AS legacy_signal, loan_or_grant::text AS persisted
      FROM gifts_and_payments
    `)
  ).rows as unknown as LegacyRow[];

  const oppRows = (
    await db.execute(sql`
      SELECT id, fundraising_category::text AS legacy_signal, loan_or_grant::text AS persisted
      FROM opportunities_and_pledges
    `)
  ).rows as unknown as LegacyRow[];

  const goalRows = (
    await db.execute(sql`
      SELECT (fiscal_year_id || ':' || entity_id || ':' || category) AS id,
             category::text AS legacy_signal,
             loan_or_grant::text AS persisted
      FROM fiscal_year_entity_goals
    `)
  ).rows as unknown as LegacyRow[];

  const mismatches: Mismatch[] = [];
  const check = (
    table: string,
    rows: LegacyRow[],
    map: (s: string | null) => LoanOrGrant,
  ): number => {
    let n = 0;
    for (const r of rows) {
      const legacy = map(r.legacy_signal);
      if (legacy !== r.persisted) {
        mismatches.push({
          table,
          id: r.id,
          legacySignal: r.legacy_signal,
          legacy,
          persisted: r.persisted,
        });
        n++;
      }
    }
    return n;
  };

  const giftMis = check("gifts_and_payments", giftRows, giftTypeToLoanOrGrant);
  const oppMis = check("opportunities_and_pledges", oppRows, legacyCategoryToLoanOrGrant);
  const goalMis = check("fiscal_year_entity_goals", goalRows, legacyCategoryToLoanOrGrant);

  const report = {
    generatedAt: new Date().toISOString(),
    counts: {
      gifts: giftRows.length,
      opportunities: oppRows.length,
      goals: goalRows.length,
      giftMismatches: giftMis,
      oppMismatches: oppMis,
      goalMismatches: goalMis,
    },
    mismatches,
  };
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));

  const sample = mismatches
    .slice(0, 40)
    .map(
      (m) =>
        `    ${m.table}  ${m.id}  legacy(${m.legacySignal ?? "—"})→${m.legacy}  persisted=${m.persisted}`,
    )
    .join("\n");

  console.log("=== loan_or_grant parity report ===");
  console.log(`gifts:         ${giftRows.length}    mismatches: ${giftMis}`);
  console.log(`opportunities: ${oppRows.length}    mismatches: ${oppMis}`);
  console.log(`goals:         ${goalRows.length}    mismatches: ${goalMis}`);
  if (mismatches.length) console.log(`\nMismatches (first 40):\n${sample}`);
  if (outPath) console.log(`\nFull report written to ${outPath}`);

  const failed = mismatches.length > 0;
  console.log(`\nGATE: ${failed ? "FAIL" : "PASS"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Parity check failed:", err);
  process.exit(2);
});
