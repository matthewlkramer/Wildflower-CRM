/**
 * WS2 PARITY GATE — unit_groups vs. legacy staged_payments.source_group_id.
 *
 * This is the gate that MUST pass (zero exceptions) on PROD before any read
 * surface is flipped from the legacy `staged_payments.source_group_id` grouping
 * to the first-class `unit_groups` / `unit_group_members` association
 * (docs/reconciliation-design.md §4.6b, Decision 7). While the dual-write phase
 * is live, both must describe the SAME set of groups and the SAME membership.
 *
 * A canonical group is a `source_group_id` shared by >= 2 staged payments (the
 * only kind the reconciler treats as a group; a lone member is not a group). For
 * every such group the gate proves, in both directions:
 *
 *   BLOCKING checks (gate FAILs on any):
 *     - missing_unit_group    : a canonical source group with no `ug_<sgid>` row.
 *     - member_mismatch       : the quickbooks members of `ug_<sgid>` are not the
 *                               exact set of staged payments carrying that
 *                               source_group_id (missing and/or extra members).
 *     - orphan_unit_group     : a `ug_*` group whose backing source_group_id no
 *                               longer has >= 2 members (a dissolve the ungroup
 *                               dual-write failed to clean up).
 *     - orphan_member         : a quickbooks unit_group_member whose staged
 *                               payment's source_group_id doesn't match the
 *                               group it's filed under (or is NULL).
 *     - exclusivity_violation : a unit that appears in more than one group
 *                               (the UNIQUE(evidence_source, source_id) should
 *                               make this impossible; checked defensively).
 *
 * Exit 0 only when all five are empty.
 *
 * Run: pnpm --filter @workspace/api-server run parity:unit-groups
 *      (optional `--out <path>` writes the full machine-readable report)
 */
import { writeFileSync } from "node:fs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

interface Exception {
  kind:
    | "missing_unit_group"
    | "member_mismatch"
    | "orphan_unit_group"
    | "orphan_member"
    | "exclusivity_violation";
  sourceGroupId?: string | null;
  unitGroupId?: string | null;
  detail: string;
}

