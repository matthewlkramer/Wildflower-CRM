/**
 * One-shot backfill: seed `funding_source` on every AUTO staged-payment row
 * (provenance != 'manual') by running the same pure `detectFundingSource` helper
 * the ingest/reclassify paths use. Human-pinned ('manual') rows are skipped —
 * their origin is review state and must never be overwritten.
 *
 * Richer than first ingest: it also resolves the matched intermediary's type and
 * whether the row's gift is backed by Stripe charges, so DAF / Stripe origins
 * that text alone can't name get filled in.
 *
 * Idempotent — safe to re-run. Each write is guarded on provenance = 'auto' so a
 * row a human pins mid-run is never clobbered. Prints a progress dot every 500
 * rows plus a final summary.
 *
 * Run with: pnpm --filter @workspace/api-server run backfill:funding-source
 */
import { db } from "@workspace/db";
import { stagedPayments } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { detectFundingSource } from "../lib/quickbooksFundingSource";

const BATCH = 200;

interface Row {
  id: string;
  payerName: string | null;
  qbPaymentMethod: string | null;
  rawReference: string | null;
  lineDescription: string | null;
  qbTransactionMemo: string | null;
  qbDepositToAccountName: string | null;
  intermediaryType:
    | "daf"
    | "giving_platform"
    | "private_wealth_manager"
    | null;
  hasStripeEvidence: boolean;
}

async function main(): Promise<void> {
  // Gather every signal in one pass: the row's text + instrument, its matched
  // intermediary's type, and whether its gift is also evidenced by a Stripe
  // charge (or the row was reconciled away as a Stripe processor payout).
  const rows = (
    await db.execute(sql`
      SELECT
        sp.id,
        sp.payer_name              AS "payerName",
        sp.qb_payment_method       AS "qbPaymentMethod",
        sp.raw_reference           AS "rawReference",
        sp.line_description        AS "lineDescription",
        sp.qb_transaction_memo     AS "qbTransactionMemo",
        sp.qb_deposit_to_account_name AS "qbDepositToAccountName",
        pi.type                    AS "intermediaryType",
        (
          sp.exclusion_reason = 'processor_payout'
          -- A Stripe charge evidences a gift this payment is counted against
          -- in the QB cash-application ledger (the legacy staged gift-link
          -- columns are @deprecated and no longer written).
          OR EXISTS (
            SELECT 1 FROM payment_applications pa
            JOIN stripe_staged_charges sc
              ON sc.matched_gift_id = pa.gift_id
              OR sc.created_gift_id = pa.gift_id
            WHERE pa.payment_id = sp.id
              AND pa.evidence_source = 'quickbooks'
              AND pa.link_role = 'counted'
          )
        )                          AS "hasStripeEvidence"
      FROM staged_payments sp
      LEFT JOIN payment_intermediaries pi
        ON pi.id = sp.matched_payment_intermediary_id
      WHERE sp.funding_source_provenance <> 'manual'
    `)
  ).rows as unknown as Row[];

  console.log(`Backfilling funding source on ${rows.length} auto rows…`);

  let done = 0;
  let set = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    for (const r of batch) {
      const fundingSource = detectFundingSource({
        payerName: r.payerName,
        qbPaymentMethod: r.qbPaymentMethod,
        rawReference: r.rawReference,
        lineDescription: r.lineDescription,
        qbTransactionMemo: r.qbTransactionMemo,
        qbDepositToAccountName: r.qbDepositToAccountName,
        intermediaryType: r.intermediaryType,
        hasStripeEvidence: r.hasStripeEvidence,
      });
      const upd = await db
        .update(stagedPayments)
        .set({ fundingSource, updatedAt: new Date() })
        .where(
          and(
            eq(stagedPayments.id, r.id),
            eq(stagedPayments.fundingSourceProvenance, "auto"),
          ),
        )
        .returning({ id: stagedPayments.id });
      if (upd.length && fundingSource !== null) set += 1;
    }
    done += batch.length;
    if (done % 500 < BATCH) process.stdout.write(".");
  }
  console.log(
    `\nDone. Processed ${done} auto rows; set a funding source on ${set}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
