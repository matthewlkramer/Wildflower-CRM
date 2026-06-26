import { type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  stagedPayments,
  stagedPaymentSplits,
  giftsAndPayments,
  organizations,
  households,
  people,
  paymentIntermediaries,
  quickbooksHandlingRules,
  entities,
} from "@workspace/db/schema";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNull,
  not,
  or,
  sql,
} from "drizzle-orm";
import { alias, type PgSelect } from "drizzle-orm/pg-core";
import { getAppUser } from "../../lib/appRequest";
import { type InvariantIssue } from "@workspace/api-zod";
import {
  unstampGiftFinalAmount,
  adjustSingleAllocationOrFlag,
} from "../../lib/giftFinalAmount";
import { applyGiftQbTieMany } from "../../lib/giftQbTie";
import {
  removePaymentApplicationsForGift,
  removePaymentApplicationsForPayment,
  qbLedgerExistsForGift,
  qbLedgerExistsForGiftExcludingPayment,
  qbLedgerPaymentIdForGiftExcludingPayment,
  DEFAULT_GIFT_ID_SQL,
} from "../../lib/paymentApplications";

export function requireAdmin(req: Request, res: Response): boolean {
  const me = getAppUser(req);
  if (!me || me.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return false;
  }
  return true;
}

export function respondInvariantFailure(
  res: Response,
  issues: InvariantIssue[],
): void {
  res.status(400).json({
    error: "validation_error",
    message: "Request validation failed",
    details: {
      issues: issues.map((i) => ({ path: [i.path], message: i.message })),
    },
  });
}

// The gift a staged row resolved to (reconciled OR minted), for display.
export const resolvedGift = alias(giftsAndPayments, "resolved_gift");
// The handling rule that auto-classified this row (excluded / auto-approved), for display.
export const matchedRule = alias(quickbooksHandlingRules, "matched_rule");

// Fiscally sponsored Wildflower entities. Money attributed to one of these is
// pass-through for a sponsored project, not a Foundation gift, so it is parked
// in its own "Fiscally sponsored" queue and kept OUT of the default needs-review
// queue to avoid cluttering day-to-day reconciliation. Entity ATTRIBUTION itself
// lives in ENTITY_MARKERS / detectEntity (quickbooksExclusionRules.ts); this list
// only decides which already-attributed entities get parked. Extend it to park
// another sponsored entity. Code-only by design — no data migration is needed
// because staged_payments.entity_id is already populated.
export const FISCALLY_SPONSORED_ENTITY_IDS: readonly string[] = [
  "embracing_equity",
  "tierra_indigena",
];

// SQL predicate: this staged row is attributed to a fiscally sponsored entity.
// inArray (never ANY(...::text[]) — that renders a record cast that fails at
// runtime) so a NULL entity_id (the Foundation default) is correctly NOT matched.
// Exported so the reconciliation cards flow can park these same rows out of its
// default "live work" queue (mirroring the legacy needs_review split here).
export const isFiscallySponsoredRow = inArray(stagedPayments.entityId, [
  ...FISCALLY_SPONSORED_ENTITY_IDS,
]);

// A staged row with no gift yet (neither a manually-matched nor a minted gift,
// and not group-reconciled into someone else's gift). Used to scope the
// fiscally-sponsored worklist to receipts that still NEED a hand-made gift.
export const hasNoGiftLink = sql`(
  ${stagedPayments.matchedGiftId} IS NULL
  AND ${stagedPayments.createdGiftId} IS NULL
  AND ${stagedPayments.groupReconciledGiftId} IS NULL
)`;

// The fiscally-sponsored money that is PARKED out of the main reconciliation flow
// and surfaced in the "Fiscally-sponsored without corresponding gift" worklist:
// sponsored receipts that still lack a gift. Sponsored money that already matches
// a gift is NOT parked — it reconciles normally in the main flow (entity set).
export const isParkedFiscallyRow = sql`(${isFiscallySponsoredRow} AND ${hasNoGiftLink})`;

