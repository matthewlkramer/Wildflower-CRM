import { type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  stagedPayments,
  giftsAndPayments,
  paymentApplications,
  organizations,
  households,
  people,
  paymentIntermediaries,
  quickbooksHandlingRules,
  entities,
  unitGroups,
  unitGroupMembers,
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
  type SQL,
} from "drizzle-orm";
import { alias, type PgSelect } from "drizzle-orm/pg-core";
import { getAppUser } from "../../lib/appRequest";
import { type InvariantIssue } from "@workspace/api-zod";
import {
  removePaymentApplicationsForGift,
  removePaymentApplicationsForPayment,
  qbLedgerExistsForGift,
  qbLedgerExistsForGiftExcludingPayment,
  qbLedgerPaymentIdForGiftExcludingPayment,
  qbLedgerExistsForPayment,
  qbLedgerSoleGiftIdForPayment,
  DEFAULT_GIFT_ID_SQL,
} from "../../lib/paymentApplications";
import { giftMatchAmountBounds } from "../../lib/giftMatch";
import { groupMemberIdsFor } from "../../lib/unitGroupMembership";
import { amountWithinFeeBand } from "../../lib/reconciliationGate";
import { personDisplayNameSql } from "../../lib/personNameSql";
import {
  stagedStatusSql,
  stagedStatusWhere,
  deriveStagedPaymentStatus,
} from "../../lib/derivedStatus";

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

// A staged row with no gift yet — no counted QB cash-application ledger row
// (the SOLE gift-link source: direct, mint, group, and split resolutions all
// anchor counted rows on the payment). Used to scope the fiscally-sponsored
// worklist to receipts that still NEED a hand-made gift.
export const hasNoGiftLink = sql`(NOT ${qbLedgerExistsForPayment()})`;

// The fiscally-sponsored money that is PARKED out of the main reconciliation flow
// and surfaced in the "Fiscally-sponsored without corresponding gift" worklist:
// sponsored receipts that still lack a gift. Sponsored money that already matches
// a gift is NOT parked — it reconciles normally in the main flow (entity set).
export const isParkedFiscallyRow = sql`(${isFiscallySponsoredRow} AND ${hasNoGiftLink})`;

// Alias-parameterized raw twin of isParkedFiscallyRow, for queries that read
// staged_payments through an alias (the drizzle table fragments above render
// unqualified/base-table-qualified there — e.g. the workbench-clusters slim
// UNION). Entity ids are code constants, safe to inline. KEEP IN LOCKSTEP with
// isParkedFiscallyRow: same entity list, same no-counted-QB-ledger-row test.
export const parkedFiscallyExpr = (a: string): string =>
  `(${a}.entity_id IS NOT NULL
    AND ${a}.entity_id IN (${FISCALLY_SPONSORED_ENTITY_IDS.map((id) => `'${id}'`).join(", ")})
    AND NOT EXISTS (
      SELECT 1 FROM payment_applications pa_fs
      WHERE pa_fs.payment_id = ${a}.id
        AND pa_fs.evidence_source = 'quickbooks' AND pa_fs.link_role = 'counted'
    ))`;

// Derived queue bucket for a staged row (kept in sync with the where-clauses
// in queueWhere below). Buckets are a pure re-labeling of the derived status
// (lib/derivedStatus.ts): excluded → excluded, match_proposed → auto_matched,
// pending → needs_review / fiscally_sponsored (parked), match_confirmed → done.
export const queueExpr = sql<string>`
  CASE
    WHEN ${stagedStatusWhere.excluded} THEN 'excluded'
    WHEN ${stagedStatusWhere.match_proposed} THEN 'auto_matched'
    WHEN ${stagedStatusWhere.pending} AND ${isParkedFiscallyRow} THEN 'fiscally_sponsored'
    WHEN ${stagedStatusWhere.pending} THEN 'needs_review'
    ELSE 'done'
  END
`.as("queue");

