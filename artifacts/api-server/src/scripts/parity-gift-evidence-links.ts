/**
 * PARITY GATE — gift_evidence_links vs. corroborating payment_applications.
 *
 * The gate that MUST pass (zero orphans, both directions) before the Phase-5
 * read-flip stops writing `gift_evidence_links` (gel) and reads corroborating
 * evidence from the unified `payment_applications` (PA) ledger instead
 * (docs/reconciliation-design.md §7 step 5, §5 Decision 2).
 *
 * The fold is money-total-neutral: corroborating rows carry `link_role =
 * 'corroborating'` and NEVER enter the counted book-once SUM or any tie/settled
 * derivation, so — unlike parity-payment-applications — there is nothing to
 * re-derive. The invariant here is a plain bidirectional SET EQUALITY between
 * every gel row and its corroborating PA twin, keyed on (gift_id, anchor):
 *
 *   gel.evidence_kind = 'qb_staged'     ↔  PA.evidence_source = 'quickbooks'
 *                                          AND PA.payment_id       = gel.evidence_id
 *   gel.evidence_kind = 'stripe_charge' ↔  PA.evidence_source = 'stripe'
 *                                          AND PA.stripe_charge_id = gel.evidence_id
 *
 * BLOCKING checks (gate FAILs on any):
 *   - gel_no_ledger : a gel row with no matching corroborating PA row (the
 *     dual-write missed it — reads would lose the corroboration after the flip).
 *   - ledger_no_gel : a corroborating PA row with no matching gel row (a stale
 *     row a merge/delete failed to re-home, or a corroborating row written with
 *     an anchor kind gel can't represent, e.g. donorbox — which no writer emits).
 * Both must be zero: the dual-write inserts them together (reusing the gel id)
 * and gift-combine re-homes/deletes them in lockstep by anchor.
 *
 * Exit 0 only when both orphan sets are empty.
 *
 * Run: pnpm --filter @workspace/api-server run parity:gift-evidence-links
 *      (optional `--out <path>` writes the full machine-readable report)
 */
import { writeFileSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

interface GelOrphan {
  gelId: string;
  giftId: string;
  evidenceKind: string;
  evidenceId: string;
}

interface LedgerOrphan {
  paId: string;
  giftId: string;
  evidenceSource: string;
  paymentId: string | null;
  stripeChargeId: string | null;
}

async function main(): Promise<void> {
  const outArgIdx = process.argv.indexOf("--out");
  const outPath = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : undefined;

  const totals = (
    await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM gift_evidence_links) AS gel_total,
        (SELECT COUNT(*) FROM payment_applications
           WHERE link_role = 'corroborating') AS corr_total
    `)
  ).rows[0] as unknown as { gel_total: string; corr_total: string };

  // gel row with no matching corroborating PA twin (gift_id + anchor).
  const gelOrphans = (
    await db.execute(sql`
      SELECT gel.id AS gel_id, gel.gift_id, gel.evidence_kind, gel.evidence_id
      FROM gift_evidence_links gel
      WHERE NOT EXISTS (
        SELECT 1 FROM payment_applications pa
        WHERE pa.link_role = 'corroborating'
          AND pa.gift_id = gel.gift_id
          AND (
            (gel.evidence_kind = 'qb_staged'
               AND pa.evidence_source = 'quickbooks'
               AND pa.payment_id = gel.evidence_id)
            OR
            (gel.evidence_kind = 'stripe_charge'
               AND pa.evidence_source = 'stripe'
               AND pa.stripe_charge_id = gel.evidence_id)
          )
      )
    `)
  ).rows as unknown as {
    gel_id: string;
    gift_id: string;
    evidence_kind: string;
    evidence_id: string;
  }[];

  // corroborating PA row with no matching gel row (stale, or an anchor kind gel
  // can't represent).
  const ledgerOrphans = (
    await db.execute(sql`
      SELECT pa.id AS pa_id, pa.gift_id, pa.evidence_source,
             pa.payment_id, pa.stripe_charge_id
      FROM payment_applications pa
      WHERE pa.link_role = 'corroborating'
        AND NOT EXISTS (
          SELECT 1 FROM gift_evidence_links gel
          WHERE gel.gift_id = pa.gift_id
            AND (
              (pa.evidence_source = 'quickbooks'
                 AND gel.evidence_kind = 'qb_staged'
                 AND gel.evidence_id = pa.payment_id)
              OR
              (pa.evidence_source = 'stripe'
                 AND gel.evidence_kind = 'stripe_charge'
                 AND gel.evidence_id = pa.stripe_charge_id)
            )
        )
    `)
  ).rows as unknown as {
    pa_id: string;
    gift_id: string;
    evidence_source: string;
    payment_id: string | null;
    stripe_charge_id: string | null;
  }[];

  const gel: GelOrphan[] = gelOrphans.map((r) => ({
    gelId: r.gel_id,
    giftId: r.gift_id,
    evidenceKind: r.evidence_kind,
    evidenceId: r.evidence_id,
  }));
  const ledger: LedgerOrphan[] = ledgerOrphans.map((r) => ({
    paId: r.pa_id,
    giftId: r.gift_id,
    evidenceSource: r.evidence_source,
    paymentId: r.payment_id,
    stripeChargeId: r.stripe_charge_id,
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    totals: {
      gelRows: Number(totals.gel_total),
      corroboratingLedgerRows: Number(totals.corr_total),
    },
    counts: {
      gelNoLedger: gel.length,
      ledgerNoGel: ledger.length,
    },
    gelNoLedger: gel,
    ledgerNoGel: ledger,
  };

  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("=== gift_evidence_links parity report ===");
  console.log(`gel rows:                  ${report.totals.gelRows}`);
  console.log(
    `corroborating ledger rows: ${report.totals.corroboratingLedgerRows}`,
  );
  console.log(
    `\ngel with no ledger twin (BLOCKING): ${gel.length}` +
      (gel.length
        ? "\n" +
          gel
            .slice(0, 25)
            .map(
              (o) =>
                `    gel=${o.gelId}  gift=${o.giftId}  ${o.evidenceKind}:${o.evidenceId}`,
            )
            .join("\n")
        : ""),
  );
  console.log(
    `\ncorroborating ledger with no gel twin (BLOCKING): ${ledger.length}` +
      (ledger.length
        ? "\n" +
          ledger
            .slice(0, 25)
            .map(
              (o) =>
                `    pa=${o.paId}  gift=${o.giftId}  ${o.evidenceSource}:${o.paymentId ?? o.stripeChargeId ?? "—"}`,
            )
            .join("\n")
        : ""),
  );
  if (outPath) console.log(`\nFull report written to ${outPath}`);

  const failed = gel.length > 0 || ledger.length > 0;
  console.log(`\nGATE: ${failed ? "FAIL" : "PASS"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Parity check failed:", err);
  process.exit(2);
});