// Derived queue bucket for a staged row (kept in sync with the where-clauses
// in queueWhere below).
export const queueExpr = sql<string>`
  CASE
    WHEN ${stagedPayments.status} = 'excluded' THEN 'excluded'
    WHEN ${stagedPayments.status} = 'rejected' THEN 'rejected'
    WHEN ${stagedPayments.status} = 'pending' AND ${isParkedFiscallyRow} THEN 'fiscally_sponsored'
    WHEN ${stagedPayments.status} = 'pending'  THEN 'needs_review'
    WHEN ${stagedPayments.status} = 'approved'
         AND ${stagedPayments.autoApplied} = true
         AND ${stagedPayments.matchConfirmedAt} IS NULL THEN 'auto_matched'
    ELSE 'done'
  END
`.as("queue");

// Donor + resolved-gift + intermediary display fields joined for the queue UI.
// The verbatim raw QB JSON (qbRaw / qbRawLine) is stored for audit but excluded
// from every list/detail response — it is large and never needed by the UI.
// `syncGap` is retired and `countsTowardGoal` now lives ONLY on gift_allocations;
// both are kept @deprecated in the Drizzle schema for the deferred prod DROP, so
// they must be stripped here alongside the audit-only raw JSON or the shared
// staged projection (consumed by the QuickBooks queue + reconciliation cards)
// would leak them into list/detail responses.
const {
  qbRaw: _qbRaw,
  qbRawLine: _qbRawLine,
  syncGap: _deprecatedSyncGap,
  countsTowardGoal: _deprecatedStagedCountsTowardGoal,
  ...stagedColumns
} = getTableColumns(stagedPayments);

// Staged-row projection for the mutation endpoints that echo the freshly-updated
// row directly (match / unmatch / revert + the actions.ts staged actions). Unlike
// `stagedSelect` (the joined list/card projection) it KEEPS qbRaw/qbRawLine — the
// historical raw-return shape of those endpoints — and only drops the two
// deprecated columns: `syncGap` (retired) and `countsTowardGoal` (now
// allocation-only). Both stay @deprecated in the schema for the deferred prod
// DROP, so this is the single source that keeps them out of every raw staged
// mutation response.
const {
  syncGap: _deprecatedRetSyncGap,
  countsTowardGoal: _deprecatedRetCountsTowardGoal,
  ...stagedReturnColumns
} = getTableColumns(stagedPayments);
export { stagedReturnColumns };
export type StagedReturnRow = Omit<
  typeof stagedPayments.$inferSelect,
  "syncGap" | "countsTowardGoal"
