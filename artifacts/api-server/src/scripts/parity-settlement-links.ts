/**
 * PARITY GATE — settlement_links vs. legacy stripe_payouts.qb_reconciliation_status.
 *
 * This is the gate that MUST pass (zero BLOCKING exceptions) on PROD before the
 * payout settlement reads are flipped from the legacy
 * `stripe_payouts.qb_reconciliation_status` + pointer columns
 * (`proposed/matched/qb_conflict_staged_payment_id`) to the first-class
 * `settlement_links` table (docs/reconciliation-design.md §4.3 / §4.4). While the
 * additive dual-write phase is live, every payout's settlement link must be EXACTLY
 * what `deriveSettlementLinkFields` produces from that payout's CURRENT legacy state
 * — the same pure mapping the runtime dual-write (settlementLink.ts) and the 0089
 * backfill both use, so all three stay in lockstep by construction.
 *
 * For every payout the gate proves, in both directions:
 *
 *   BLOCKING checks (gate FAILs on any):
 *     - missing_link          : legacy state derives a link but there is no
 *                               `sl_<payoutId>` row.
 *     - orphan_link           : an `sl_*` row whose payout derives NO link (a delete
 *                               the unmatched/revert dual-write failed to clean up,
 *                               or a link pointing at a payout that no longer exists).
 *     - field_mismatch        : a link whose load-bearing fields (lifecycle,
 *                               provenance, deposit, confirmed_by, confirmed_at)
 *                               differ from the derived mirror.
 *     - exclusivity_violation : more than one link for one payout (the PK
 *                               `sl_<payout_id>` + UNIQUE(payout_id) should make this
 *                               impossible; checked defensively).
 *
 * Two comparison carve-outs, both by design:
 *   • The `note` column is NOT compared — it holds the 0089 backfill's
 *     `legacy <status>` provenance markers + future human annotations, and is NOT
 *     part of the derived mirror (see settlementLink.ts).
 *   • `confirmed_at` for a `system_confirmed` link derives from the payout's
 *     `updated_at` FALLBACK, which the Stripe sync worker legitimately bumps on every
 *     re-pull WITHOUT re-syncing the link. So its exact value is compared ONLY for
 *     `human`-confirmed links (where it tracks the stable
 *     `qb_reconciliation_confirmed_at`); for the rest only its presence (non-null,
 *     required for a confirmed link / absent for a proposed one) is checked.
 *
 * Read-only + prod-runnable. Exit 0 only when all four kinds are empty.
 *
 * Run: pnpm --filter @workspace/api-server run parity:settlement-links
 *      (optional `--out <path>` writes the full machine-readable report)
 */
import { writeFileSync } from "node:fs";
import { db } from "@workspace/db";
import { stripePayouts, settlementLinks } from "@workspace/db/schema";
import { deriveSettlementLinkFields } from "../lib/settlementLink";

interface Exception {
  kind:
    | "missing_link"
    | "orphan_link"
    | "field_mismatch"
    | "exclusivity_violation";
  payoutId?: string | null;
  settlementLinkId?: string | null;
  detail: string;
}

const ms = (d: Date | null): number | null => (d ? d.getTime() : null);

