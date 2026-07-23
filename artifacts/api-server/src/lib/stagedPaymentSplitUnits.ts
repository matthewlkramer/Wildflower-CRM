import { db } from "@workspace/db";
import {
  stagedPayments,
  paymentApplications,
  sourceLinks,
} from "@workspace/db/schema";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { ReconcileAbort } from "./reconciliationCommit";

/**
 * Split a QuickBooks staged row into synthetic child RECONCILIATION UNITS
 * (workbench-business-rules §7.2 "one QB row bundles several money events").
 *
 * The parent stays the untouched sync-owned QuickBooks mirror; the children
 * are additive CRM associations that participate everywhere real rows do
 * (charge ties, settled payout pairings, cash applications). While children exist
 * the parent derives `excluded` (qbHasSplitChildrenText — resolved
 * elsewhere) and every matcher/picker skips it; unsplitting restores it.
 *
 * Invariants (all enforced here, in ONE transaction):
 *   - children sum to EXACTLY the parent amount (signed cents);
 *   - at least 2 children, none zero;
 *   - no nested splits (a child can never become a parent — the DB CHECK
 *     `(split_parent_id IS NULL) = (qb_entity_id IS NOT NULL)` only pins the
 *     shape, the nesting ban lives here);
 *   - the parent carries NO live claims at split time: no cash application,
 *     no settled payout pairing, no CONFIRMED source_link naming it.
 *     Its PROPOSED ties/links are cleared as part of the split (a machine
 *     guess must not block the human's stronger statement);
 *   - unsplit requires every child to be claim-free.
 *
 * Deterministic child ids (`<parentId>:split:<n>`) make a replayed split of
 * the same parent idempotent-by-collision (the already-split guard fires
 * first) and make prod data-migration SQL reproducible.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface SplitUnitInput {
  /** Signed decimal amount, e.g. "1917.70" or "-256.00". */
  amount: string;
  /** Defaults to the parent's payerName. */
  payerName?: string | null;
  /** Defaults to the parent's lineDescription. */
  lineDescription?: string | null;
  /** Defaults to the parent's dateReceived (YYYY-MM-DD). */
  dateReceived?: string | null;
}

export function splitUnitId(parentId: string, n: number): string {
  return `${parentId}:split:${n}`;
}