>;
export const stagedSelect = {
  ...stagedColumns,
  queue: queueExpr,
  organizationName: organizations.name,
  householdName: households.name,
  individualGiverPersonName: sql<string | null>`
    COALESCE(
      NULLIF(TRIM(${people.fullName}), ''),
      NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
    )
  `.as("individual_giver_person_name"),
  intermediaryName: paymentIntermediaries.name,
  entityName: entities.name,
  resolvedGiftId: resolvedGift.id,
  resolvedGiftName: resolvedGift.name,
  resolvedGiftAmount: resolvedGift.amount,
  resolvedGiftDate: resolvedGift.dateReceived,
  // Fiscal-year slug (grantYear) of the resolved gift's header, for the card's
  // CRM-gift side.
  resolvedGiftFiscalYear: resolvedGift.grantYear,
  // Intended-usage rollup of the resolved gift's allocation lines (entity +
  // usage label + restriction), so a reviewer can judge the match on the card.
  // Correlated on the staged row's gift-link COLUMNS (matched/created/group),
  // NOT on the resolvedGift alias — a bare aliased column interpolated into a
  // correlated subquery renders unqualified and would bind to the inner table.
  resolvedGiftAllocations: sql<
    | {
        entityName: string | null;
        usageLabel: string | null;
        regionalRestrictionType: string;
        usageRestrictionType: string;
        timeRestrictionType: string;
      }[]
    | null
  >`(
    SELECT jsonb_agg(
      jsonb_build_object(
        'entityName', e.name,
        'usageLabel', COALESCE(NULLIF(ga.display_usage, ''), ga.intended_usage::text),
        'regionalRestrictionType', ga.regional_restriction_type::text,
        'usageRestrictionType', ga.usage_restriction_type::text,
        'timeRestrictionType', ga.time_restriction_type::text
      ) ORDER BY ga.created_at, ga.id
    )
    FROM gift_allocations ga
    LEFT JOIN entities e ON e.id = ga.entity_id
    WHERE ga.gift_id = COALESCE(
      ${stagedPayments.matchedGiftId},
      ${stagedPayments.createdGiftId},
      ${stagedPayments.groupReconciledGiftId}
    )
  )`.as("resolved_gift_allocations"),
  // Split summary: when a staged row is split across several existing gifts its
  // resolution lives entirely in staged_payment_splits (resolvedGift above is
  // null because no single matched/created/group gift is set). These correlated
  // subqueries surface the count, combined gross total, and gift names so the UI
  // can render "Split across N gifts · $total". 0/null when not split.
  splitCount: sql<number>`(
    SELECT COUNT(*)::int FROM staged_payment_splits sps
    WHERE sps.staged_payment_id = ${stagedPayments.id}
  )`.as("split_count"),
  splitTotal: sql<string | null>`(
    SELECT SUM(sps.sub_amount) FROM staged_payment_splits sps
    WHERE sps.staged_payment_id = ${stagedPayments.id}
  )`.as("split_total"),
  splitGiftNames: sql<string[] | null>`(
    SELECT array_agg(g.name ORDER BY g.name)
    FROM staged_payment_splits sps
    JOIN gifts_and_payments g ON g.id = sps.gift_id
    WHERE sps.staged_payment_id = ${stagedPayments.id}
  )`.as("split_gift_names"),
  matchedRuleName: matchedRule.name,
  // Top-level QuickBooks LinkedTxn (e.g. the Deposit a Payment was deposited
  // into) — derived READ-ONLY from the stored raw QB payload, never written onto
  // the staged row. Surfaced for reference only. Line-level LinkedTxn (the
  // invoices / credit memos / journal entries a payment applies to) already
  // ships in qbLinkedTxn.
  qbDepositLinks: sql<{ txnId: string; txnType: string }[] | null>`(
    SELECT jsonb_agg(jsonb_build_object('txnId', lt->>'TxnId', 'txnType', lt->>'TxnType'))
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(${stagedPayments.qbRaw} -> 'LinkedTxn') = 'array'
        THEN ${stagedPayments.qbRaw} -> 'LinkedTxn'
        ELSE '[]'::jsonb END
    ) lt
    WHERE lt->>'TxnType' = 'Deposit'
  )`.as("qb_deposit_links"),
  // QuickBooks Location/Department (DepartmentRef.name) tagged on the
  // transaction, captured at pull time as a read-only QB fact. E.g.
  // "National:Foundation Operations". Null when none is tagged.
  qbLocation: stagedPayments.qbLocation,
  // "Gift likely not created yet": this row has no gift of its own, and every
  // same-donor / similar-amount gift is already linked to a DIFFERENT staged
  // payment (no unlinked candidate is left to match). Signals the fundraiser to
  // create a new gift (or exclude a true duplicate) rather than trusting a high
  // match score that points at an already-claimed gift.
  giftAlreadyLinkedElsewhere: sql<boolean>`(
    ${stagedPayments.matchedGiftId} IS NULL
    AND ${stagedPayments.createdGiftId} IS NULL
    AND ${stagedPayments.amount} IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM gifts_and_payments g
      WHERE (
        (${stagedPayments.organizationId} IS NOT NULL AND g.organization_id = ${stagedPayments.organizationId})
        OR (${stagedPayments.individualGiverPersonId} IS NOT NULL AND g.individual_giver_person_id = ${stagedPayments.individualGiverPersonId})
        OR (${stagedPayments.householdId} IS NOT NULL AND g.household_id = ${stagedPayments.householdId})
      )
      AND g.amount >= ${stagedPayments.amount}::numeric - 0.01
      AND g.amount <= ${stagedPayments.amount}::numeric * 1.10 + 1
      AND ${qbLedgerExistsForGiftExcludingPayment(
        sql.raw("g.id"),
        sql.raw('"staged_payments"."id"'),
      )}
    )
    AND NOT EXISTS (
      SELECT 1 FROM gifts_and_payments g2
      WHERE (
        (${stagedPayments.organizationId} IS NOT NULL AND g2.organization_id = ${stagedPayments.organizationId})
        OR (${stagedPayments.individualGiverPersonId} IS NOT NULL AND g2.individual_giver_person_id = ${stagedPayments.individualGiverPersonId})
        OR (${stagedPayments.householdId} IS NOT NULL AND g2.household_id = ${stagedPayments.householdId})
      )
      AND g2.amount >= ${stagedPayments.amount}::numeric - 0.01
      AND g2.amount <= ${stagedPayments.amount}::numeric * 1.10 + 1
      AND NOT ${qbLedgerExistsForGift(sql.raw("g2.id"))}
    )
  )`.as("gift_already_linked_elsewhere"),
};