async function main(): Promise<void> {
  const outArgIdx = process.argv.indexOf("--out");
  const outPath = outArgIdx >= 0 ? process.argv[outArgIdx + 1] : undefined;

  const exceptions: Exception[] = [];

  // ── 1. Canonical source groups (>= 2 members) must each have a ug_ group
  //       whose quickbooks membership is EXACTLY the grouped staged-payment set.
  const groups = (
    await db.execute(sql`
      SELECT
        sp.source_group_id AS source_group_id,
        COUNT(*)::int AS member_count,
        (SELECT COUNT(*)::int
           FROM unit_group_members ugm
          WHERE ugm.group_id = 'ug_' || sp.source_group_id
            AND ugm.evidence_source = 'quickbooks') AS ug_member_count,
        EXISTS (SELECT 1 FROM unit_groups ug
                 WHERE ug.id = 'ug_' || sp.source_group_id) AS has_group,
        -- members present in staged_payments but NOT in the ug group
        (SELECT COUNT(*)::int FROM staged_payments s2
          WHERE s2.source_group_id = sp.source_group_id
            AND NOT EXISTS (
              SELECT 1 FROM unit_group_members ugm
               WHERE ugm.group_id = 'ug_' || sp.source_group_id
                 AND ugm.evidence_source = 'quickbooks'
                 AND ugm.source_id = s2.id)) AS missing_members,
        -- members in the ug group but NOT (any longer) in that source group
        (SELECT COUNT(*)::int FROM unit_group_members ugm
          WHERE ugm.group_id = 'ug_' || sp.source_group_id
            AND ugm.evidence_source = 'quickbooks'
            AND NOT EXISTS (
              SELECT 1 FROM staged_payments s3
               WHERE s3.id = ugm.source_id
                 AND s3.source_group_id = sp.source_group_id)) AS extra_members
      FROM staged_payments sp
      WHERE sp.source_group_id IS NOT NULL
      GROUP BY sp.source_group_id
      HAVING COUNT(*) >= 2
    `)
  ).rows as unknown as {
    source_group_id: string;
    member_count: number;
    ug_member_count: number;
    has_group: boolean;
    missing_members: number;
    extra_members: number;
  }[];

  let canonicalGroups = 0;
  for (const g of groups) {
    canonicalGroups++;
    if (!g.has_group) {
      exceptions.push({
        kind: "missing_unit_group",
        sourceGroupId: g.source_group_id,
        unitGroupId: `ug_${g.source_group_id}`,
        detail: `source group has ${g.member_count} members but no ug_ row`,
      });
      continue;
    }
    if (g.missing_members > 0 || g.extra_members > 0) {
      exceptions.push({
        kind: "member_mismatch",
        sourceGroupId: g.source_group_id,
        unitGroupId: `ug_${g.source_group_id}`,
        detail: `staged=${g.member_count} ug=${g.ug_member_count} missing=${g.missing_members} extra=${g.extra_members}`,
      });
    }
  }

  // ── 2. Every ug_* group must map back to a canonical (>= 2 member) source
  //       group — else it's a dissolve the ungroup path failed to clean up.
  const orphanGroups = (
    await db.execute(sql`
      SELECT ug.id AS unit_group_id
      FROM unit_groups ug
      WHERE ug.id LIKE 'ug_%'
        AND NOT EXISTS (
          SELECT 1 FROM staged_payments sp
          WHERE sp.source_group_id = substring(ug.id from 4)
          GROUP BY sp.source_group_id
          HAVING COUNT(*) >= 2)
    `)
  ).rows as unknown as { unit_group_id: string }[];
  for (const o of orphanGroups) {
    exceptions.push({
      kind: "orphan_unit_group",
      unitGroupId: o.unit_group_id,
      detail: "ug_ group has no backing >= 2-member source group",
    });
  }

  // ── 3. Every quickbooks member must sit under the ug group matching its
  //       staged payment's CURRENT source_group_id.
  const orphanMembers = (
    await db.execute(sql`
      SELECT ugm.source_id, ugm.group_id
      FROM unit_group_members ugm
      WHERE ugm.evidence_source = 'quickbooks'
        AND NOT EXISTS (
          SELECT 1 FROM staged_payments sp
          WHERE sp.id = ugm.source_id
            AND sp.source_group_id IS NOT NULL
            AND 'ug_' || sp.source_group_id = ugm.group_id)
    `)
  ).rows as unknown as { source_id: string; group_id: string }[];
  for (const m of orphanMembers) {
    exceptions.push({
      kind: "orphan_member",
      unitGroupId: m.group_id,
      detail: `member ${m.source_id} not under its staged source_group_id`,
    });
  }

  // ── 4. Exclusivity — a unit in more than one group (index should prevent it).
  const dupMembers = (
    await db.execute(sql`
      SELECT evidence_source, source_id, COUNT(*)::int AS n
      FROM unit_group_members
      GROUP BY evidence_source, source_id
      HAVING COUNT(*) > 1
    `)
  ).rows as unknown as {
    evidence_source: string;
    source_id: string;
    n: number;
  }[];
  for (const d of dupMembers) {
    exceptions.push({
      kind: "exclusivity_violation",
      detail: `${d.evidence_source}/${d.source_id} appears in ${d.n} groups`,
    });
  }

  const [{ total_groups, total_members }] = (
    await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM unit_groups) AS total_groups,
        (SELECT COUNT(*)::int FROM unit_group_members) AS total_members
    `)
  ).rows as unknown as { total_groups: number; total_members: number }[];

  const byKind = (k: Exception["kind"]) =>
    exceptions.filter((e) => e.kind === k);

  const report = {
    generatedAt: new Date().toISOString(),
    canonicalSourceGroups: canonicalGroups,
    totalUnitGroups: total_groups,
    totalUnitGroupMembers: total_members,
    counts: {
      missing_unit_group: byKind("missing_unit_group").length,
      member_mismatch: byKind("member_mismatch").length,
      orphan_unit_group: byKind("orphan_unit_group").length,
      orphan_member: byKind("orphan_member").length,
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
          `    [${e.kind}]  sgid=${e.sourceGroupId ?? "—"}  ug=${e.unitGroupId ?? "—"}  ${e.detail}`,
      )
      .join("\n");

  console.log("=== unit_groups parity report ===");
  console.log(`Canonical source groups (>= 2): ${canonicalGroups}`);
  console.log(`unit_groups rows:               ${total_groups}`);
  console.log(`unit_group_members rows:        ${total_members}`);
  for (const k of [
    "missing_unit_group",
    "member_mismatch",
    "orphan_unit_group",
    "orphan_member",
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
