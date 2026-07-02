/**
 * T003 PARITY GATE — payment_applications ledger vs. legacy QuickBooks signals.
 *
 * This is the gate that MUST pass (zero unaccepted exceptions) before any read
 * surface is flipped from the scattered legacy linkage signals
 * (`staged_payments.{matched,created,group_reconciled}_gift_id`,
 * `staged_payment_splits`, `gifts_and_payments.final_amount_qb_staged_payment_id`)
 * to the authoritative `payment_applications` ledger.
 *
 * For EVERY gift it derives the QuickBooks-tie two ways and compares them:
 *   - LEGACY : the INTENDED / correctly-correlated legacy evidence (direct
 *              LIMIT 1, group SUM, split LIMIT 1; precedence split > group >
 *              direct), written here as raw, properly table-qualified SQL. This
 *              is what `applyGiftQbTieMany` was MEANT to compute — NOT the buggy
 *              bare-column correlation it shipped with (which under-counted ties;
 *              that shipped bug is exactly the persisted-drift set below).
 *   - LEDGER : SUM(amount_applied) over payment_applications rows for the gift
 *              with evidence_source = 'quickbooks' (hasQbLink = SUM > 0).
 * Both are fed through the SAME pure `deriveGiftQbTie`, so any status divergence
 * comes solely from the QB-evidence amount/link source — exactly what the flip
 * changes. Off-books / Stripe / unknown-amount branches are preserved by reusing
 * the real deriver, so the gate also proves those branches don't regress.
 *
 * BLOCKING checks (gate FAILs on any): intended-legacy vs ledger status mismatch,
 * link-presence mismatch, and `final_amount_qb_staged_payment_id` coverage —
 * every gift carrying that pointer MUST have a ledger QB row, else flipping the
 * `gifts-missing-qb` reader (which dropped the pointer for the ledger) would
 * silently lose its QB link.
 *
 * NON-BLOCKING (reported, enumerated in --out, does NOT fail the gate): the
 * persisted `quickbooks_tie_status` column vs the intended-legacy derivation.
 * This drift is the ACCEPTED bug-fix correction set — the gifts whose persisted
 * status was wrong under the shipped bare-column bug, repaired by the
 * backfill:gift-qb-tie run that follows the deriver flip. Its count + ids land
 * in the report so the cutover has an auditable before/after list.
 *
 * STRIPE / DONORBOX ANCHOR PARITY (also BLOCKING): the Stripe and Donorbox
 * readers are NOT flipped in this phase, so instead of re-deriving a status the
 * gate proves the ledger rows are a faithful mirror of the legacy per-processor
 * gift pointers — the invariant the future Stripe/Donorbox read-flip depends on.
 * Per ANCHOR (a stripe_staged_charge / donorbox_donation), both directions must
 * hold:
 *   - legacy_no_ledger : a settled charge/donation (matched_gift_id OR
 *     created_gift_id, amount > 0, gift exists) with NO matching ledger row.
 *   - ledger_no_legacy : a ledger row whose anchor no longer points at that gift
 *     (a stale row a revert/merge failed to clear).
 * Both must be zero (a revert clears the pointer AND the ledger row together, so
 * they stay in lockstep).
 *
 * Exit 0 only when there are no status mismatches, no link-presence mismatches,
 * no uncovered final-amount pointers, and no Stripe/Donorbox anchor orphans.
 *
 * Run: pnpm --filter @workspace/api-server run parity:payment-applications
 *      (optional `--out <path>` writes the full machine-readable report)
 */
import { writeFileSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { deriveGiftQbTie, type GiftQbTie } from "../lib/giftQbTie";

interface RawRow {
  id: string;
  gift_amount: string | null;
  off_books: boolean;
  final_amount_source: string | null;
  persisted_status: GiftQbTie | null;
  direct_amount: string | null;
  has_direct: boolean;
  group_amount: string | null;
  has_group: boolean;
  split_amount: string | null;
  has_split: boolean;
  ledger_qb_sum: string | null;
  has_ledger_qb: boolean;
  has_faq: boolean;
}

interface Mismatch {
  id: string;
  reason: string;
  giftAmount: string | null;
  finalAmountSource: string | null;
  persistedStatus: GiftQbTie | null;
  legacy: { hasQbLink: boolean; qbAmount: string | null; status: GiftQbTie };
  ledger: { hasQbLink: boolean; qbAmount: string | null; status: GiftQbTie };
}

interface AnchorOrphan {
  source: "stripe" | "donorbox";
  direction: "legacy_no_ledger" | "ledger_no_legacy";
  anchorId: string | null;
  giftId: string | null;
}

function legacyQbAmount(r: RawRow): string | null {
  // split > group > direct (matches the applier's precedence exactly).
  if (r.has_split) return r.split_amount;
  if (r.has_group) return r.group_amount;
  if (r.has_direct) return r.direct_amount;
  return null;
}

/**
 * Bidirectional per-anchor parity for the two non-QB evidence sources whose
 * legacy signal is a single settled gift pointer on the processor row itself
 * (`matched_gift_id` OR `created_gift_id`), NOT a scattered set — so this is an
 * anchor↔ledger set-equality check, not a re-derivation. Donorbox is limited to
 * its human link/mint pointers (the sync's enrich / suggested-donor paths never
 * set a gift link), exactly what the dual-write books.
 */
async function collectAnchorParity(): Promise<AnchorOrphan[]> {
  const orphans: AnchorOrphan[] = [];

  // STRIPE — settled charge (amount > 0, gift exists) with NO ledger row.
  for (const row of (
    await db.execute(sql`
      SELECT sc.id AS anchor_id,
             COALESCE(sc.matched_gift_id, sc.created_gift_id) AS gift_id
      FROM stripe_staged_charges sc
      JOIN gifts_and_payments g
        ON g.id = COALESCE(sc.matched_gift_id, sc.created_gift_id)
      WHERE (sc.matched_gift_id IS NOT NULL OR sc.created_gift_id IS NOT NULL)
        AND sc.gross_amount IS NOT NULL AND sc.gross_amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM payment_applications pa
          WHERE pa.stripe_charge_id = sc.id
            AND pa.link_role = 'counted'
            AND pa.gift_id = COALESCE(sc.matched_gift_id, sc.created_gift_id))
    `)
  ).rows as unknown as { anchor_id: string; gift_id: string }[]) {
    orphans.push({
      source: "stripe",
      direction: "legacy_no_ledger",
      anchorId: row.anchor_id,
      giftId: row.gift_id,
    });
  }

  // STRIPE — ledger row whose charge no longer points at that gift (stale).
  for (const row of (
    await db.execute(sql`
      SELECT pa.stripe_charge_id AS anchor_id, pa.gift_id
      FROM payment_applications pa
      WHERE pa.evidence_source = 'stripe'
        AND pa.link_role = 'counted'
        AND NOT EXISTS (
          SELECT 1 FROM stripe_staged_charges sc
          WHERE sc.id = pa.stripe_charge_id
            AND COALESCE(sc.matched_gift_id, sc.created_gift_id) = pa.gift_id)
    `)
  ).rows as unknown as { anchor_id: string | null; gift_id: string }[]) {
    orphans.push({
      source: "stripe",
      direction: "ledger_no_legacy",
      anchorId: row.anchor_id,
      giftId: row.gift_id,
    });
  }

  // DONORBOX — settled donation (human link/mint pointer, amount > 0) w/o ledger.
  for (const row of (
    await db.execute(sql`
      SELECT dd.id AS anchor_id,
             COALESCE(dd.matched_gift_id, dd.created_gift_id) AS gift_id
      FROM donorbox_donations dd
      JOIN gifts_and_payments g
        ON g.id = COALESCE(dd.matched_gift_id, dd.created_gift_id)
      WHERE (dd.matched_gift_id IS NOT NULL OR dd.created_gift_id IS NOT NULL)
        AND dd.amount IS NOT NULL AND dd.amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM payment_applications pa
          WHERE pa.donorbox_donation_id = dd.id
            AND pa.link_role = 'counted'
            AND pa.gift_id = COALESCE(dd.matched_gift_id, dd.created_gift_id))
    `)
  ).rows as unknown as { anchor_id: string; gift_id: string }[]) {
    orphans.push({
      source: "donorbox",
      direction: "legacy_no_ledger",
      anchorId: row.anchor_id,
      giftId: row.gift_id,
    });
  }

  // DONORBOX — ledger row whose donation no longer points at that gift (stale).
  for (const row of (
    await db.execute(sql`
      SELECT pa.donorbox_donation_id AS anchor_id, pa.gift_id
      FROM payment_applications pa
      WHERE pa.evidence_source = 'donorbox'
        AND pa.link_role = 'counted'
        AND NOT EXISTS (
          SELECT 1 FROM donorbox_donations dd
          WHERE dd.id = pa.donorbox_donation_id
            AND COALESCE(dd.matched_gift_id, dd.created_gift_id) = pa.gift_id)
    `)
  ).rows as unknown as { anchor_id: string | null; gift_id: string }[]) {
    orphans.push({
      source: "donorbox",
      direction: "ledger_no_legacy",
      anchorId: row.anchor_id,
      giftId: row.gift_id,
    });
  }

  return orphans;
}

async function main(): Promise<void> {
  const outArgIdx = process.argv.indexOf("--out");
  const outPath = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : undefined;

  const rows = (
    await db.execute(sql`
      SELECT
        g.id,
        g.amount::text AS gift_amount,
        (g.off_books_fiscal_sponsor OR g.designated_to_school OR NOT g.payment_expected) AS off_books,
        g.final_amount_source,
        g.quickbooks_tie_status::text AS persisted_status,
        (SELECT sp.amount::text FROM staged_payments sp
           WHERE sp.matched_gift_id = g.id OR sp.created_gift_id = g.id LIMIT 1) AS direct_amount,
        EXISTS (SELECT 1 FROM staged_payments sp
           WHERE sp.matched_gift_id = g.id OR sp.created_gift_id = g.id) AS has_direct,
        (SELECT SUM(sp.amount)::text FROM staged_payments sp
           WHERE sp.group_reconciled_gift_id = g.id) AS group_amount,
        EXISTS (SELECT 1 FROM staged_payments sp
           WHERE sp.group_reconciled_gift_id = g.id) AS has_group,
        (SELECT spl.sub_amount::text FROM staged_payment_splits spl
           WHERE spl.gift_id = g.id LIMIT 1) AS split_amount,
        EXISTS (SELECT 1 FROM staged_payment_splits spl
           WHERE spl.gift_id = g.id) AS has_split,
        (SELECT SUM(pa.amount_applied)::text FROM payment_applications pa
           WHERE pa.gift_id = g.id AND pa.evidence_source = 'quickbooks'
             AND pa.link_role = 'counted') AS ledger_qb_sum,
        EXISTS (SELECT 1 FROM payment_applications pa
           WHERE pa.gift_id = g.id AND pa.evidence_source = 'quickbooks'
             AND pa.link_role = 'counted') AS has_ledger_qb,
        (g.final_amount_qb_staged_payment_id IS NOT NULL) AS has_faq
      FROM gifts_and_payments g
    `)
  ).rows as unknown as RawRow[];

  const statusMismatches: Mismatch[] = [];
  const linkMismatches: Mismatch[] = [];
  const persistedDrift: Mismatch[] = [];
  const faqUncovered: Mismatch[] = [];

  let legacyLinked = 0;
  let ledgerLinked = 0;
  let legacyMissing = 0;
  let ledgerMissing = 0;

  for (const r of rows) {
    const legacyHasQbLink = r.has_direct || r.has_group || r.has_split;
    const legacyAmt = legacyQbAmount(r);
    const legacyStatus = deriveGiftQbTie({
      offBooks: r.off_books,
      giftAmount: r.gift_amount,
      hasQbLink: legacyHasQbLink,
      qbAmount: legacyAmt,
      finalAmountSource: r.final_amount_source,
    });

    const ledgerHasQbLink = r.has_ledger_qb;
    const ledgerAmt = r.has_ledger_qb ? r.ledger_qb_sum : null;
    const ledgerStatus = deriveGiftQbTie({
      offBooks: r.off_books,
      giftAmount: r.gift_amount,
      hasQbLink: ledgerHasQbLink,
      qbAmount: ledgerAmt,
      finalAmountSource: r.final_amount_source,
    });

    if (legacyHasQbLink) legacyLinked++;
    if (ledgerHasQbLink) ledgerLinked++;
    if (legacyStatus === "missing") legacyMissing++;
    if (ledgerStatus === "missing") ledgerMissing++;

    const mk = (reason: string): Mismatch => ({
      id: r.id,
      reason,
      giftAmount: r.gift_amount,
      finalAmountSource: r.final_amount_source,
      persistedStatus: r.persisted_status,
      legacy: { hasQbLink: legacyHasQbLink, qbAmount: legacyAmt, status: legacyStatus },
      ledger: { hasQbLink: ledgerHasQbLink, qbAmount: ledgerAmt, status: ledgerStatus },
    });

    if (legacyHasQbLink !== ledgerHasQbLink) {
      linkMismatches.push(
        mk(legacyHasQbLink ? "legacy_link_no_ledger" : "ledger_link_no_legacy"),
      );
    }
    if (legacyStatus !== ledgerStatus) {
      const reason =
        legacyHasQbLink !== ledgerHasQbLink
          ? "status_diff_via_link"
          : "status_diff_via_amount";
      statusMismatches.push(mk(reason));
    }
    if (r.persisted_status !== legacyStatus) {
      persistedDrift.push(mk("persisted_vs_legacy_drift"));
    }
    // BLOCKING: a gift carrying the legacy final-amount QB pointer MUST have a
    // ledger QB row, else the ledger reader (which dropped the pointer) loses it.
    if (r.has_faq && !r.has_ledger_qb) {
      faqUncovered.push(mk("faq_pointer_no_ledger"));
    }
  }

  const anchorOrphans = await collectAnchorParity();

  const report = {
    generatedAt: new Date().toISOString(),
    totalGifts: rows.length,
    counts: {
      legacyLinked,
      ledgerLinked,
      legacyMissing,
      ledgerMissing,
      statusMismatches: statusMismatches.length,
      linkMismatches: linkMismatches.length,
      persistedDrift: persistedDrift.length,
      faqUncovered: faqUncovered.length,
      anchorOrphans: anchorOrphans.length,
    },
    statusMismatches,
    linkMismatches,
    persistedDrift,
    faqUncovered,
    anchorOrphans,
  };

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
  }

  const sample = (arr: Mismatch[]): string =>
    arr
      .slice(0, 25)
      .map(
        (m) =>
          `    ${m.id}  [${m.reason}]  legacy=${m.legacy.status}(${m.legacy.hasQbLink ? m.legacy.qbAmount : "—"})  ledger=${m.ledger.status}(${m.ledger.hasQbLink ? m.ledger.qbAmount : "—"})  gift=${m.giftAmount}  src=${m.finalAmountSource}`,
      )
      .join("\n");

  console.log("=== payment_applications parity report ===");
  console.log(`Total gifts:        ${rows.length}`);
  console.log(`Legacy QB-linked:   ${legacyLinked}    Ledger QB-linked:   ${ledgerLinked}`);
  console.log(`Legacy missing-QB:  ${legacyMissing}    Ledger missing-QB:  ${ledgerMissing}`);
  console.log(
    `\nLink-presence mismatches: ${linkMismatches.length}` +
      (linkMismatches.length ? `\n${sample(linkMismatches)}` : ""),
  );
  console.log(
    `\nStatus mismatches:        ${statusMismatches.length}` +
      (statusMismatches.length ? `\n${sample(statusMismatches)}` : ""),
  );
  console.log(
    `\nFinal-amount pointer NOT covered by ledger (BLOCKING): ${faqUncovered.length}` +
      (faqUncovered.length ? `\n${sample(faqUncovered)}` : ""),
  );
  console.log(
    `\nPersisted-vs-legacy drift (informational, repaired by backfill:gift-qb-tie): ${persistedDrift.length}`,
  );
  const anchorSample = anchorOrphans
    .slice(0, 25)
    .map(
      (o) =>
        `    ${o.source}/${o.direction}  anchor=${o.anchorId ?? "—"}  gift=${o.giftId ?? "—"}`,
    )
    .join("\n");
  console.log(
    `\nStripe/Donorbox anchor orphans (BLOCKING): ${anchorOrphans.length}` +
      (anchorOrphans.length ? `\n${anchorSample}` : ""),
  );
  if (outPath) console.log(`\nFull report written to ${outPath}`);

  const failed =
    statusMismatches.length > 0 ||
    linkMismatches.length > 0 ||
    faqUncovered.length > 0 ||
    anchorOrphans.length > 0;
  console.log(`\nGATE: ${failed ? "FAIL" : "PASS"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Parity check failed:", err);
  process.exit(2);
});