export function withJoins<T extends PgSelect>(q: T) {
  return q
    .leftJoin(organizations, eq(organizations.id, stagedPayments.organizationId))
    .leftJoin(households, eq(households.id, stagedPayments.householdId))
    .leftJoin(people, eq(people.id, stagedPayments.individualGiverPersonId))
    .leftJoin(
      paymentIntermediaries,
      eq(paymentIntermediaries.id, stagedPayments.matchedPaymentIntermediaryId),
    )
    .leftJoin(
      resolvedGift,
      sql`${resolvedGift.id} = COALESCE(${stagedPayments.matchedGiftId}, ${stagedPayments.createdGiftId}, ${stagedPayments.groupReconciledGiftId})`,
    )
    .leftJoin(matchedRule, eq(matchedRule.id, stagedPayments.matchedRuleId))
    .leftJoin(entities, eq(entities.id, stagedPayments.entityId));
}

// Default-entity sentinel: the queue treats unattributed rows (entity_id NULL —
// no distinctive marker) as belonging to the Wildflower Foundation, so filtering
// by the Foundation matches both rows explicitly attributed to it AND the NULLs.
export const FOUNDATION_ENTITY_ID = "wildflower_foundation";

// Restrict the queue to one Wildflower entity. "" / "all" → no restriction;
// the Foundation id also catches unattributed (NULL) rows; any other id is an
// exact match. Returns undefined when no entity restriction applies.
export function entityWhere(entity: string) {
  if (!entity || entity === "all") return undefined;
  if (entity === FOUNDATION_ENTITY_ID) {
    return sql`(${stagedPayments.entityId} IS NULL OR ${stagedPayments.entityId} = ${FOUNDATION_ENTITY_ID})`;
  }
  return eq(stagedPayments.entityId, entity);
}

export type Queue =
  | "needs_review"
  | "fiscally_sponsored"
  | "auto_matched"
  | "excluded"
  | "done"
  | "rejected";

export const STAGED_SORTS = [
  "date_desc",
  "date_asc",
  "amount_desc",
  "amount_asc",
  "payer_asc",
  "payer_desc",
] as const;
export type StagedSort = (typeof STAGED_SORTS)[number];

// Column ordering for the reconciler's sort dropdown. createdAt is the stable
// tiebreak so paging is deterministic within a sort key.
export function stagedOrderBy(sort: StagedSort) {
  switch (sort) {
    case "date_asc":
      return [asc(stagedPayments.dateReceived), desc(stagedPayments.createdAt)];
    case "amount_desc":
      return [desc(stagedPayments.amount), desc(stagedPayments.createdAt)];
    case "amount_asc":
      return [asc(stagedPayments.amount), desc(stagedPayments.createdAt)];
    case "payer_asc":
      return [asc(stagedPayments.payerName), desc(stagedPayments.createdAt)];
    case "payer_desc":
      return [desc(stagedPayments.payerName), desc(stagedPayments.createdAt)];
    case "date_desc":
    default:
      return [desc(stagedPayments.dateReceived), desc(stagedPayments.createdAt)];
  }
}

