// Single-source read helpers for first-class UNIT GROUP membership
// (`unit_groups` / `unit_group_members`, docs/reconciliation-design.md §4.6b,
// Decision 7). These are the one place the WS1 mechanism collapse (Phase 3)
// flips group READS/GUARDS off the legacy `staged_payments.source_group_id`
// pointer and onto the durable membership table.
//
// SCOPE: QuickBooks staged payments. The membership table is polymorphic
// (`evidence_source` in quickbooks/stripe/donorbox), but only QB units are
// grouped today (source_group_id was QB-only), so every helper defaults to
// `evidence_source = 'quickbooks'`. A `source_id` here is a `staged_payments.id`.
//
// DUAL-WRITE INVARIANT: this task changes what code READS, not what
// group-reconcile WRITES. The legacy pointers (representative `matched_gift_id`,
// others' `group_reconciled_gift_id`, and `source_group_id`) keep being written
// until Phase 7. Routing every group read through this one module makes that
// Phase-7 drop a single-file audit.

// `db` is imported type-only ONLY to derive the transaction type — importing
// this helper carries no runtime DB coupling; every function takes the caller's
// `tx`.
import type { db } from "@workspace/db";
import { unitGroupMembers } from "@workspace/db/schema";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PaymentApplicationEvidenceSource } from "./paymentApplications";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
// Group reads run both as cheap pre-transaction guards (on the pooled `db`) and
// inside a reconcile/approve transaction (on its `tx`). Accept either, matching
// the repo convention (`reconciliationBundleProposal.ts`, `bundleProposals.ts`).
type DbLike = typeof db | Tx;

const QUICKBOOKS: PaymentApplicationEvidenceSource = "quickbooks";

/**
 * True iff the evidence unit belongs to a `unit_groups` group. This is the
 * exclusivity guard the reconciler reads: a grouped unit matches ONLY via its
 * group, never individually. Replaces the legacy `sourceGroupId != null` check.
 */
export async function isGroupMember(
  tx: DbLike,
  sourceId: string,
  evidenceSource: PaymentApplicationEvidenceSource = QUICKBOOKS,
): Promise<boolean> {
  const row = await tx
    .select({ id: unitGroupMembers.id })
    .from(unitGroupMembers)
    .where(
      and(
        eq(unitGroupMembers.evidenceSource, evidenceSource),
        eq(unitGroupMembers.sourceId, sourceId),
      ),
    )
    .limit(1)
    .then((r) => r[0]);
  return row != null;
}

/**
 * The sorted `source_id`s of every unit in the SAME group as `sourceId`
 * (INCLUDING `sourceId` itself), scoped to one evidence source. Returns `[]`
 * when the unit is not grouped ("a lone member is not a group"). Sorted with JS
 * default (lexicographic) order so the smallest id is a deterministic
 * representative, matching the group-reconcile write path.
 *
 * Replaces reading `staged_payments.source_group_id` to expand a group.
 */
export async function groupMemberIdsFor(
  tx: DbLike,
  sourceId: string,
  evidenceSource: PaymentApplicationEvidenceSource = QUICKBOOKS,
): Promise<string[]> {
  const self = await tx
    .select({ groupId: unitGroupMembers.groupId })
    .from(unitGroupMembers)
    .where(
      and(
        eq(unitGroupMembers.evidenceSource, evidenceSource),
        eq(unitGroupMembers.sourceId, sourceId),
      ),
    )
    .limit(1)
    .then((r) => r[0]);
  if (!self) return [];

  const members = await tx
    .select({ sourceId: unitGroupMembers.sourceId })
    .from(unitGroupMembers)
    .where(
      and(
        eq(unitGroupMembers.groupId, self.groupId),
        eq(unitGroupMembers.evidenceSource, evidenceSource),
      ),
    );
  return members.map((m) => m.sourceId).sort();
}

// ─── SQL fragment for SQL-embedded readers ───────────────────────────────────
//
// Same bare-column footgun rule as `paymentApplications.ts`: the correlated
// source-id is passed as a PRE-QUALIFIED SQL expression, never an interpolated
// drizzle Column (which would render the bare `"id"` and silently bind to the
// inner table). See `.agents/memory/drizzle-sql-template-bare-column.md`. The
// default targets an un-aliased `.from(stagedPayments)` query, which drizzle
// qualifies as `"staged_payments"."id"`; aliased/raw callers pass their own.
export const DEFAULT_STAGED_ID_SQL: SQL = sql.raw('"staged_payments"."id"');

/** EXISTS a QuickBooks `unit_group_members` row for the staged payment. */
export function isQbGroupMemberSql(
  sourceIdSql: SQL = DEFAULT_STAGED_ID_SQL,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM unit_group_members ugm
    WHERE ugm.evidence_source = 'quickbooks' AND ugm.source_id = ${sourceIdSql}
  )`;
}