// Donor + resolved-gift + intermediary display fields joined for the queue UI.
// The verbatim raw QB JSON (qbRaw / qbRawLine) is stored for audit but excluded
// from every list/detail response — it is large and never needed by the UI, so
// the shared staged projection (consumed by the QuickBooks queue + reconciliation
// cards) strips it. (The legacy gift-link columns were dropped — migration
// 0126; the counted payment_applications ledger is the sole gift-link source.)
const {
  qbRaw: _qbRaw,
  qbRawLine: _qbRawLine,
  ...stagedColumns
} = getTableColumns(stagedPayments);

// Staged-row projection for the mutation endpoints that echo the freshly-updated
// row directly (match / unmatch / revert + the actions.ts staged actions). Unlike
// `stagedSelect` (the joined list/card projection) it KEEPS qbRaw/qbRawLine — the
// historical raw-return shape of those endpoints.
export const stagedReturnColumns = getTableColumns(stagedPayments);
export type StagedReturnRow = typeof stagedPayments.$inferSelect;

// Attach the derived status to a raw staged row echoed by a mutation endpoint.
// The counted-ledger EXISTS arm is the SOLE gift-link fact (read cutover), so
// each caller states what it just did to the ledger: link/mint/split echoes
// pass true, revert/unmatch echoes pass false. The settlement-link arm stays
// false — the settlement-only deposit shape is never echoed by these endpoints.
export function stagedRowWithStatus(
  row: StagedReturnRow,
  hasCountedApplication: boolean,
): StagedReturnRow & { status: ReturnType<typeof deriveStagedPaymentStatus> } {
  return {
    ...row,
    status: deriveStagedPaymentStatus({ ...row, hasCountedApplication }),
  };
}
export const stagedSelect = {
  ...stagedColumns,
  // The DERIVED reconciliation status (no stored column exists) — see
  // lib/derivedStatus.ts for the precedence rules.
  status: stagedStatusSql.as("status"),
  queue: queueExpr,
  organizationName: organizations.name,
  householdName: households.name,
  individualGiverPersonName: personDisplayNameSql(people).as(
    "individual_giver_person_name",
  ),
  intermediaryName: paymentIntermediaries.name,
  entityName: entities.name,
  resolvedGiftId: resolvedGift.id,
  resolvedGiftName: resolvedGift.name,
  resolvedGiftAmount: resolvedGift.amount,
  resolvedGiftDate: resolvedGift.dateReceived,
  // Fiscal-year slug (grantYear) of the resolved gift, for the card's CRM-gift
  // side. The deprecated gifts_and_payments.grant_year header column was retired
  // (Task #598); grant_year now lives on the allocation lines, so derive a single
  // representative slug from the earliest non-null allocation. Correlated on the
  // staged row's SOLE ledger gift (counted payment_applications), NOT on the
  // resolvedGift alias — a bare aliased column interpolated into a correlated
  // subquery renders unqualified and would bind to the inner table.
  resolvedGiftFiscalYear: sql<string | null>`(
    SELECT ga.grant_year
    FROM gift_allocations ga
    WHERE ga.gift_id = ${qbLedgerSoleGiftIdForPayment()}
      AND ga.grant_year IS NOT NULL
    ORDER BY ga.created_at, ga.id
    LIMIT 1
  )`.as("resolved_gift_fiscal_year"),
  // Intended-usage rollup of the resolved gift's allocation lines (entity +
  // usage label + restriction), so a reviewer can judge the match on the card.
  // Correlated on the staged row's SOLE ledger gift (counted
  // payment_applications), NOT on the resolvedGift alias — a bare aliased
  // column interpolated into a correlated subquery renders unqualified and
  // would bind to the inner table.
  resolvedGiftAllocations: sql<
    | {
        entityName: string | null;
        usageLabel: string | null;
        regionalRestrictionType: string;
        otherRestrictionType: string;
        timeRestrictionType: string;
      }[]
    | null
  >`(
    SELECT jsonb_agg(
      jsonb_build_object(
        'entityName', e.name,
        'usageLabel', COALESCE(NULLIF(ga.display_usage, ''), ga.intended_usage::text),
        'regionalRestrictionType', ga.regional_restriction_type::text,
        'otherRestrictionType', ga.other_restriction_type::text,
        'timeRestrictionType', ga.time_restriction_type::text
      ) ORDER BY ga.created_at, ga.id
    )
    FROM gift_allocations ga
    LEFT JOIN entities e ON e.id = ga.entity_id
    WHERE ga.gift_id = ${qbLedgerSoleGiftIdForPayment()}
  )`.as("resolved_gift_allocations"),
  // Split summary: when a staged row is split across several existing gifts its
  // resolution lives entirely in counted payment_applications ledger rows
  // anchored to the payment (resolvedGift above is null because
  // qbLedgerSoleGiftIdForPayment returns null for >1 counted rows). These
  // correlated subqueries surface the count, combined gross total, and gift
  // names so the UI can render "Split across N gifts · $total". Gated on the
  // ledger split shape (MORE THAN ONE counted row) so a direct/mint/group row —
  // exactly one counted row — stays 0/null exactly as before. 0/null when not
  // split.
  splitCount: sql<number>`(
    SELECT CASE WHEN COUNT(*) > 1 THEN COUNT(*)::int ELSE 0 END
    FROM payment_applications pa
    WHERE pa.payment_id = ${stagedPayments.id}
      AND pa.evidence_source = 'quickbooks'
      AND pa.link_role = 'counted'
  )`.as("split_count"),
  splitTotal: sql<string | null>`(
    SELECT CASE WHEN COUNT(*) > 1 THEN SUM(pa.amount_applied) END
    FROM payment_applications pa
    WHERE pa.payment_id = ${stagedPayments.id}
      AND pa.evidence_source = 'quickbooks'
      AND pa.link_role = 'counted'
  )`.as("split_total"),
  splitGiftNames: sql<string[] | null>`(
    SELECT CASE WHEN COUNT(*) > 1 THEN array_agg(g.name ORDER BY g.name) END
    FROM payment_applications pa
    JOIN gifts_and_payments g ON g.id = pa.gift_id
    WHERE pa.payment_id = ${stagedPayments.id}
      AND pa.evidence_source = 'quickbooks'
      AND pa.link_role = 'counted'
  )`.as("split_gift_names"),
  // Unit-split lineage (distinct from the gift-split fields above, which fan
  // ONE payment across gifts): a synthetic reconciliation unit points at its
  // original QuickBooks parent row, and a split parent reports how many units
  // it was split into. `split_parent_id IS NOT NULL` is the single authority
  // for "this row is synthetic"; a parent with units derives `excluded` — its
  // money story lives entirely on the units.
  splitUnitParentId: stagedPayments.splitParentId,
  splitUnitCount: sql<number>`(
    SELECT COUNT(*)::int FROM staged_payments ch
    WHERE ch.split_parent_id = ${stagedPayments.id}
  )`.as("split_unit_count"),
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
    NOT ${qbLedgerExistsForPayment()}
    AND ${stagedPayments.amount} IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM gifts_and_payments g
      WHERE (
        (${stagedPayments.organizationId} IS NOT NULL AND g.organization_id = ${stagedPayments.organizationId})
        OR (${stagedPayments.individualGiverPersonId} IS NOT NULL AND g.individual_giver_person_id = ${stagedPayments.individualGiverPersonId})
        OR (${stagedPayments.householdId} IS NOT NULL AND g.household_id = ${stagedPayments.householdId})
      )
      AND ${giftMatchAmountBounds(
        sql.raw("g.amount"),
        sql`${stagedPayments.amount}::numeric`,
        true,
      )}
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
      AND ${giftMatchAmountBounds(
        sql.raw("g2.amount"),
        sql`${stagedPayments.amount}::numeric`,
        true,
      )}
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
      // The SOLE ledger gift (counted payment_applications) — null for a
      // pending row AND for a split (>1 counted rows), matching the legacy
      // single-gift display semantics.
      sql`${resolvedGift.id} = ${qbLedgerSoleGiftIdForPayment()}`,
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
  | "done";

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
// Same field set as `stagedSearchWhere`, but matched against an arbitrary SQL
// ILIKE pattern expression rather than a literal term. Lets a correlated
// subquery search staged payments by a per-row column (e.g. a gift's donor name)
// while keeping the search-field list defined in ONE place (lockstep).
export function stagedSearchWhereExpr(pattern: SQL) {
  return or(
    sql`${stagedPayments.payerName} ILIKE ${pattern}`,
    sql`${stagedPayments.rawReference} ILIKE ${pattern}`,
    sql`${stagedPayments.lineDescription} ILIKE ${pattern}`,
    sql`array_to_string(COALESCE(${stagedPayments.lineItemNames}, '{}'), ' ') ILIKE ${pattern}`,
    sql`array_to_string(COALESCE(${stagedPayments.lineAccountNames}, '{}'), ' ') ILIKE ${pattern}`,
    sql`array_to_string(COALESCE(${stagedPayments.lineClasses}, '{}'), ' ') ILIKE ${pattern}`,
  );
}

export function stagedSearchWhere(term: string) {
  const like = `%${escapeLike(term)}%`;
  return stagedSearchWhereExpr(sql`${like}`);
}

export function queueWhere(queue: Queue) {
  switch (queue) {
    case "auto_matched":
      // System-applied matches awaiting human review.
      return stagedStatusWhere.match_proposed;
    case "done":
      // Booked money — a gift link, a confirmed settlement (deposit lump
      // settled against a Stripe payout), or a counted ledger row (splits).
      return stagedStatusWhere.match_confirmed;
    case "excluded":
      return stagedStatusWhere.excluded;
    case "fiscally_sponsored":
      // The "Fiscally-sponsored without corresponding gift" worklist: pending
      // money attributed to a fiscally sponsored entity that has NO gift yet —
      // parked here so a fundraiser can create the gift by hand. Sponsored money
      // that already matches a gift is NOT parked (it reconciles in the main flow).
      return and(stagedStatusWhere.pending, isParkedFiscallyRow);
    case "needs_review":
    default:
      // Pending money that is NOT parked-fiscally-sponsored. NULL entity_id
      // (Foundation default) must stay IN — `entity_id NOT IN (...)` is NULL-unsafe,
      // so guard it explicitly with an IS NULL branch. Sponsored money that already
      // has a gift flows here normally (it is not parked).
      return and(
        stagedStatusWhere.pending,
        or(isNull(stagedPayments.entityId), not(isParkedFiscallyRow)),
      );
  }
}

// Shared candidate-gift select (donor names + already-linked flag).
export function giftCandidateSelect(excludeStagedId: string) {
  return {
    ...getTableColumns(giftsAndPayments),
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
// queue. The resolution SHAPE is read from the payment_applications ledger
// (the SOLE gift-link source — the legacy matched/created/group columns are
// @deprecated and no longer written). Reversible cases:
//   - split (>1 counted ledger rows) → delete the ledger rows.
//   - group (unit-group member with counted rows) → revert the WHOLE group.
//   - direct match (1 counted row, created_the_gift=false) → clear the link
//     (pre-existing gift untouched).
//   - auto-mint (1 counted row, created_the_gift=true, autoApplied) → delete
//     the auto-minted gift + its ledger rows.
// A MANUALLY created gift (created_the_gift=true, autoApplied=false) cannot be
// reverted — deleting it would orphan a fundraiser-created ledger row. The
// donor match is left intact so the row can be re-resolved.
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
      // Facts-based revertibility (status is derived, never stored): an
      // excluded row is un-excluded via the exclusion actions, not reverted
      // here.
      if (locked.exclusionReason != null) {
        throw new Error(REVERT_NOT_REVERTIBLE);
      }

      // The resolution shape is read from the LEDGER: the counted QB cash-
      // application rows anchored on this payment. No rows ⇒ nothing to
      // revert — a pending row, or a deposit lump whose only resolution is a
      // confirmed settlement link to a Stripe PAYOUT (undone via the payout
      // revert, not here).
      const countedApps = await tx
        .select({
          giftId: paymentApplications.giftId,
          createdTheGift: paymentApplications.createdTheGift,
        })
        .from(paymentApplications)
        .where(
          and(
            eq(paymentApplications.paymentId, id),
            eq(paymentApplications.evidenceSource, "quickbooks"),
            eq(paymentApplications.linkRole, "counted"),
          ),
        );
      if (countedApps.length === 0) throw new Error(REVERT_NOT_REVERTIBLE);

      // Group-aware: a deposit-group member reverts the WHOLE group back to
      // pending. Membership comes from the unit_group_members table; the
      // group's single gift from this member's counted ledger row (every
      // member applies to the SAME pre-existing gift — a group reconciles to
      // an existing gift, never a minted one, so no gift is deleted).
      const groupIds = await groupMemberIdsFor(tx, id);
      if (groupIds.length > 0) {
        const gid = countedApps[0]?.giftId;
        if (!gid) throw new Error(REVERT_NOT_REVERTIBLE);
        // The group's pre-existing gift loses this evidence — recompute.
        affectedGiftIds.add(gid);
        // Every payment whose counted application ties it to the group gift
        // gets its queue facts reset. Collect BEFORE deleting the ledger rows.
        const memberApps = await tx
          .select({ paymentId: paymentApplications.paymentId })
          .from(paymentApplications)
          .where(
            and(
              eq(paymentApplications.giftId, gid),
              eq(paymentApplications.evidenceSource, "quickbooks"),
              eq(paymentApplications.linkRole, "counted"),
            ),
          );
        const memberIds = [
          ...new Set(
            memberApps
              .map((m) => m.paymentId)
              .filter((p): p is string => p != null),
          ),
        ];
        await tx
          .select({ id: stagedPayments.id })
          .from(stagedPayments)
          .where(inArray(stagedPayments.id, memberIds))
          .for("update");
        // The gift's `amount` was never overwritten by reconciliation, so
        // there is no final-amount stamp to unwind (Task #757).
        // Ledger cleanup: undo every member payment's QB cash-application to
        // the group gift (the gift is pre-existing, not deleted).
        await removePaymentApplicationsForGift(tx, gid);
        await tx
          .update(stagedPayments)
          .set({
            autoApplied: false,
            matchConfirmedByUserId: null,
            matchConfirmedAt: null,
            approvedByUserId: null,
            approvedAt: null,
            updatedAt: new Date(),
          })
          .where(inArray(stagedPayments.id, memberIds));
        const [row] = await tx
          .select(stagedReturnColumns)
          .from(stagedPayments)
          .where(eq(stagedPayments.id, id));
        result = row ?? null;
        return;
      }

      // Split: one payment applied across SEVERAL existing gifts (>1 counted
      // rows). Delete the ledger rows and return the row to pending. The
      // pre-existing gifts are never touched — the split's optional remainder
      // gift was minted at split time but is deliberately NOT deleted on
      // revert, matching the pre-ledger behavior.
      if (countedApps.length > 1) {
        // The pre-existing split-target gifts lose this evidence — recompute.
        for (const s of countedApps) if (s.giftId) affectedGiftIds.add(s.giftId);
        // Ledger cleanup: undo this payment's split cash-applications
        // (the split-target gifts are pre-existing and are never deleted).
        await removePaymentApplicationsForPayment(tx, id);
        const [row] = await tx
          .update(stagedPayments)
          .set({
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

      // Exactly one counted ledger row: a direct match to a pre-existing gift
      // (created_the_gift=false), or a mint (created_the_gift=true).
      const app = countedApps[0];
      const gid = app?.giftId;
      if (!app || !gid) throw new Error(REVERT_NOT_REVERTIBLE);
      const isReconcile = !app.createdTheGift;
      const isAutoMint = app.createdTheGift && locked.autoApplied === true;
      // A MANUAL mint (created_the_gift=true, autoApplied=false) is not
      // revertible — deleting it would orphan a fundraiser-created gift.
      if (!isReconcile && !isAutoMint) throw new Error(REVERT_NOT_REVERTIBLE);

      // Reconcile (matched a pre-existing gift): the gift's `amount` was never
      // overwritten by reconciliation, so there is no stamp to unwind (Task #757).
      if (isReconcile) {
        // The pre-existing matched gift loses this evidence — recompute.
        affectedGiftIds.add(gid);
        // Ledger cleanup: undo this payment's cash-application to the matched
        // gift (the gift is pre-existing and is never deleted).
        await removePaymentApplicationsForPayment(tx, id);
      }

      if (isAutoMint) {
        // payment_applications.gift_id is RESTRICT — clear the QB cash-
        // application ledger row(s) booked at mint for this auto-minted gift
        // before deleting it.
        await removePaymentApplicationsForGift(tx, gid);
        await tx.delete(giftsAndPayments).where(eq(giftsAndPayments.id, gid));
      }

      const [row] = await tx
        .update(stagedPayments)
        .set({
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
  return { ok: true, row: result };
}

// ─── eject ONE member from a reconciled group ──────────────────────────────
// The whole-group revert above unwinds EVERY member; ejection removes just one
// wrongly-grouped payment while the rest of the group stays reconciled to the
// gift. The ejected row's counted ledger row is deleted and its queue facts
// reset (donor match kept); the gift's human-entered amount is never rewritten
// (the derived quickbooks_tie_status surfaces a mismatch, and the response
// carries the remaining evidence total + fee-band flag for the operator).
// If ejection leaves fewer than two members the group dissolves — the
// remaining member's counted ledger row is unchanged, so it becomes an
// equivalent DIRECT match (mirrors the ungroup dissolve rule: a lone member is
// not a group).
const EJECT_NOT_FOUND = "__eject_not_found__";
const EJECT_NOT_IN_GROUP = "__eject_not_in_group__";
const EJECT_NOT_RECONCILED = "__eject_not_reconciled__";
const EJECT_LAST_MEMBER = "__eject_last_member__";
const EJECT_EXCLUDED = "__eject_excluded__";

export type EjectOutcome =
  | {
      ok: true;
      row: StagedReturnRow | null;
      giftId: string;
      remainingStagedPaymentIds: string[];
      remainingTotal: string | null;
      giftAmount: string | null;
      remainingInFeeBand: boolean;
      groupDissolved: boolean;
    }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_in_group"
        | "not_reconciled"
        | "last_member"
        | "excluded";
    };

export async function ejectStagedPaymentFromGroup(
  id: string,
): Promise<EjectOutcome> {
  let success: Extract<EjectOutcome, { ok: true }> | null = null;
  try {
    await db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(stagedPayments)
        .where(eq(stagedPayments.id, id))
        .for("update")
        .then((r) => r[0]);
      if (!locked) throw new Error(EJECT_NOT_FOUND);
      // An excluded row is managed via the exclusion actions, never ejected.
      if (locked.exclusionReason != null) throw new Error(EJECT_EXCLUDED);

      // Membership from the SOLE group store (unit_group_members).
      const memberIds = await groupMemberIdsFor(tx, id);
      if (memberIds.length === 0) throw new Error(EJECT_NOT_IN_GROUP);

      // Repo lock order: member staged rows (sorted — groupMemberIdsFor
      // already sorts), then the gift below.
      await tx
        .select({ id: stagedPayments.id })
        .from(stagedPayments)
        .where(inArray(stagedPayments.id, memberIds))
        .for("update");

      // The ejected member's own counted ledger row names the group's gift. No
      // row ⇒ the group is not reconciled yet — dismantle it via ungroup.
      const ownApps = await tx
        .select({ giftId: paymentApplications.giftId })
        .from(paymentApplications)
        .where(
          and(
            eq(paymentApplications.paymentId, id),
            eq(paymentApplications.evidenceSource, "quickbooks"),
            eq(paymentApplications.linkRole, "counted"),
          ),
        );
      const gid = ownApps[0]?.giftId;
      if (!gid) throw new Error(EJECT_NOT_RECONCILED);

      // At least one OTHER member must keep a counted row to the gift —
      // otherwise ejection would strand a reconciled gift with zero evidence;
      // that case is the whole-group revert.
      const otherMemberIds = memberIds.filter((m) => m !== id);
      const otherApps =
        otherMemberIds.length === 0
          ? []
          : await tx
              .select({
                paymentId: paymentApplications.paymentId,
                amountApplied: paymentApplications.amountApplied,
              })
              .from(paymentApplications)
              .where(
                and(
                  inArray(paymentApplications.paymentId, otherMemberIds),
                  eq(paymentApplications.giftId, gid),
                  eq(paymentApplications.evidenceSource, "quickbooks"),
                  eq(paymentApplications.linkRole, "counted"),
                ),
              );
      if (otherApps.length === 0) throw new Error(EJECT_LAST_MEMBER);

      // Lock the gift row (kept, but its evidence set changes).
      const gift = await tx
        .select({ id: giftsAndPayments.id, amount: giftsAndPayments.amount })
        .from(giftsAndPayments)
        .where(eq(giftsAndPayments.id, gid))
        .for("update")
        .then((r) => r[0]);

      // Do NOT unstamp: the remaining members still back the gift's
      // finalAmountSource='quickbooks' provenance, and the QB stamp never
      // rewrote the human-entered amount anyway.

      // Ledger cleanup: only THIS payment's cash-application goes.
      await removePaymentApplicationsForPayment(tx, id);

      // Queue facts reset — back to pending, donor match kept (same shape as
      // the revert paths above).
      const [row] = await tx
        .update(stagedPayments)
        .set({
          autoApplied: false,
          matchConfirmedByUserId: null,
          matchConfirmedAt: null,
          approvedByUserId: null,
          approvedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(stagedPayments.id, id))
        .returning(stagedReturnColumns);

      // Drop the ejected member's group membership; dissolve the group when
      // fewer than two members remain (a lone member is not a group — the
      // survivor's counted row makes it an equivalent direct match).
      const selfMembership = await tx
        .select({ groupId: unitGroupMembers.groupId })
        .from(unitGroupMembers)
        .where(
          and(
            eq(unitGroupMembers.evidenceSource, "quickbooks"),
            eq(unitGroupMembers.sourceId, id),
          ),
        )
        .then((r) => r[0]);
      let groupDissolved = false;
      if (selfMembership) {
        await tx
          .delete(unitGroupMembers)
          .where(
            and(
              eq(unitGroupMembers.evidenceSource, "quickbooks"),
              eq(unitGroupMembers.sourceId, id),
            ),
          );
        const remainingMembers = await tx
          .select({ sourceId: unitGroupMembers.sourceId })
          .from(unitGroupMembers)
          .where(
            and(
              eq(unitGroupMembers.groupId, selfMembership.groupId),
              eq(unitGroupMembers.evidenceSource, "quickbooks"),
            ),
          );
        if (remainingMembers.length < 2) {
          groupDissolved = true;
          await tx
            .delete(unitGroupMembers)
            .where(eq(unitGroupMembers.groupId, selfMembership.groupId));
          await tx
            .delete(unitGroups)
            .where(eq(unitGroups.id, selfMembership.groupId));
        }
      }

      // Touch the gift so list caches see the evidence change.
      await tx
        .update(giftsAndPayments)
        .set({ updatedAt: new Date() })
        .where(eq(giftsAndPayments.id, gid));

      const remainingTotalNum = otherApps.reduce(
        (acc, a) => acc + Number(a.amountApplied ?? 0),
        0,
      );
      const remainingTotal = remainingTotalNum.toFixed(2);
      const giftAmount = gift?.amount ?? null;
      success = {
        ok: true,
        row: row ?? null,
        giftId: gid,
        remainingStagedPaymentIds: [
          ...new Set(
            otherApps
              .map((a) => a.paymentId)
              .filter((p): p is string => p != null),
          ),
        ].sort(),
        remainingTotal,
        giftAmount,
        remainingInFeeBand: amountWithinFeeBand(remainingTotal, giftAmount),
        groupDissolved,
      };
    });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === EJECT_NOT_FOUND)
        return { ok: false, reason: "not_found" };
      if (e.message === EJECT_NOT_IN_GROUP)
        return { ok: false, reason: "not_in_group" };
      if (e.message === EJECT_NOT_RECONCILED)
        return { ok: false, reason: "not_reconciled" };
      if (e.message === EJECT_LAST_MEMBER)
        return { ok: false, reason: "last_member" };
      if (e.message === EJECT_EXCLUDED)
        return { ok: false, reason: "excluded" };
    }
    throw e;
  }
  if (!success) throw new Error("ejectStagedPaymentFromGroup: no outcome");
  return success;
}