// Escape LIKE/ILIKE wildcards so a user typing "%" or "_" searches for those
// literal characters instead of matching (nearly) everything. PostgreSQL's
// default ILIKE escape character is the backslash, so escaping the input is
// enough — no explicit ESCAPE clause needed.
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Free-text filter for the reconciler's LEFT pane. Matches the payer, the raw
// memo/reference, the single-line description, and any of the line-detail array
// fields (items / accounts / classes). Array columns are flattened with
// array_to_string so a substring match works across all elements at once.
export function stagedSearchWhere(term: string) {
  const like = `%${escapeLike(term)}%`;
  return or(
    ilike(stagedPayments.payerName, like),
    ilike(stagedPayments.rawReference, like),
    ilike(stagedPayments.lineDescription, like),
    sql`array_to_string(COALESCE(${stagedPayments.lineItemNames}, '{}'), ' ') ILIKE ${like}`,
    sql`array_to_string(COALESCE(${stagedPayments.lineAccountNames}, '{}'), ' ') ILIKE ${like}`,
    sql`array_to_string(COALESCE(${stagedPayments.lineClasses}, '{}'), ' ') ILIKE ${like}`,
  );
}

export function queueWhere(queue: Queue) {
  switch (queue) {
    case "auto_matched":
      return and(
        eq(stagedPayments.status, "approved"),
        eq(stagedPayments.autoApplied, true),
        sql`${stagedPayments.matchConfirmedAt} IS NULL`,
      );
    case "done":
      // Human-resolved rows: a confirmed/manual `approved` reconcile-or-mint, OR
      // any `reconciled` row (a row whose gift is now an INDEPENDENT source of
      // truth tied to this evidence — the new reconciliation model). Both are
      // terminal "done" work.
      return or(
        and(
          eq(stagedPayments.status, "approved"),
          sql`(${stagedPayments.matchConfirmedAt} IS NOT NULL OR ${stagedPayments.autoApplied} = false)`,
        ),
        eq(stagedPayments.status, "reconciled"),
      );
    case "excluded":
      return eq(stagedPayments.status, "excluded");
    case "rejected":
      return eq(stagedPayments.status, "rejected");
    case "fiscally_sponsored":
      // The "Fiscally-sponsored without corresponding gift" worklist: pending
      // money attributed to a fiscally sponsored entity that has NO gift yet —
      // parked here so a fundraiser can create the gift by hand. Sponsored money
      // that already matches a gift is NOT parked (it reconciles in the main flow).
      return and(eq(stagedPayments.status, "pending"), isParkedFiscallyRow);
    case "needs_review":
    default:
      // Pending money that is NOT parked-fiscally-sponsored. NULL entity_id
      // (Foundation default) must stay IN — `entity_id NOT IN (...)` is NULL-unsafe,
      // so guard it explicitly with an IS NULL branch. Sponsored money that already
      // has a gift flows here normally (it is not parked).
      return and(
        eq(stagedPayments.status, "pending"),
        or(isNull(stagedPayments.entityId), not(isParkedFiscallyRow)),
      );
  }
}

// Shared candidate-gift select (donor names + already-linked flag).
export function giftCandidateSelect(excludeStagedId: string) {
  // Drop the @deprecated gifts-header counts_toward_goal flag (now allocation-only)
  // so candidate-gift responses don't leak it.
  const { countsTowardGoal: _deprecatedGiftCountsTowardGoal, ...giftHeaderColumns } =
    getTableColumns(giftsAndPayments);
  return {
    ...giftHeaderColumns,
    organizationName: organizations.name,
    householdName: households.name,
    individualGiverPersonName: people.fullName,
    alreadyLinkedStagedPaymentId: qbLedgerPaymentIdForGiftExcludingPayment(
      DEFAULT_GIFT_ID_SQL,
      sql`${excludeStagedId}`,
    ),
  };
}

export function giftCandidateJoins<T extends PgSelect>(q: T) {
  return q
    .leftJoin(
      organizations,
      eq(organizations.id, giftsAndPayments.organizationId),
    )
    .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
    .leftJoin(people, eq(people.id, giftsAndPayments.individualGiverPersonId));
}

// ─── revert helpers ────────────────────────────────────────────────────────
// Undo an approved reconciliation/creation, returning the row to the pending
// queue. Reversible cases:
//   - matchedGiftId set  → clear the link (pre-existing gift untouched).
//   - createdGiftId + autoApplied → delete the auto-minted gift + clear it.
// A MANUALLY created gift (createdGiftId, autoApplied=false) cannot be reverted
// — deleting it would orphan a fundraiser-created ledger row. The donor match
// is left intact so the row can be re-resolved.
const REVERT_NOT_FOUND = "__not_found__";
const REVERT_NOT_REVERTIBLE = "__not_revertible__";

