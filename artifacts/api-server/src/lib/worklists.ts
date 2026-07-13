import {
  opportunitiesAndPledges,
  giftsAndPayments,
  giftAllocations,
  pledgeAllocations,
  stagedPayments,
  stripeStagedCharges,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { stagedStatusWhere, chargeStatusWhere } from "./derivedStatus";

// ───────────────────────────────────────────────────────────────────────────
// Donor-lifecycle worklists ("what hasn't been done yet").
//
// These predicate builders are the SINGLE source of truth for each worklist so
// the filtered-list routes (opportunities / gifts) and the dashboard worklist
// counts can never drift apart. Each returns an array of drizzle SQL predicates
// to be AND-ed into a WHERE clause.
//
// Correlated-subquery note: interpolating a real table column (e.g.
// `opportunitiesAndPledges.id`) into a sql`` template renders it qualified by
// the actual table name, so the references below bind to the OUTER row even
// inside a sub-SELECT over another table. (This mirrors the existing
// paidPresence subquery in the opportunities route.)
// ───────────────────────────────────────────────────────────────────────────

export const OPP_WORKLISTS = ["verbal_no_letter", "committed_unpaid", "partially_paid"] as const;
export type OppWorklist = (typeof OPP_WORKLISTS)[number];

export const GIFT_WORKLISTS = ["missing_allocations"] as const;
export type GiftWorklist = (typeof GIFT_WORKLISTS)[number];

// SUM of non-archived recorded payments against an opportunity.
const oppPaidSum = sql`(SELECT COALESCE(SUM(gp.amount), 0) FROM gifts_and_payments gp WHERE gp.opportunity_id = ${opportunitiesAndPledges.id} AND gp.archived_at IS NULL)`;

/**
 * Predicates for an opportunity/pledge worklist. Does NOT include the
 * archived-row filter — callers apply their own (the list route honors the
 * admin "show archived" toggle; the dashboard always excludes archived).
 */
export function oppWorklistConds(worklist: OppWorklist): SQL[] {
  switch (worklist) {
    case "verbal_no_letter":
      // A verbal yes with no recorded written commitment yet.
      return [
        eq(opportunitiesAndPledges.stage, "verbal_confirmation"),
        eq(opportunitiesAndPledges.writtenPledge, false),
        isNull(opportunitiesAndPledges.grantLetterUrl),
        eq(opportunitiesAndPledges.status, "open"),
      ];
    case "committed_unpaid":
      // A written pledge nothing has been paid against yet.
      return [eq(opportunitiesAndPledges.status, "pledge"), sql`${oppPaidSum} <= 0`];
    case "partially_paid":
      // A pledge with some money in but not fully paid. A fully-paid pledge
      // flips to status=cash_in, so status=pledge + paid>0 ⇒ paid < awarded.
      return [eq(opportunitiesAndPledges.status, "pledge"), sql`${oppPaidSum} > 0`];
  }
}

/** Predicates for a gift worklist. (Archived filter applied by the caller.) */
export function giftWorklistConds(worklist: GiftWorklist): SQL[] {
  switch (worklist) {
    case "missing_allocations":
      // ALL money scope lives on allocation rows, so a gift with none is
      // uncoded/unattributed and needs allocation work.
      return [
        sql`NOT EXISTS (SELECT 1 FROM ${giftAllocations} WHERE ${giftAllocations.giftId} = ${giftsAndPayments.id})`,
      ];
  }
}

// ─── Entity scoping (mirrors the global entity filter on each list route) ────

/** Opportunity is in-scope when it has an allocation pinned to one of `entityIds`. */
export function oppEntityScope(entityIds: string[]): SQL | undefined {
  if (entityIds.length === 0) return undefined;
  return sql`EXISTS (SELECT 1 FROM ${pledgeAllocations} WHERE ${pledgeAllocations.pledgeOrOpportunityId} = ${opportunitiesAndPledges.id} AND ${inArray(pledgeAllocations.entityId, entityIds)})`;
}

/** Gift is in-scope when it has an allocation pinned to one of `entityIds`. */
export function giftEntityScope(entityIds: string[]): SQL | undefined {
  if (entityIds.length === 0) return undefined;
  return sql`EXISTS (SELECT 1 FROM ${giftAllocations} WHERE ${giftAllocations.giftId} = ${giftsAndPayments.id} AND ${inArray(giftAllocations.entityId, entityIds)})`;
}

// ─── Dashboard count predicates (always exclude archived) ───────────────────

/** Full WHERE for a dashboard opportunity worklist count (entity-scoped). */
export function oppWorklistCountWhere(worklist: OppWorklist, entityIds: string[]): SQL {
  const parts: SQL[] = [
    ...oppWorklistConds(worklist),
    isNull(opportunitiesAndPledges.archivedAt),
  ];
  const scope = oppEntityScope(entityIds);
  if (scope) parts.push(scope);
  return and(...parts)!;
}

/** Full WHERE for the dashboard gifts-missing-allocations count (entity-scoped). */
export function giftWorklistCountWhere(worklist: GiftWorklist, entityIds: string[]): SQL {
  const parts: SQL[] = [...giftWorklistConds(worklist), isNull(giftsAndPayments.archivedAt)];
  const scope = giftEntityScope(entityIds);
  if (scope) parts.push(scope);
  return and(...parts)!;
}

/**
 * WHERE for the staged-money worklist count on a given staged table. "Not yet
 * processed" = DERIVED status still 'pending' (lib/derivedStatus.ts — no stored
 * status column exists). `staged_payments` is entity-scoped via its `entity_id`
 * column; `stripe_staged_charges` has no entity column, so pass
 * `entityScoped: false` for it.
 */
export function stagedPendingWhere(
  table: typeof stagedPayments | typeof stripeStagedCharges,
  entityIds: string[],
  entityScoped: boolean,
): SQL {
  const parts: SQL[] = [
    table === stagedPayments
      ? stagedStatusWhere.pending
      : chargeStatusWhere.pending,
  ];
  if (entityScoped && entityIds.length > 0) {
    parts.push(inArray((table as typeof stagedPayments).entityId, entityIds));
  }
  return and(...parts)!;
}
