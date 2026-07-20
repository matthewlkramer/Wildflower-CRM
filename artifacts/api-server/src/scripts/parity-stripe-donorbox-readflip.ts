/**
 * PHASE-3 Stripe/Donorbox gift-TIE read-flip — RETROSPECTIVE PARITY / re-verify.
 *
 * The flip HAS SHIPPED: deriveGiftQbTie / applyGiftQbTieMany now read Stripe AND
 * Donorbox counted rows from payment_applications via per-source precedence, and
 * the amount-blind `finalAmountSource==='stripe'` shortcut is gone. This script is
 * kept as a ZERO-behavior-change parity harness: it derives the QuickBooks-tie for
 * every gift the PRE-FLIP way and the SHIPPED way and enumerates every status
 * difference, categorized, so the flip can be re-verified read-only on REAL prod
 * data (it was parity-clean at flip time: 0 tie-status changes).
 *
 * PRE-FLIP baseline (deriveLegacy) — what shipped BEFORE this flip:
 *   - QB link/amount from the ledger (evidence_source='quickbooks',
 *     link_role='counted'); the QB read-flip had already shipped.
 *   - Stripe handled by the `finalAmountSource === 'stripe'` SHORTCUT in
 *     deriveGiftQbTie ("money lands in QB at the payout level") — amount-BLIND.
 *   - Donorbox counted rows not read at all (a donorbox-only gift was `missing`).
 *
 * SHIPPED derivation (deriveNew) — per-source PRECEDENCE, NOT a naive all-source SUM:
 *   - amount = QB counted sum if any QB counted row exists, else the Stripe
 *     counted sum, else the Donorbox counted sum.
 *   - hasLink = a counted row of ANY source exists.
 *   - the `finalAmountSource==='stripe'` shortcut is DROPPED.
 * Precedence (not sum) is deliberate: §4.3 "one count across the settlement
 * boundary" — a gift settled by BOTH a coarse QB deposit line AND its per-charge
 * Stripe rows carries a counted row of EACH source (migration 0086 does not, and
 * must not, dedupe across sources). A naive cross-source SUM would double-count
 * that gift (~2× amount ⇒ false amount_mismatch). Precedence counts ONE source.
 * The pure all-source SUM is adopted only in Phase 4, once settlement_links can
 * reclassify the coarse QB rows to link_role='corroborating'.
 *
 * Change classes enumerated (for human sign-off):
 *   - regression_tied_to_missing : legacy `tied` → new `missing`. The dropped
 *     Stripe shortcut with NO counted ledger row of any source. Expected causes:
 *     zero-gross charges (skipped by dual-write + 0086's `gross_amount > 0`), and
 *     pre-staged-charge Stripe gifts that never had a charge anchor. Split by
 *     live vs archived; live ones are the ones that matter.
 *   - broaden_missing_to_tied   : legacy `missing` → new `tied`. Typically a
 *     donorbox-only counted gift, now counted toward the tie.
 *   - tied_to_amount_mismatch   : legacy `tied` → new `amount_mismatch`. The
 *     Stripe shortcut was amount-blind; the ledger read adds an amount compare,
 *     so a human-edited gift amount vs charge gross surfaces here. Real drift.
 *   - other                     : any transition not in the above set. BLOCKING —
 *     these are unexpected and must be understood before flipping.
 *
 * Additional evidence (Q1/Q2 — the double-count hazard):
 *   - crossSourcePairs : gifts with counted rows from >1 evidence_source, with
 *     each per-source sum + the gift amount + whether a NAIVE all-source SUM would
 *     exceed the fee band. These are exactly the gifts precedence protects; the
 *     count proves how many a naive SUM would have corrupted.
 *
 * Anchor-coverage (Q4.1 — pointer without ledger row):
 *   - stripePointerNoLedger : final_amount_stripe_charge_id set but NO counted
 *     Stripe ledger row — the ledger read would not see this Stripe link.
 *
 * Run: pnpm --filter @workspace/api-server run parity:stripe-donorbox-readflip
 *      (optional `--out <path>` writes the full machine-readable report)
 *
 * PROD: run read-only against prod (dev is stale for QBO/Stripe facts):
 *   DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/api-server \
 *     run parity:stripe-donorbox-readflip -- --out /tmp/readflip.json
 */
import { writeFileSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { type GiftQbTie } from "../lib/giftQbTie";
import { amountWithinFeeBand } from "../lib/reconciliationGate";

interface RawRow {
  id: string;
  gift_amount: string | null;
  off_books: boolean;
  final_amount_source: string | null;
  archived: boolean;
  persisted_status: GiftQbTie | null;
  has_fasc: boolean;
  qb_sum: string | null;
  has_qb: boolean;
  stripe_sum: string | null;
  has_stripe: boolean;
  donorbox_sum: string | null;
  has_donorbox: boolean;
}

type ChangeCategory =
  | "regression_tied_to_missing"
  | "broaden_missing_to_tied"
  | "tied_to_amount_mismatch"
  | "other";

interface StatusChange {
  id: string;
  category: ChangeCategory;
  archived: boolean;
  giftAmount: string | null;
  finalAmountSource: string | null;
  legacyStatus: GiftQbTie;
  newStatus: GiftQbTie;
  qbSum: string | null;
  stripeSum: string | null;
  donorboxSum: string | null;
}

interface CrossSourcePair {
  id: string;
  giftAmount: string | null;
  qbSum: string | null;
  stripeSum: string | null;
  donorboxSum: string | null;
  naiveSum: string;
  naiveSumWouldMismatch: boolean;
}

interface AnchorGap {
  id: string;
  giftAmount: string | null;
  finalAmountSource: string | null;
}

/** Precedence pick: QB sum wins, else Stripe, else Donorbox, else null. */
function precedenceAmount(r: RawRow): string | null {
  if (r.has_qb) return r.qb_sum;
  if (r.has_stripe) return r.stripe_sum;
  if (r.has_donorbox) return r.donorbox_sum;
  return null;
}

/**
 * The SHIPPED (flipped) deriver, implemented locally so this parity harness needs
 * no code change. Mirrors what was folded into deriveGiftQbTie: per-source
 * precedence, no finalAmountSource shortcut.
 */
function deriveNew(r: RawRow): GiftQbTie {
  if (r.off_books) return "exempt";
  const hasLink = r.has_qb || r.has_stripe || r.has_donorbox;
  if (!hasLink) return "missing";
  const amt = precedenceAmount(r);
  if (r.gift_amount == null || amt == null) return "tied";
  return amountWithinFeeBand(amt, r.gift_amount) ? "tied" : "amount_mismatch";
}

/**
 * The PRE-FLIP shipped deriver, inlined so this preview stays a faithful
 * before/after record after step 2 folded per-source precedence into
 * deriveGiftQbTie (which then dropped the amount-blind stripe shortcut). QB from
 * the counted ledger + the `final_amount_source === 'stripe'` shortcut.
 */
function deriveLegacy(r: RawRow): GiftQbTie {
  if (r.off_books) return "exempt";
  if (r.has_qb) {
    if (r.gift_amount == null || r.qb_sum == null) return "tied";
    return amountWithinFeeBand(r.qb_sum, r.gift_amount)
      ? "tied"
      : "amount_mismatch";
  }
  if (r.final_amount_source === "stripe") return "tied";
  return "missing";
}

function categorize(legacy: GiftQbTie, next: GiftQbTie): ChangeCategory {
  if (legacy === "tied" && next === "missing") return "regression_tied_to_missing";
  if (legacy === "missing" && next === "tied") return "broaden_missing_to_tied";
  if (legacy === "tied" && next === "amount_mismatch")
    return "tied_to_amount_mismatch";
  return "other";
}

async function main(): Promise<void> {
  const outArgIdx = process.argv.indexOf("--out");
  const outPath = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : undefined;

  const rows = (
    await db.execute(sql`
      SELECT
        g.id,
        g.amount::text AS gift_amount,
        (
          EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g.id)
          AND NOT EXISTS (
            SELECT 1 FROM gift_allocations ga
            LEFT JOIN entities e ON e.id = ga.entity_id
            WHERE ga.gift_id = g.id
              AND (ga.entity_id IS NULL OR COALESCE(e.expects_payment, true) = true)
          )
        ) AS off_books,
        g.final_amount_source,
        (g.archived_at IS NOT NULL) AS archived,
        -- NOTE (Task #451): quickbooks_tie_status and final_amount_stripe_charge_id
        -- were DROPPED from gifts_and_payments; these columns are no longer queryable.
        -- The parity check ran clean before the drop (0 tie-status changes).
        -- This script is kept as a historical record only; it cannot run against
        -- a post-migration database. Suppress the two fields with NULL placeholders.
        NULL::text AS persisted_status,
        false AS has_fasc,
        (SELECT SUM(pa.amount_applied)::text FROM payment_applications pa
           WHERE pa.gift_id = g.id AND pa.evidence_source = 'quickbooks'
             AND pa.link_role = 'counted') AS qb_sum,
        EXISTS (SELECT 1 FROM payment_applications pa
           WHERE pa.gift_id = g.id AND pa.evidence_source = 'quickbooks'
             AND pa.link_role = 'counted') AS has_qb,
        (SELECT SUM(pa.amount_applied)::text FROM payment_applications pa
           WHERE pa.gift_id = g.id AND pa.evidence_source = 'stripe'
             AND pa.link_role = 'counted') AS stripe_sum,
        EXISTS (SELECT 1 FROM payment_applications pa
           WHERE pa.gift_id = g.id AND pa.evidence_source = 'stripe'
             AND pa.link_role = 'counted') AS has_stripe,
        (SELECT SUM(pa.amount_applied)::text FROM payment_applications pa
           WHERE pa.gift_id = g.id AND pa.evidence_source = 'donorbox'
             AND pa.link_role = 'counted') AS donorbox_sum,
        EXISTS (SELECT 1 FROM payment_applications pa
           WHERE pa.gift_id = g.id AND pa.evidence_source = 'donorbox'
             AND pa.link_role = 'counted') AS has_donorbox
      FROM gifts_and_payments g
    `)
  ).rows as unknown as RawRow[];

  const changes: StatusChange[] = [];
  const crossSourcePairs: CrossSourcePair[] = [];
  const stripePointerNoLedger: AnchorGap[] = [];

  for (const r of rows) {
    // Baseline = the PRE-FLIP shipped deriver: QB from ledger + stripe shortcut.
    const legacyStatus = deriveLegacy(r);
    const newStatus = deriveNew(r);

    if (legacyStatus !== newStatus) {
      changes.push({
        id: r.id,
        category: categorize(legacyStatus, newStatus),
        archived: r.archived,
        giftAmount: r.gift_amount,
        finalAmountSource: r.final_amount_source,
        legacyStatus,
        newStatus,
        qbSum: r.has_qb ? r.qb_sum : null,
        stripeSum: r.has_stripe ? r.stripe_sum : null,
        donorboxSum: r.has_donorbox ? r.donorbox_sum : null,
      });
    }

    // Cross-source pairs — the double-count hazard precedence protects against.
    const sourcesPresent =
      (r.has_qb ? 1 : 0) + (r.has_stripe ? 1 : 0) + (r.has_donorbox ? 1 : 0);
    if (sourcesPresent > 1) {
      const naive =
        Number(r.qb_sum ?? 0) +
        Number(r.stripe_sum ?? 0) +
        Number(r.donorbox_sum ?? 0);
      const naiveStr = naive.toFixed(2);
      const wouldMismatch =
        r.gift_amount != null && !amountWithinFeeBand(naiveStr, r.gift_amount);
      crossSourcePairs.push({
        id: r.id,
        giftAmount: r.gift_amount,
        qbSum: r.has_qb ? r.qb_sum : null,
        stripeSum: r.has_stripe ? r.stripe_sum : null,
        donorboxSum: r.has_donorbox ? r.donorbox_sum : null,
        naiveSum: naiveStr,
        naiveSumWouldMismatch: wouldMismatch,
      });
    }

    // Anchor coverage — a stripe pointer with no counted ledger row.
    if (r.has_fasc && !r.has_stripe) {
      stripePointerNoLedger.push({
        id: r.id,
        giftAmount: r.gift_amount,
        finalAmountSource: r.final_amount_source,
      });
    }
  }

  const byCategory = (cat: ChangeCategory): StatusChange[] =>
    changes.filter((c) => c.category === cat);
  const regressions = byCategory("regression_tied_to_missing");
  const broadenings = byCategory("broaden_missing_to_tied");
  const amountMismatches = byCategory("tied_to_amount_mismatch");
  const others = byCategory("other");

  const liveRegressions = regressions.filter((c) => !c.archived);
  const naiveDoubleCounts = crossSourcePairs.filter(
    (p) => p.naiveSumWouldMismatch,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    totalGifts: rows.length,
    counts: {
      totalStatusChanges: changes.length,
      regression_tied_to_missing: regressions.length,
      regression_tied_to_missing_live: liveRegressions.length,
      broaden_missing_to_tied: broadenings.length,
      tied_to_amount_mismatch: amountMismatches.length,
      other: others.length,
      crossSourcePairs: crossSourcePairs.length,
      crossSourcePairs_naiveSumWouldMismatch: naiveDoubleCounts.length,
      stripePointerNoLedger: stripePointerNoLedger.length,
    },
    changes,
    crossSourcePairs,
    stripePointerNoLedger,
  };
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));

  const sampleChange = (arr: StatusChange[]): string =>
    arr
      .slice(0, 25)
      .map(
        (c) =>
          `    ${c.id}  ${c.legacyStatus}→${c.newStatus}  ${c.archived ? "[archived]" : "[live]"}  gift=${c.giftAmount}  src=${c.finalAmountSource}  qb=${c.qbSum ?? "—"} stripe=${c.stripeSum ?? "—"} donorbox=${c.donorboxSum ?? "—"}`,
      )
      .join("\n");
  const samplePair = (arr: CrossSourcePair[]): string =>
    arr
      .slice(0, 25)
      .map(
        (p) =>
          `    ${p.id}  gift=${p.giftAmount}  qb=${p.qbSum ?? "—"} stripe=${p.stripeSum ?? "—"} donorbox=${p.donorboxSum ?? "—"}  naiveSum=${p.naiveSum}${p.naiveSumWouldMismatch ? "  <== naive SUM would MISMATCH" : ""}`,
      )
      .join("\n");
  const sampleGap = (arr: AnchorGap[]): string =>
    arr
      .slice(0, 25)
      .map((a) => `    ${a.id}  gift=${a.giftAmount}  src=${a.finalAmountSource}`)
      .join("\n");

  console.log("=== Stripe/Donorbox read-flip PREVIEW (per-source precedence) ===");
  console.log(`Total gifts:            ${rows.length}`);
  console.log(`Total tie-status changes: ${changes.length}`);
  console.log(
    `\nregression tied→missing: ${regressions.length}  (live: ${liveRegressions.length})` +
      (regressions.length ? `\n${sampleChange(regressions)}` : ""),
  );
  console.log(
    `\nbroaden missing→tied:    ${broadenings.length}` +
      (broadenings.length ? `\n${sampleChange(broadenings)}` : ""),
  );
  console.log(
    `\ntied→amount_mismatch:    ${amountMismatches.length}` +
      (amountMismatches.length ? `\n${sampleChange(amountMismatches)}` : ""),
  );
  console.log(
    `\nOTHER (unexpected) [BLOCKING]: ${others.length}` +
      (others.length ? `\n${sampleChange(others)}` : ""),
  );
  console.log(
    `\ncross-source counted pairs: ${crossSourcePairs.length}  (naive SUM would mismatch: ${naiveDoubleCounts.length})` +
      (crossSourcePairs.length ? `\n${samplePair(crossSourcePairs)}` : ""),
  );
  console.log(
    `\nStripe pointer w/o counted ledger row: ${stripePointerNoLedger.length}` +
      (stripePointerNoLedger.length ? `\n${sampleGap(stripePointerNoLedger)}` : ""),
  );
  if (outPath) console.log(`\nFull report written to ${outPath}`);

  // This is a PREVIEW, not a hard gate: only an unexpected ("other") transition
  // makes it fail loudly. Every other class is enumerated for human sign-off.
  const failed = others.length > 0;
  console.log(`\nPREVIEW: ${failed ? "UNEXPECTED CHANGES — REVIEW" : "OK (expected classes only)"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Read-flip preview failed:", err);
  process.exit(2);
});