export type RevertOutcome =
  | { ok: true; row: StagedReturnRow | null }
  | { ok: false; reason: "not_found" | "not_revertible" };

// Shared revert transaction used by both the single-row route and the bulk
// route. Returns a structured outcome (instead of throwing for the expected
// not-found / not-revertible cases) so the bulk caller can skip those rows
// without aborting the rest. Each call runs in its OWN transaction so one row's
// rollback never undoes another's revert.
export async function revertOneStagedPayment(
  id: string,
): Promise<RevertOutcome> {
  let result: StagedReturnRow | null = null;
  // Gifts whose QB linkage changed and that still EXIST after the revert (an
  // auto-minted gift is deleted, so it's intentionally not collected). Their
  // persisted tie status is recomputed after the transaction commits.
  const affectedGiftIds = new Set<string>();
  try {
    await db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(stagedPayments)
        .where(eq(stagedPayments.id, id))
        .for("update")
        .then((r) => r[0]);
      if (!locked) throw new Error(REVERT_NOT_FOUND);
      // Revertible terminal states: `approved` (legacy reconcile/mint) and
      // `reconciled` (the new model's evidence-tied-to-an-independent-gift). A
      // `reconciled` deposit lump tied to a Stripe PAYOUT (no matched/created/
      // group gift of its own) falls through every branch below to
      // not-revertible — it is undone via the payout revert, not here.
      if (locked.status !== "approved" && locked.status !== "reconciled") {
        throw new Error(REVERT_NOT_REVERTIBLE);
      }

      // Split-aware: a row resolved by a split has no matched/created/group
      // gift of its own, so it would fall through to the single-row branch and
      // be rejected as not-revertible. Detect it first: delete every split
      // link and return the row to pending. The pre-existing gifts are never
      // touched (no mint happens in a split).
      const splitLinks = await tx
        .select({ id: stagedPaymentSplits.id })
        .from(stagedPaymentSplits)
        .where(eq(stagedPaymentSplits.stagedPaymentId, id));
      if (splitLinks.length > 0) {
        // The pre-existing split-target gifts lose this evidence — recompute.
        const splitGifts = await tx
          .select({ giftId: stagedPaymentSplits.giftId })
          .from(stagedPaymentSplits)
          .where(eq(stagedPaymentSplits.stagedPaymentId, id));
        for (const s of splitGifts) if (s.giftId) affectedGiftIds.add(s.giftId);
        // Ledger cleanup (Phase 2): undo this payment's split cash-applications
        // (the split-target gifts are pre-existing and are never deleted).
        await removePaymentApplicationsForPayment(tx, id);
        await tx
          .delete(stagedPaymentSplits)
          .where(eq(stagedPaymentSplits.stagedPaymentId, id));
        const [row] = await tx
          .update(stagedPayments)
          .set({
            status: "pending",
            matchedGiftId: null,
            createdGiftId: null,
            groupReconciledGiftId: null,
            autoApplied: false,
            matchConfirmedByUserId: null,
            matchConfirmedAt: null,
            approvedByUserId: null,
            approvedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(stagedPayments.id, id))
          .returning(stagedReturnColumns);
        result = row ?? null;
        return;
      }

      // Group-aware: a deposit-group member (incl. the representative, which
      // also carries matchedGiftId) reverts the WHOLE group back to pending.
      // No gift is deleted — a group reconciles to a pre-existing gift, never
      // a minted one. Check this first so the representative isn't handled by
      // the single-row branch (which would orphan the other members).
      if (locked.groupReconciledGiftId != null) {
        const gid = locked.groupReconciledGiftId;
        // The group's pre-existing gift loses this evidence — recompute.
        affectedGiftIds.add(gid);
        // Ledger cleanup (Phase 2): undo every member payment's QB cash-
        // application to the group gift (the gift is pre-existing, not deleted).
        await removePaymentApplicationsForGift(tx, gid);
        const members = await tx
          .select({
            id: stagedPayments.id,
            matchedGiftId: stagedPayments.matchedGiftId,
          })
          .from(stagedPayments)
          .where(eq(stagedPayments.groupReconciledGiftId, gid))
          .for("update");
        // The group gift was stamped (final-amount) from the REPRESENTATIVE
        // member (the one that also carries matchedGiftId = gid). Reverse that
        // stamp before unlinking, restoring the original human amount, then
        // rebalance the gift's single allocation (or flag a multi-alloc gift).
        const repId =
          members.find((m) => m.matchedGiftId === gid)?.id ?? null;
        if (repId) {
          const un = await unstampGiftFinalAmount(tx, gid, {
            source: "quickbooks",
            qbStagedPaymentId: repId,
          });
          if (un.restored) {
            await adjustSingleAllocationOrFlag(
              tx,
              gid,
              un.oldAmount,
              un.newAmount,
              "quickbooks",
            );
          }
        }
        await tx
          .update(stagedPayments)
          .set({
            status: "pending",
            matchedGiftId: null,
            createdGiftId: null,
            groupReconciledGiftId: null,
            autoApplied: false,
            matchConfirmedByUserId: null,
            matchConfirmedAt: null,
            approvedByUserId: null,
            approvedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(stagedPayments.groupReconciledGiftId, gid));
        const [row] = await tx
          .select(stagedReturnColumns)
          .from(stagedPayments)
          .where(eq(stagedPayments.id, id));
        result = row ?? null;
        return;
      }

      const isReconcile = locked.matchedGiftId != null;
      const isAutoMint =
        locked.createdGiftId != null && locked.autoApplied === true;
      if (!isReconcile && !isAutoMint) throw new Error(REVERT_NOT_REVERTIBLE);

      // Reconcile (matched a pre-existing gift): reverse the final-amount stamp
      // before unlinking so the gift falls back to its original human amount,
      // then rebalance allocations. No-op if a later Stripe stamp superseded it.
      if (isReconcile && locked.matchedGiftId) {
        // The pre-existing matched gift loses this evidence — recompute.
        affectedGiftIds.add(locked.matchedGiftId);
        // Ledger cleanup (Phase 2): undo this payment's cash-application to the
        // matched gift (the gift is pre-existing and is never deleted).
        await removePaymentApplicationsForPayment(tx, id);
        const un = await unstampGiftFinalAmount(tx, locked.matchedGiftId, {
          source: "quickbooks",
          qbStagedPaymentId: id,
        });
        if (un.restored) {
          await adjustSingleAllocationOrFlag(
            tx,
            locked.matchedGiftId,
            un.oldAmount,
            un.newAmount,
            "quickbooks",
          );
        }
      }

      if (isAutoMint && locked.createdGiftId) {
        // payment_applications.gift_id is RESTRICT — clear the QB cash-
        // application ledger row(s) booked at mint for this auto-minted gift
        // before deleting it (Phase 2 dual-write books one on auto-create).
        await removePaymentApplicationsForGift(tx, locked.createdGiftId);
        await tx
          .delete(giftsAndPayments)
          .where(eq(giftsAndPayments.id, locked.createdGiftId));
      }

      const [row] = await tx
        .update(stagedPayments)
        .set({
          status: "pending",
          matchedGiftId: null,
          createdGiftId: null,
          autoApplied: false,
          matchConfirmedByUserId: null,
          matchConfirmedAt: null,
          approvedByUserId: null,
          approvedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(stagedPayments.id, id))
        .returning(stagedReturnColumns);
      result = row ?? null;
    });
  } catch (e) {
    if (e instanceof Error && e.message === REVERT_NOT_FOUND) {
      return { ok: false, reason: "not_found" };
    }
    if (e instanceof Error && e.message === REVERT_NOT_REVERTIBLE) {
      return { ok: false, reason: "not_revertible" };
    }
    throw e;
  }
  // Surviving gifts lost their QB linkage — recompute their persisted tie.
  if (affectedGiftIds.size > 0) {
    await applyGiftQbTieMany(...affectedGiftIds);
  }
  return { ok: true, row: result };
}