async function main(): Promise<void> {
  const outArgIdx = process.argv.indexOf("--out");
  const outPath = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : undefined;

  const exceptions: Exception[] = [];

  // Every payout's legacy reconciliation state — the exact inputs to the pure
  // `deriveSettlementLinkFields` mapping.
  const payouts = await db
    .select({
      id: stripePayouts.id,
      qbReconciliationStatus: stripePayouts.qbReconciliationStatus,
      proposedQbStagedPaymentId: stripePayouts.proposedQbStagedPaymentId,
      matchedQbStagedPaymentId: stripePayouts.matchedQbStagedPaymentId,
      qbConflictStagedPaymentId: stripePayouts.qbConflictStagedPaymentId,
      qbReconciliationConfirmedByUserId:
        stripePayouts.qbReconciliationConfirmedByUserId,
      qbReconciliationConfirmedAt: stripePayouts.qbReconciliationConfirmedAt,
      updatedAt: stripePayouts.updatedAt,
    })
    .from(stripePayouts);

  const links = await db
    .select({
      id: settlementLinks.id,
      payoutId: settlementLinks.payoutId,
      depositStagedPaymentId: settlementLinks.depositStagedPaymentId,
      lifecycle: settlementLinks.lifecycle,
      provenance: settlementLinks.provenance,
      confirmedByUserId: settlementLinks.confirmedByUserId,
      confirmedAt: settlementLinks.confirmedAt,
    })
    .from(settlementLinks);

  type LinkRow = (typeof links)[number];
  const linksByPayout = new Map<string, LinkRow[]>();
  for (const l of links) {
    const arr = linksByPayout.get(l.payoutId);
    if (arr) arr.push(l);
    else linksByPayout.set(l.payoutId, [l]);
  }

  // ── Exclusivity — a payout with more than one settlement link (the PK +
  //    UNIQUE(payout_id) should prevent it; checked defensively).
  for (const [payoutId, arr] of linksByPayout) {
    if (arr.length > 1) {
      exceptions.push({
        kind: "exclusivity_violation",
        payoutId,
        detail: `payout has ${arr.length} settlement links: ${arr
          .map((l) => l.id)
          .join(", ")}`,
      });
    }
  }

  // ── Forward + field checks — every payout's link must equal the derived mirror.
  const seenPayouts = new Set<string>();
  let derivedLinks = 0;
  for (const p of payouts) {
    seenPayouts.add(p.id);
    const expected = deriveSettlementLinkFields(p);
    const link = linksByPayout.get(p.id)?.[0] ?? null;

    if (!expected) {
      if (link) {
        exceptions.push({
          kind: "orphan_link",
          payoutId: p.id,
          settlementLinkId: link.id,
          detail: `link exists but status='${
            p.qbReconciliationStatus ?? "—"
          }' derives no link`,
        });
      }
      continue;
    }

    derivedLinks++;
    if (!link) {
      exceptions.push({
        kind: "missing_link",
        payoutId: p.id,
        settlementLinkId: `sl_${p.id}`,
        detail: `status='${p.qbReconciliationStatus}' derives ${expected.lifecycle}/${expected.provenance} deposit=${expected.depositStagedPaymentId} but no sl_ row`,
      });
      continue;
    }

    const diffs: string[] = [];
    if (link.lifecycle !== expected.lifecycle) {
      diffs.push(`lifecycle ${link.lifecycle}≠${expected.lifecycle}`);
    }
    if (link.provenance !== expected.provenance) {
      diffs.push(`provenance ${link.provenance}≠${expected.provenance}`);
    }
    if (link.depositStagedPaymentId !== expected.depositStagedPaymentId) {
      diffs.push(
        `deposit ${link.depositStagedPaymentId ?? "∅"}≠${
          expected.depositStagedPaymentId ?? "∅"
        }`,
      );
    }
    if (
      (link.confirmedByUserId ?? null) !== (expected.confirmedByUserId ?? null)
    ) {
      diffs.push(
        `confirmedBy ${link.confirmedByUserId ?? "∅"}≠${
          expected.confirmedByUserId ?? "∅"
        }`,
      );
    }
    // confirmed_at: presence parity ALWAYS; exact timestamp ONLY when the derive
    // read it from the STABLE `qb_reconciliation_confirmed_at` (human provenance
    // WITH that column populated). Whenever the derive fell back to the payout's
    // `updated_at` — every system_confirmed row AND any legacy human row that
    // predates the confirm-time discipline of stamping confirmed_at alongside
    // confirmed_by — the value legitimately drifts on each sync re-pull, so only
    // its presence is checked.
    const linkHasAt = link.confirmedAt != null;
    const expHasAt = expected.confirmedAt != null;
    if (linkHasAt !== expHasAt) {
      diffs.push(`confirmedAt presence ${linkHasAt}≠${expHasAt}`);
    } else if (
      expected.provenance === "human" &&
      p.qbReconciliationConfirmedAt != null &&
      ms(link.confirmedAt) !== ms(expected.confirmedAt)
    ) {
      diffs.push(
        `confirmedAt ${link.confirmedAt?.toISOString() ?? "∅"}≠${
          expected.confirmedAt?.toISOString() ?? "∅"
        }`,
      );
    }

    if (diffs.length) {
      exceptions.push({
        kind: "field_mismatch",
        payoutId: p.id,
        settlementLinkId: link.id,
        detail: diffs.join("; "),
      });
    }
  }

  // ── Reverse — a link whose payout row no longer exists (FK cascade should
  //    prevent it, so this is a defensive integrity check).
  for (const l of links) {
    if (!seenPayouts.has(l.payoutId)) {
      exceptions.push({
        kind: "orphan_link",
        payoutId: l.payoutId,
        settlementLinkId: l.id,
        detail: "link references a payout that no longer exists",
      });
    }
  }

  const byKind = (k: Exception["kind"]) =>
    exceptions.filter((e) => e.kind === k);

  const report = {
    generatedAt: new Date().toISOString(),
    payouts: payouts.length,
    settlementLinks: links.length,
    derivedLinks,
    counts: {
      missing_link: byKind("missing_link").length,
      orphan_link: byKind("orphan_link").length,
      field_mismatch: byKind("field_mismatch").length,
      exclusivity_violation: byKind("exclusivity_violation").length,
    },
    exceptions,
  };

  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));

  const sample = (arr: Exception[]): string =>
    arr
      .slice(0, 25)
      .map(
        (e) =>
          `    [${e.kind}]  payout=${e.payoutId ?? "—"}  sl=${
            e.settlementLinkId ?? "—"
          }  ${e.detail}`,
      )
      .join("\n");

  console.log("=== settlement_links parity report ===");
  console.log(`stripe_payouts rows:      ${payouts.length}`);
  console.log(`settlement_links rows:    ${links.length}`);
  console.log(`payouts deriving a link:  ${derivedLinks}`);
  for (const k of [
    "missing_link",
    "orphan_link",
    "field_mismatch",
    "exclusivity_violation",
  ] as const) {
    const arr = byKind(k);
    console.log(
      `\n${k}: ${arr.length}` + (arr.length ? `\n${sample(arr)}` : ""),
    );
  }

  const failed = exceptions.length > 0;
  console.log(`\nGATE: ${failed ? "FAIL" : "PASS"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Parity check failed:", err);
  process.exit(2);
});