function toCents(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

/** Child rows a parent currently has, ordered by id (deterministic). */
async function childrenOf(tx: Tx, parentId: string) {
  return tx
    .select({
      id: stagedPayments.id,
      amount: stagedPayments.amount,
      payerName: stagedPayments.payerName,
      dateReceived: stagedPayments.dateReceived,
    })
    .from(stagedPayments)
    .where(eq(stagedPayments.splitParentId, parentId))
    .orderBy(asc(stagedPayments.id))
    .for("update");
}

/** Ids among `rowIds` that carry ANY claim: a cash application, a settled
 * payout pairing (settled_stripe_payout_id), or a source_link (any
 * type/lifecycle) naming them. */
async function claimedIdsAmong(tx: Tx, rowIds: string[]): Promise<Set<string>> {
  if (rowIds.length === 0) return new Set();
  const [apps, setl, links] = await Promise.all([
    tx
      .select({ id: paymentApplications.paymentId })
      .from(paymentApplications)
      .where(inArray(paymentApplications.paymentId, rowIds)),
    tx
      .select({ id: stagedPayments.id })
      .from(stagedPayments)
      .where(
        and(
          inArray(stagedPayments.id, rowIds),
          isNotNull(stagedPayments.settledStripePayoutId),
        ),
      ),
    tx
      .select({ id: sourceLinks.qbStagedPaymentId })
      .from(sourceLinks)
      .where(inArray(sourceLinks.qbStagedPaymentId, rowIds)),
  ]);
  const out = new Set<string>();
  for (const r of [...apps, ...setl, ...links]) {
    if (r.id != null) out.add(r.id);
  }
  return out;
}

export interface SplitUnitsResult {
  parentId: string;
  children: {
    id: string;
    amount: string;
    payerName: string | null;
    dateReceived: string | null;
  }[];
}

export async function splitStagedPaymentIntoUnits(
  tx: Tx,
  parentId: string,
  units: SplitUnitInput[],
): Promise<SplitUnitsResult> {
  const [parent] = await tx
    .select()
    .from(stagedPayments)
    .where(eq(stagedPayments.id, parentId))
    .for("update");
  if (!parent) {
    throw new ReconcileAbort(404, { error: "staged payment not found" });
  }
  if (parent.splitParentId != null) {
    throw new ReconcileAbort(409, {
      error: "consistency_gate",
      code: "split_nested",
      message:
        "This row is itself a synthetic split unit — units cannot be split again. Unsplit the original QuickBooks row and re-split it differently instead.",
    });
  }
  // A whole-deposit header (deposit_header) exists ONLY as settlement
  // evidence — its money is already counted on the deposit's underlying
  // Payment rows. Split children would look reconcilable and invite
  // double-counting, so headers are never splittable.
  if (parent.qbEntityType === "deposit_header") {
    throw new ReconcileAbort(409, {
      error: "consistency_gate",
      code: "deposit_header_not_splittable",
      message:
        "This row is a whole-deposit header: its money is already counted on the deposit's underlying payment rows, so it cannot be split into units.",
    });
  }
  const existing = await childrenOf(tx, parentId);
  if (existing.length > 0) {
    throw new ReconcileAbort(409, {
      error: "consistency_gate",
      code: "already_split",
      message:
        "This QuickBooks row is already split into units. Unsplit it first to change the breakdown.",
      childIds: existing.map((c) => c.id),
    });
  }
  const parentCents = toCents(parent.amount);
  if (parentCents == null) {
    throw new ReconcileAbort(409, {
      error: "consistency_gate",
      code: "no_amount",
      message: "This QuickBooks row has no amount to split.",
    });
  }
  if (units.length < 2) {
    throw new ReconcileAbort(400, {
      error: "at least 2 units are required for a split",
    });
  }
  const unitCents = units.map((u) => toCents(u.amount));
  if (unitCents.some((c) => c == null || c === 0)) {
    throw new ReconcileAbort(400, {
      error: "every unit needs a non-zero decimal amount",
    });
  }
  const sum = (unitCents as number[]).reduce((a, b) => a + b, 0);
  if (sum !== parentCents) {
    throw new ReconcileAbort(409, {
      error: "consistency_gate",
      code: "split_sum_mismatch",
      message: `Unit amounts must sum to exactly the QuickBooks amount: units total $${(sum / 100).toFixed(2)}, the row is $${(parentCents / 100).toFixed(2)}.`,
      unitTotal: (sum / 100).toFixed(2),
      parentAmount: (parentCents / 100).toFixed(2),
    });
  }

  // A parent with a live claim already tells a money story — splitting it
  // would fork that story. Confirmed claims block; PROPOSED machine guesses
  // are cleared below (the human split is the stronger statement).
  const [apps, setl, confirmedLinks] = await Promise.all([
    tx
      .select({ id: paymentApplications.id })
      .from(paymentApplications)
      .where(eq(paymentApplications.paymentId, parentId))
      .limit(1),
    tx
      .select({ id: stagedPayments.id })
      .from(stagedPayments)
      .where(
        and(
          eq(stagedPayments.id, parentId),
          isNotNull(stagedPayments.settledStripePayoutId),
        ),
      )
      .limit(1),
    tx
      .select({ id: sourceLinks.id })
      .from(sourceLinks)
      .where(
        and(
          eq(sourceLinks.qbStagedPaymentId, parentId),
          sql`${sourceLinks.lifecycle} <> 'proposed'`,
        ),
      )
      .limit(1),
  ]);
  if (apps.length || setl.length || confirmedLinks.length) {
    throw new ReconcileAbort(409, {
      error: "consistency_gate",
      code: "parent_has_claims",
      message:
        "This QuickBooks row already carries reconciliation evidence (a linked gift, settlement, or confirmed Stripe tie). Revert those first, then split.",
    });
  }
  await tx
    .delete(sourceLinks)
    .where(
      and(
        eq(sourceLinks.qbStagedPaymentId, parentId),
        eq(sourceLinks.lifecycle, "proposed"),
      ),
    );

  const rows = units.map((u, i) => ({
    id: splitUnitId(parentId, i + 1),
    splitParentId: parentId,
    realmId: parent.realmId,
    qbEntityType: parent.qbEntityType,
    // qbEntityId stays NULL (synthetic unit — the CHECK enforces the shape).
    qbDepositId: parent.qbDepositId,
    amount: u.amount,
    dateReceived: u.dateReceived ?? parent.dateReceived,
    payerName: u.payerName ?? parent.payerName,
    lineDescription: u.lineDescription ?? parent.lineDescription,
    qbDepositToAccountName: parent.qbDepositToAccountName,
    // Pin the classifier: a synthetic unit's review status is human-owned —
    // the re-runnable auto-classifier must never exclude it (a NEGATIVE unit
    // like a clawed-back failed payout would otherwise be swept as a fee).
    classificationSource: "manual" as const,
    // Keep the parent's Wildflower-entity attribution, pinned for the same
    // reason (detectEntity must not re-derive it from synthetic fields).
    entityId: parent.entityId,
    entitySource: "manual" as const,
  }));
  const inserted = await tx.insert(stagedPayments).values(rows).returning({
    id: stagedPayments.id,
    amount: stagedPayments.amount,
    payerName: stagedPayments.payerName,
    dateReceived: stagedPayments.dateReceived,
  });
  return {
    parentId,
    children: inserted.map((c) => ({
      id: c.id,
      amount: c.amount ?? "0.00",
      payerName: c.payerName,
      dateReceived: c.dateReceived,
    })),
  };
}

export interface UnsplitResult {
  parentId: string;
  removedChildIds: string[];
}

export async function revertStagedPaymentSplitUnits(
  tx: Tx,
  parentId: string,
): Promise<UnsplitResult> {
  const [parent] = await tx
    .select({ id: stagedPayments.id })
    .from(stagedPayments)
    .where(eq(stagedPayments.id, parentId))
    .for("update");
  if (!parent) {
    throw new ReconcileAbort(404, { error: "staged payment not found" });
  }
  const children = await childrenOf(tx, parentId);
  if (children.length === 0) {
    throw new ReconcileAbort(409, {
      error: "consistency_gate",
      code: "not_split",
      message: "This QuickBooks row is not split into units.",
    });
  }
  const childIds = children.map((c) => c.id);
  const claimed = await claimedIdsAmong(tx, childIds);
  if (claimed.size > 0) {
    throw new ReconcileAbort(409, {
      error: "consistency_gate",
      code: "split_children_claimed",
      message:
        "Some units already carry reconciliation evidence (a tie, settlement, or linked gift). Revert those first, then unsplit.",
      claimedChildIds: [...claimed],
    });
  }
  // Hard delete is the DOCUMENTED exception here (replit.md invariant 8):
  // the children are synthetic CRM-created units with zero claims — deleting
  // them restores the parent exactly; nothing external references them.
  await tx.delete(stagedPayments).where(inArray(stagedPayments.id, childIds));
  return { parentId, removedChildIds: childIds };
}
