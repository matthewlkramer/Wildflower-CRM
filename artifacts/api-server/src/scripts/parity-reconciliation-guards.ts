/**
 * T003 PARITY GATE (reconciliation "linked-elsewhere" guards) — payment_applications
 * ledger vs. the legacy scattered linkage signals, for the operational guard reads
 * (NOT the gift-detail QB-tie surfaces — those have their own gate in
 * parity-payment-applications.ts).
 *
 * The four guard surfaces being flipped:
 *   #1 reconciliation/cards.ts  unlinkedDonorGiftWhere() — auto-proposal pool.
 *   #2 quickbooks/shared.ts     giftAlreadyLinkedElsewhere — display hint.
 *   #3 quickbooks/shared.ts     giftCandidateSelect.alreadyLinkedStagedPaymentId.
 *   #4 financialCorrections.ts  countedLinked — merge-exclusion guard.
 *
 * #1-#3 all ask: "is this gift QB-linked to a staged payment OTHER than the one I
 * am resolving?" Legacy answered that as direct (matched/created) ∪ splits, and —
 * critically — OMITTED group_reconciled. The ledger answer is the set of
 * payment_applications.payment_id (evidence_source='quickbooks') for the gift,
 * which INCLUDES group-reconciled rows. So the flip is an intentional broadening.
 *
 * This gate proves that broadening is SAFE by comparing, per gift, the SET of
 * staged payments the gift is "linked to":
 *   - legacyLinkers : { sp : matched_gift=gift OR created_gift=gift } ∪
 *                     { spl.staged_payment_id : split.gift=gift }   (no group)
 *   - ledgerLinkers : { pa.payment_id : pa.gift=gift AND qb }
 *   - groupLinkers  : { sp : group_reconciled_gift=gift }  (what legacy omitted)
 *
 * BLOCKING (gate FAILs on any):
 *   - regression: a legacyLinker NOT in ledgerLinkers — the ledger would DROP a
 *     link the legacy guard counted (a real "already-linked" miss → double-link
 *     risk). Must be zero.
 *   - unexplained broadening: a ledgerLinker NOT in legacyLinkers AND NOT in
 *     groupLinkers — an added linker that is not the accepted group-reconciled
 *     broadening. Must be zero.
 *   - countedLinked drift (#4): legacy full countedLinked != new countedLinked,
 *     where new = (ledger QB exists) OR (Stripe legacy arm unchanged). Must be zero.
 *
 * NON-BLOCKING (reported): explained broadening count (ledgerLinker in
 * groupLinkers) — the gifts whose guard answer changes, enumerated for the audit.
 *
 * Run: pnpm --filter @workspace/api-server run parity:reconciliation-guards
 *      (optional `--out <path>` writes the full machine-readable report)
 */
import { writeFileSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

interface RawRow {
  id: string;
  legacy_linkers: string[] | null;
  ledger_linkers: string[] | null;
  group_linkers: string[] | null;
  // audit-view linker set: direct (matched/created) ∪ group_reconciled ∪ splits.
  // The gift-detail audit view (giftsAndPayments audit-reconciliation) now
  // enumerates QB records from the ledger; this must reproduce the legacy set
  // EXACTLY (group IS included here — no broadening allowed).
  legacy_audit_linkers: string[] | null;
  legacy_counted: boolean;
  new_counted: boolean;
}

interface PaymentDiff {
  id: string;
  legacyUnlinked: boolean;
  ledgerUnlinked: boolean;
}

interface GuardDiff {
  id: string;
  reason: string;
  legacyLinkers: string[];
  ledgerLinkers: string[];
  groupLinkers: string[];
  detail: string[];
}

interface CountedDiff {
  id: string;
  legacyCounted: boolean;
  newCounted: boolean;
}

async function main(): Promise<void> {
  const outArgIdx = process.argv.indexOf("--out");
  const outPath = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : undefined;

  const rows = (
    await db.execute(sql`
      SELECT
        g.id,
        -- legacy linker set: direct (matched/created) ∪ splits. NO group_reconciled
        -- (mirrors the legacy #1-#3 guards exactly).
        (
          SELECT array_agg(DISTINCT s.x) FROM (
            SELECT sp.id AS x FROM staged_payments sp
              WHERE sp.matched_gift_id = g.id OR sp.created_gift_id = g.id
            UNION
            SELECT spl.staged_payment_id AS x FROM staged_payment_splits spl
              WHERE spl.gift_id = g.id
          ) s
        ) AS legacy_linkers,
        -- ledger linker set (QuickBooks evidence). Includes group-reconciled rows.
        (
          SELECT array_agg(DISTINCT pa.payment_id) FROM payment_applications pa
            WHERE pa.gift_id = g.id AND pa.evidence_source = 'quickbooks'
        ) AS ledger_linkers,
        -- group-reconciled linker set: exactly what the legacy guards omitted, used
        -- to explain (and bound) the ledger broadening.
        (
          SELECT array_agg(DISTINCT sp.id) FROM staged_payments sp
            WHERE sp.group_reconciled_gift_id = g.id
        ) AS group_linkers,
        -- audit-view linker set: direct (matched/created) ∪ group_reconciled ∪
        -- splits. The gift-detail audit view's ledger enumeration MUST match this
        -- exactly (group included, no broadening).
        (
          SELECT array_agg(DISTINCT s.x) FROM (
            SELECT sp.id AS x FROM staged_payments sp
              WHERE sp.matched_gift_id = g.id OR sp.created_gift_id = g.id
                OR sp.group_reconciled_gift_id = g.id
            UNION
            SELECT spl.staged_payment_id AS x FROM staged_payment_splits spl
              WHERE spl.gift_id = g.id
          ) s
        ) AS legacy_audit_linkers,
        -- #4 financialCorrections.countedLinked — legacy FULL predicate.
        (
          g.final_amount_qb_staged_payment_id IS NOT NULL
          OR g.final_amount_stripe_charge_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM staged_payments sp
              WHERE sp.matched_gift_id = g.id OR sp.created_gift_id = g.id
                OR sp.group_reconciled_gift_id = g.id)
          OR EXISTS (SELECT 1 FROM staged_payment_splits ss WHERE ss.gift_id = g.id)
          OR EXISTS (SELECT 1 FROM stripe_staged_charges sc
              WHERE sc.matched_gift_id = g.id OR sc.created_gift_id = g.id)
        ) AS legacy_counted,
        -- #4 NEW predicate: ledger QB arm replaces the QB legacy arms; Stripe arm
        -- unchanged.
        (
          EXISTS (SELECT 1 FROM payment_applications pa
              WHERE pa.gift_id = g.id AND pa.evidence_source = 'quickbooks')
          OR g.final_amount_stripe_charge_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM stripe_staged_charges sc
              WHERE sc.matched_gift_id = g.id OR sc.created_gift_id = g.id)
        ) AS new_counted
      FROM gifts_and_payments g
    `)
  ).rows as unknown as RawRow[];

  const regressions: GuardDiff[] = [];
  const unexplained: GuardDiff[] = [];
  const explainedBroadening: GuardDiff[] = [];
  const auditDrift: GuardDiff[] = [];
  const countedDrift: CountedDiff[] = [];

  for (const r of rows) {
    const legacy = new Set(r.legacy_linkers ?? []);
    const ledger = new Set(r.ledger_linkers ?? []);
    const group = new Set(r.group_linkers ?? []);
    const audit = new Set(r.legacy_audit_linkers ?? []);

    const mk = (reason: string, detail: string[]): GuardDiff => ({
      id: r.id,
      reason,
      legacyLinkers: [...legacy],
      ledgerLinkers: [...ledger],
      groupLinkers: [...group],
      detail,
    });

    // Regression: legacy counted a linker the ledger does not → BLOCK.
    const dropped = [...legacy].filter((x) => !ledger.has(x));
    if (dropped.length > 0) regressions.push(mk("ledger_dropped_legacy_linker", dropped));

    // Broadening: ledger has a linker legacy did not. Acceptable only if it is a
    // group-reconciled linker (the documented omission); else BLOCK.
    const added = [...ledger].filter((x) => !legacy.has(x));
    if (added.length > 0) {
      const unexplainedAdds = added.filter((x) => !group.has(x));
      if (unexplainedAdds.length > 0) {
        unexplained.push(mk("ledger_added_non_group_linker", unexplainedAdds));
      } else {
        explainedBroadening.push(mk("ledger_added_group_linker", added));
      }
    }

    // Audit-set parity: the gift-detail audit view enumerates QB records from the
    // ledger now, so the ledger set must EXACTLY equal the legacy audit set
    // (direct ∪ group ∪ splits — group included). Any diff either direction
    // means the audit view would show a different record set → BLOCK.
    const auditMissing = [...audit].filter((x) => !ledger.has(x));
    const auditExtra = [...ledger].filter((x) => !audit.has(x));
    if (auditMissing.length > 0 || auditExtra.length > 0) {
      auditDrift.push(
        mk("audit_set_mismatch", [
          ...auditMissing.map((x) => `-${x}`),
          ...auditExtra.map((x) => `+${x}`),
        ]),
      );
    }

    if (r.legacy_counted !== r.new_counted) {
      countedDrift.push({
        id: r.id,
        legacyCounted: r.legacy_counted,
        newCounted: r.new_counted,
      });
    }
  }

  // ── Payment-side parity ───────────────────────────────────────────────────
  // financialCorrections.loadUnlinkedQbStaged flipped its "is this staged payment
  // unlinked?" read from the legacy columns (matched/created/group all null AND no
  // split) to `NOT qbLedgerExistsForPayment()`. Prove the two agree per staged
  // payment (excluding `excluded` rows, which the worklist filters out anyway).
  const payRows = (
    await db.execute(sql`
      SELECT
        sp.id,
        (
          sp.matched_gift_id IS NULL
          AND sp.created_gift_id IS NULL
          AND sp.group_reconciled_gift_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM staged_payment_splits ss WHERE ss.staged_payment_id = sp.id
          )
        ) AS legacy_unlinked,
        (
          NOT EXISTS (
            SELECT 1 FROM payment_applications pa
            WHERE pa.payment_id = sp.id AND pa.evidence_source = 'quickbooks'
          )
        ) AS ledger_unlinked
      FROM staged_payments sp
      WHERE sp.status <> 'excluded'
    `)
  ).rows as unknown as {
    id: string;
    legacy_unlinked: boolean;
    ledger_unlinked: boolean;
  }[];

  const paymentDrift: PaymentDiff[] = payRows
    .filter((p) => p.legacy_unlinked !== p.ledger_unlinked)
    .map((p) => ({
      id: p.id,
      legacyUnlinked: p.legacy_unlinked,
      ledgerUnlinked: p.ledger_unlinked,
    }));

  const report = {
    generatedAt: new Date().toISOString(),
    totalGifts: rows.length,
    totalStagedPayments: payRows.length,
    counts: {
      regressions: regressions.length,
      unexplainedBroadening: unexplained.length,
      explainedGroupBroadening: explainedBroadening.length,
      auditDrift: auditDrift.length,
      paymentDrift: paymentDrift.length,
      countedDrift: countedDrift.length,
    },
    regressions,
    unexplainedBroadening: unexplained,
    explainedGroupBroadening: explainedBroadening,
    auditDrift,
    paymentDrift,
    countedDrift,
  };

  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));

  const sampleGuard = (arr: GuardDiff[]): string =>
    arr
      .slice(0, 25)
      .map(
        (d) =>
          `    ${d.id}  [${d.reason}]  detail=${JSON.stringify(d.detail)}  legacy=${JSON.stringify(d.legacyLinkers)}  ledger=${JSON.stringify(d.ledgerLinkers)}`,
      )
      .join("\n");
  const sampleCounted = (arr: CountedDiff[]): string =>
    arr
      .slice(0, 25)
      .map((d) => `    ${d.id}  legacy=${d.legacyCounted}  new=${d.newCounted}`)
      .join("\n");
  const samplePayment = (arr: PaymentDiff[]): string =>
    arr
      .slice(0, 25)
      .map(
        (d) =>
          `    ${d.id}  legacyUnlinked=${d.legacyUnlinked}  ledgerUnlinked=${d.ledgerUnlinked}`,
      )
      .join("\n");

  console.log("=== reconciliation-guards parity report ===");
  console.log(`Total gifts: ${rows.length}`);
  console.log(`Total staged payments (non-excluded): ${payRows.length}`);
  console.log(
    `\nRegressions (ledger DROPPED a legacy linker) [BLOCKING]: ${regressions.length}` +
      (regressions.length ? `\n${sampleGuard(regressions)}` : ""),
  );
  console.log(
    `\nUnexplained broadening (added linker NOT group-reconciled) [BLOCKING]: ${unexplained.length}` +
      (unexplained.length ? `\n${sampleGuard(unexplained)}` : ""),
  );
  console.log(
    `\nAudit-set mismatch (gift-detail audit ledger set != legacy direct∪group∪splits) [BLOCKING]: ${auditDrift.length}` +
      (auditDrift.length ? `\n${sampleGuard(auditDrift)}` : ""),
  );
  console.log(
    `\nPayment-side unlinked drift (loadUnlinkedQbStaged legacy vs ledger) [BLOCKING]: ${paymentDrift.length}` +
      (paymentDrift.length ? `\n${samplePayment(paymentDrift)}` : ""),
  );
  console.log(
    `\ncountedLinked drift (#4 legacy vs ledger-QB+Stripe) [BLOCKING]: ${countedDrift.length}` +
      (countedDrift.length ? `\n${sampleCounted(countedDrift)}` : ""),
  );
  console.log(
    `\nExplained group-reconciled broadening (informational, intended): ${explainedBroadening.length}` +
      (explainedBroadening.length ? `\n${sampleGuard(explainedBroadening)}` : ""),
  );
  if (outPath) console.log(`\nFull report written to ${outPath}`);

  const failed =
    regressions.length > 0 ||
    unexplained.length > 0 ||
    auditDrift.length > 0 ||
    paymentDrift.length > 0 ||
    countedDrift.length > 0;
  console.log(`\nGATE: ${failed ? "FAIL" : "PASS"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Reconciliation-guards parity check failed:", err);
  process.exit(2);
});
