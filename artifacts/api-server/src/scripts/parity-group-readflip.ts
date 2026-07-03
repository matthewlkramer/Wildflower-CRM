/**
 * WS1 GROUP READ-FLIP PARITY GATE — the guard + revert reads about to be flipped
 * from the legacy `staged_payments.source_group_id` / representative /
 * `group_reconciled_gift_id` mechanism onto `unit_group_members` + the
 * `payment_applications` ledger (docs/reconciliation-design.md §4.6b, Decision 7,
 * §7 Phase 3).
 *
 * COMPLEMENTS the two gates that already exist — it does NOT duplicate them:
 *   - parity:unit-groups          proves membership parity for CANONICAL (>= 2
 *                                 member) source groups (group grain).
 *   - parity:reconciliation-guards proves the "linked-elsewhere" ledger guards
 *                                 don't drop a legacy linker (gift grain).
 *
 * This gate proves the two things unique to flipping the GROUP EXCLUSIVITY guard
 * (`/reconcile`, ignore/unignore/donor, group expansion) and the group REVERT:
 *
 *   1. GUARD EQUIVALENCE — the set of staged payments the LEGACY guards treat as
 *      "grouped" (source_group_id != null) must equal the set the NEW guard treats
 *      as grouped (a quickbooks unit_group_members row), in BOTH directions:
 *        - member_not_guarded (BLOCKING): a member of a CANONICAL (>= 2) source
 *          group with NO unit_group membership → post-flip it would go UNGUARDED.
 *        - member_without_pointer (BLOCKING): a quickbooks unit_group_member whose
 *          staged payment has a NULL source_group_id → post-flip it would be
 *          OVER-guarded (should be impossible under the dual-write).
 *
 *   2. REVERT / LINKAGE LEDGER COVERAGE — every LINKED group member (carries
 *      matched/created/group_reconciled_gift_id) must have a matching COUNTED
 *      quickbooks payment_applications row to that SAME gift, because the flipped
 *      revert + linkage reads source the member↔gift tie from the ledger, not the
 *      pointer columns:
 *        - revert_linkage_gap (BLOCKING): a linked group member with no counted QB
 *          ledger row to its linked gift → the ledger-based revert would drop it.
 *
 * THE SURFACED RISK (non-blocking, REVIEW REQUIRED if > 0):
 *   - singleton_source_group: a source_group_id carried by exactly ONE staged
 *     payment. The legacy guards fire on ANY non-null source_group_id, so a
 *     singleton is guarded TODAY; but the 0088 backfill + the group handler only
 *     ever create unit_groups for >= 2 members, so post-flip a singleton is
 *     UN-guarded. The design says "a lone member is not a group", so treating it
 *     as ungrouped is very likely correct — but this is a behavior change on that
 *     row and MUST be a human decision before the flip ships.
 *
 * The GATE PASSes iff there are zero BLOCKING exceptions; singletons are printed
 * prominently but do not fail the gate.
 *
 * NOTE: connects to $DATABASE_URL, which in the workspace shell is the DEV
 * database. To run against PROD, override for this one command (READ-ONLY, safe):
 *   DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/api-server run parity:group-readflip
 *      (optional `--out <path>` writes the full machine-readable report)
 */
import { writeFileSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

interface Exception {
  kind:
    | "member_not_guarded"
    | "member_without_pointer"
    | "revert_linkage_gap"
    | "singleton_source_group";
  sourceGroupId?: string | null;
  stagedPaymentId?: string | null;
  giftId?: string | null;
  detail: string;
}

async function main(): Promise<void> {
  const outArgIdx = process.argv.indexOf("--out");
  const outPath = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : undefined;

  const exceptions: Exception[] = [];

  // ── 1. Guard equivalence (forward): classify every non-null source_group_id
  //       by member count, and count members lacking a quickbooks ug membership.
  const groups = (
    await db.execute(sql`
      SELECT
        sp.source_group_id AS source_group_id,
        COUNT(*)::int AS member_count,
        (SELECT COUNT(*)::int FROM staged_payments s2
          WHERE s2.source_group_id = sp.source_group_id
            AND NOT EXISTS (
              SELECT 1 FROM unit_group_members ugm
               WHERE ugm.evidence_source = 'quickbooks'
                 AND ugm.source_id = s2.id)) AS unmembered
      FROM staged_payments sp
      WHERE sp.source_group_id IS NOT NULL
      GROUP BY sp.source_group_id
    `)
  ).rows as unknown as {
    source_group_id: string;
    member_count: number;
    unmembered: number;
  }[];

  let canonicalGroups = 0;
  let singletonGroups = 0;
  for (const g of groups) {
    if (g.member_count < 2) {
      singletonGroups++;
      exceptions.push({
        kind: "singleton_source_group",
        sourceGroupId: g.source_group_id,
        detail: `source_group_id carried by 1 staged payment — legacy-guarded, unguarded after the flip`,
      });
      continue;
    }
    canonicalGroups++;
    if (g.unmembered > 0) {
      exceptions.push({
        kind: "member_not_guarded",
        sourceGroupId: g.source_group_id,
        detail: `${g.unmembered} of ${g.member_count} canonical members have no unit_group membership`,
      });
    }
  }

  // ── 2. Guard equivalence (reverse): a quickbooks member with no backing legacy
  //       pointer would be over-guarded (dual-write should make this impossible).
  const overGuarded = (
    await db.execute(sql`
      SELECT ugm.source_id, ugm.group_id
      FROM unit_group_members ugm
      WHERE ugm.evidence_source = 'quickbooks'
        AND NOT EXISTS (
          SELECT 1 FROM staged_payments sp
          WHERE sp.id = ugm.source_id
            AND sp.source_group_id IS NOT NULL)
    `)
  ).rows as unknown as { source_id: string; group_id: string }[];
  for (const m of overGuarded) {
    exceptions.push({
      kind: "member_without_pointer",
      stagedPaymentId: m.source_id,
      detail: `unit_group_member under ${m.group_id} but its staged payment has a NULL source_group_id`,
    });
  }

  // ── 3. Revert / linkage ledger coverage: every LINKED group member must have a
  //       counted quickbooks ledger row to its SAME linked gift.
  const linkageGaps = (
    await db.execute(sql`
      SELECT sp.id AS staged_id,
             COALESCE(sp.group_reconciled_gift_id, sp.matched_gift_id, sp.created_gift_id) AS gift_id
      FROM staged_payments sp
      WHERE sp.source_group_id IS NOT NULL
        AND COALESCE(sp.group_reconciled_gift_id, sp.matched_gift_id, sp.created_gift_id) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM payment_applications pa
          WHERE pa.payment_id = sp.id
            AND pa.evidence_source = 'quickbooks'
            AND pa.link_role = 'counted'
            AND pa.gift_id = COALESCE(sp.group_reconciled_gift_id, sp.matched_gift_id, sp.created_gift_id))
    `)
  ).rows as unknown as { staged_id: string; gift_id: string }[];
  for (const l of linkageGaps) {
    exceptions.push({
      kind: "revert_linkage_gap",
      stagedPaymentId: l.staged_id,
      giftId: l.gift_id,
      detail: `linked group member has no counted QB ledger row to its linked gift`,
    });
  }

  const byKind = (k: Exception["kind"]) =>
    exceptions.filter((e) => e.kind === k);

  const blockingKinds = [
    "member_not_guarded",
    "member_without_pointer",
    "revert_linkage_gap",
  ] as const;
  const blocking = exceptions.filter((e) =>
    (blockingKinds as readonly string[]).includes(e.kind),
  );

  const report = {
    generatedAt: new Date().toISOString(),
    canonicalSourceGroups: canonicalGroups,
    singletonSourceGroups: singletonGroups,
    counts: {
      member_not_guarded: byKind("member_not_guarded").length,
      member_without_pointer: byKind("member_without_pointer").length,
      revert_linkage_gap: byKind("revert_linkage_gap").length,
      singleton_source_group: byKind("singleton_source_group").length,
    },
    exceptions,
  };
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));

  const sample = (arr: Exception[]): string =>
    arr
      .slice(0, 25)
      .map(
        (e) =>
          `    [${e.kind}]  sgid=${e.sourceGroupId ?? "—"}  sp=${e.stagedPaymentId ?? "—"}  gift=${e.giftId ?? "—"}  ${e.detail}`,
      )
      .join("\n");

  console.log("=== group read-flip parity report ===");
  console.log(`Canonical source groups (>= 2): ${canonicalGroups}`);
  console.log(`Singleton source groups (== 1): ${singletonGroups}`);
  for (const k of blockingKinds) {
    const arr = byKind(k);
    console.log(
      `\n${k} [BLOCKING]: ${arr.length}` + (arr.length ? `\n${sample(arr)}` : ""),
    );
  }
  const singles = byKind("singleton_source_group");
  console.log(
    `\nsingleton_source_group [REVIEW REQUIRED if > 0]: ${singles.length}` +
      (singles.length
        ? `\n${sample(singles)}\n  → Decide explicitly before the flip: the design treats a lone member as ungrouped.`
        : ""),
  );

  const failed = blocking.length > 0;
  console.log(`\nGATE: ${failed ? "FAIL" : "PASS"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Group read-flip parity check failed:", err);
  process.exit(2);
});
