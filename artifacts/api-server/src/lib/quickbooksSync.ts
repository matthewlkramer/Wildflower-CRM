import { db } from "@workspace/db";
import {
  quickbooksConnections,
  stagedPayments,
  giftsAndPayments,
  giftAllocations,
  quickbooksHandlingRules,
  organizations,
  fundableProjects,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "./helpers";
import { logger } from "./logger";
import { withSyncLock } from "./syncLock";
import { getValidQuickbooksAccessToken } from "./quickbooksTokenStore";
import { pullIncomingPayments } from "./quickbooksClient";
import { scoreStagedPayment, type ScoredMatch } from "./quickbooksMatch";
import { classifyStagedPayment, detectEntity } from "./quickbooksExclusionRules";
import { detectFundingSource } from "./quickbooksFundingSource";
import {
  evaluateRules,
  type EngineRule,
  type RuleCondition,
  type RuleMatchLogic,
  type RuleEvalResult,
} from "./quickbooksRules";
import { buildGiftValuesFromStaged } from "./quickbooksGift";
import { applyGiftQbTieMany } from "./giftQbTie";
import { validateGiftInvariants } from "@workspace/api-zod";

/** Postgres unique_violation — a concurrent staged row grabbed this gift first. */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: string }).code === "23505"
  );
}

/**
 * Idempotent upsert of one staged incoming-money UNIT (SalesReceipt / Payment /
 * single Deposit line), keyed on (realmId, qbEntityType, qbEntityId, qbLineId).
 *
 * On conflict (a re-sync of a unit we've already staged) it refreshes ONLY the
 * captured line detail + updatedAt, and only while the row is still
 * pending/excluded — status, classification, donor match and scores are left
 * untouched so a manual override is never clobbered.
 *
 * Crucially, the line-detail refresh is preserve-on-conflict: deposit-derived
 * coding (account / class / memo) is folded onto a Payment/SalesReceipt from the
 * *deposit* that re-records it, and deposits are pulled by the same
 * LastUpdatedTime watermark as everything else. So on an incremental re-sync a
 * Payment can be re-pulled (because it was edited) while its linked deposit is
 * older than the watermark and therefore absent from this pull — leaving the
 * freshly-pulled coding arrays empty. We must NOT let that empty pull clobber
 * coding we already captured on a prior full sync, so each line field keeps the
 * stored value whenever the incoming pull has nothing for it.
 *
 * Returns the drizzle builder so callers can chain `.returning(...)`; exported so
 * the preserve-on-conflict semantics can be asserted in a regression test.
 */
export function buildStagedLineUpsert(
  values: typeof stagedPayments.$inferInsert,
  opts: { enrichAllStatuses?: boolean } = {},
) {
  const set = {
    lineItemNames: sql`CASE WHEN coalesce(cardinality(excluded.line_item_names), 0) > 0 THEN excluded.line_item_names ELSE ${stagedPayments.lineItemNames} END`,
    lineAccountNames: sql`CASE WHEN coalesce(cardinality(excluded.line_account_names), 0) > 0 THEN excluded.line_account_names ELSE ${stagedPayments.lineAccountNames} END`,
    lineClasses: sql`CASE WHEN coalesce(cardinality(excluded.line_classes), 0) > 0 THEN excluded.line_classes ELSE ${stagedPayments.lineClasses} END`,
    lineDescription: sql`coalesce(nullif(excluded.line_description, ''), ${stagedPayments.lineDescription})`,
    // Preserve-on-conflict, mirroring the coding fields: an incremental
    // re-sync may re-pull a Payment whose linked deposit is older than the
    // watermark (and thus absent), leaving qb_deposit_id empty on the
    // incoming row — keep the stored deposit id rather than clobber it.
    qbDepositId: sql`coalesce(excluded.qb_deposit_id, ${stagedPayments.qbDepositId})`,
    // Extended QB capture fields. These are pure read-only mirrors of the QB
    // record (never review state), so an incoming non-null value wins and an
    // absent one keeps the stored value (preserve-on-conflict). They are safe
    // to refresh on any status, which is what the full re-pull relies on.
    qbPayerType: sql`coalesce(excluded.qb_payer_type, ${stagedPayments.qbPayerType})`,
    qbPayerId: sql`coalesce(excluded.qb_payer_id, ${stagedPayments.qbPayerId})`,
    qbPaymentMethod: sql`coalesce(excluded.qb_payment_method, ${stagedPayments.qbPaymentMethod})`,
    qbCheckNumber: sql`coalesce(excluded.qb_check_number, ${stagedPayments.qbCheckNumber})`,
    qbDepositToAccountName: sql`coalesce(excluded.qb_deposit_to_account_name, ${stagedPayments.qbDepositToAccountName})`,
    qbDocNumber: sql`coalesce(excluded.qb_doc_number, ${stagedPayments.qbDocNumber})`,
    qbBillingAddress: sql`coalesce(excluded.qb_billing_address, ${stagedPayments.qbBillingAddress})`,
    qbTransactionMemo: sql`coalesce(excluded.qb_transaction_memo, ${stagedPayments.qbTransactionMemo})`,
    qbCurrency: sql`coalesce(excluded.qb_currency, ${stagedPayments.qbCurrency})`,
    qbExchangeRate: sql`coalesce(excluded.qb_exchange_rate, ${stagedPayments.qbExchangeRate})`,
    qbCreateTime: sql`coalesce(excluded.qb_create_time, ${stagedPayments.qbCreateTime})`,
    qbLinkedTxn: sql`coalesce(excluded.qb_linked_txn, ${stagedPayments.qbLinkedTxn})`,
    qbRaw: sql`coalesce(excluded.qb_raw, ${stagedPayments.qbRaw})`,
    qbRawLine: sql`coalesce(excluded.qb_raw_line, ${stagedPayments.qbRawLine})`,
    // Entity attribution is normally a read-only derived QB fact (like the qb_*
    // mirrors): an incoming non-null attribution wins, an absent one keeps the
    // stored value, so the full re-pull can refresh it without touching review
    // state. The ONE exception is a human-pinned attribution (entity_source =
    // 'manual'): that is review state, so the upsert preserves both the stored
    // entity AND its source instead of letting detectEntity clobber it.
    entityId: sql`CASE WHEN ${stagedPayments.entitySource} = 'manual' THEN ${stagedPayments.entityId} ELSE coalesce(excluded.entity_id, ${stagedPayments.entityId}) END`,
    // Funding source mirrors entity attribution: a derived QB-fact origin that an
    // incoming non-null value refreshes and an absent one preserves — EXCEPT a
    // human-pinned origin (funding_source_provenance = 'manual'), which is review
    // state and survives every re-pull untouched. The provenance column itself is
    // never in this set, so a manual row keeps both its value AND its pin.
    fundingSource: sql`CASE WHEN ${stagedPayments.fundingSourceProvenance} = 'manual' THEN ${stagedPayments.fundingSource} ELSE coalesce(excluded.funding_source, ${stagedPayments.fundingSource}) END`,
    updatedAt: new Date(),
  };

  return db
    .insert(stagedPayments)
    .values(values)
    .onConflictDoUpdate({
      target: [
        stagedPayments.realmId,
        stagedPayments.qbEntityType,
        stagedPayments.qbEntityId,
        stagedPayments.qbLineId,
      ],
      set,
      // Normal sync only refreshes pending/excluded rows so a manual override
      // is never clobbered. The full re-pull (enrichAllStatuses) drops that
      // guard so approved/rejected rows also get the new capture fields — the
      // `set` above only touches read-only QB facts, never review columns, so
      // no approval / match / exclusion / grouping is affected.
      ...(opts.enrichAllStatuses
        ? {}
        : { setWhere: sql`${stagedPayments.status} in ('pending', 'excluded')` }),
    });
}

/**
 * One-way QuickBooks → CRM payment pull. Resolves the active company, pulls
 * incoming-money entities updated since the watermark, stages each incoming
 * UNIT (SalesReceipt / Payment / single Deposit LINE) as a review-queue row
 * (idempotent via the unique index incl. qbLineId), scores it against CRM
 * donors + existing gifts, auto-applies high-confidence matches, and advances
 * the watermark. Pull-only: never writes back to QuickBooks.
 *
 * Per newly-staged, non-excluded row the scored matcher returns a tier:
 *   high      → auto-applied (assumed correct, reversible). Reconcile to the one
 *               same-amount in-window gift if there is exactly one; mint a new
 *               gift if there are none; otherwise leave for review (ambiguous).
 *   suggested → staged pending with a donor hint (matchStatus 'suggested');
 *               nothing applied to the ledger until a human acts.
 *   none      → staged pending + unmatched.
 *
 * Noise (zero / loan / membership / …) is auto-excluded at insert time via the
 * classifier; excluded rows skip scoring entirely.
 *
 * Re-syncs of an already-staged unit do NOT re-classify or change status/donor
 * (so a manual override is never clobbered): they only refresh the captured
 * line detail, and only while still pending/excluded.
 */

// Org-wide lock key — QuickBooks is a single shared company connection.
const QB_LOCK_KEY = "quickbooks-global";

export interface QuickbooksSyncSummary {
  ran: boolean;
  pulled: number;
  staged: number;
  matched: number;
  autoApplied: number;
}

// ─── Background full re-pull state ─────────────────────────────────────────
// A full re-pull walks the entire QuickBooks back-catalog and can take several
// minutes — far longer than a browser/proxy will wait on a single request. So
// the route kicks it off in the background (fire-and-forget) and the UI polls
// `getFullResyncState()` for progress. The state is process-local: QuickBooks is
// a single shared company connection, and the concurrency guard is the advisory
// lock inside `syncQuickbooks`; this flag only drives the UI. If the process
// restarts mid-run the state resets to "idle" and the poller stops cleanly.
export type FullResyncStatus = "idle" | "running" | "done" | "error";

export interface FullResyncState {
  status: FullResyncStatus;
  startedAt: string | null;
  finishedAt: string | null;
  summary: QuickbooksSyncSummary | null;
  error: string | null;
}

let fullResyncState: FullResyncState = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  summary: null,
  error: null,
};

export function getFullResyncState(): FullResyncState {
  return fullResyncState;
}

/**
 * Start a full re-pull in the background and return the current state
 * immediately. If one is already running this is a no-op that returns the
 * in-progress state (the advisory lock is the real guard against concurrent
 * QuickBooks pulls; this only keeps the UI from launching a second poller).
 */
export function startFullResync(): FullResyncState {
  if (fullResyncState.status === "running") return fullResyncState;

  const startedAt = new Date().toISOString();
  fullResyncState = {
    status: "running",
    startedAt,
    finishedAt: null,
    summary: null,
    error: null,
  };

  void (async () => {
    try {
      const summary = await syncQuickbooks({ fullResync: true });
      fullResyncState = {
        status: "done",
        startedAt,
        finishedAt: new Date().toISOString(),
        summary,
        error: null,
      };
      logger.info(
        { pulled: summary.pulled, staged: summary.staged },
        "QuickBooks full re-pull (background) complete",
      );
    } catch (e) {
      fullResyncState = {
        status: "error",
        startedAt,
        finishedAt: new Date().toISOString(),
        summary: null,
        error: e instanceof Error ? e.message : "QuickBooks full re-pull failed",
      };
      logger.error({ err: e }, "QuickBooks full re-pull (background) failed");
    }
  })();

  return fullResyncState;
}

/**
 * Load the admin-editable handling rules into the engine shape. Read once per
 * sync run (not on a hot path) so edits take effect on the NEXT sync without a
 * restart, and queued rows are never reclassified.
 */
async function loadHandlingRules(): Promise<EngineRule[]> {
  const rows = await db.select().from(quickbooksHandlingRules);
  return rows.map((r) => ({
    id: r.id,
    enabled: r.enabled,
    priority: r.priority,
    action: r.action,
    exclusionReason: (r.exclusionReason ??
      null) as EngineRule["exclusionReason"],
    donationGuard: r.donationGuard,
    matchLogic: (r.matchLogic === "all" ? "all" : "any") as RuleMatchLogic,
    conditions: Array.isArray(r.conditions)
      ? (r.conditions as RuleCondition[])
      : [],
    targetOrganizationId: r.targetOrganizationId ?? null,
    targetIntendedUsage: r.targetIntendedUsage ?? null,
    targetFundableProjectId: r.targetFundableProjectId ?? null,
  }));
}

/**
 * Apply an `auto_create_approve` rule to a freshly-staged (pending) row: mint a
 * gift attributed to the rule's target organization, allocate it (target
 * intended usage / fundable project), match the staged row to that gift, and land
 * it in the auto/approved queue (auto_applied = true, so it stays REVERTIBLE).
 *
 * FAIL-SAFE: returns false WITHOUT touching the row when the rule can't be
 * applied cleanly (no/archived donor org; usage='project' with a missing/archived
 * project; non-positive amount; Donor-XOR violation). The caller then falls back
 * to normal scoring so the payment lands in the review queue rather than being
 * silently dropped or mis-minted.
 */
async function applyAutoCreateRule(
  stagedId: string,
  source: Awaited<ReturnType<typeof pullIncomingPayments>>[number],
  rule: Extract<RuleEvalResult, { action: "auto_create_approve" }>,
): Promise<boolean> {
  const orgId = rule.targetOrganizationId;
  if (!orgId) return false;

  const org = await db
    .select({ id: organizations.id, archivedAt: organizations.archivedAt })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .then((r) => r[0]);
  if (!org || org.archivedAt) return false;

  if (rule.targetIntendedUsage === "project") {
    if (!rule.targetFundableProjectId) return false;
    const proj = await db
      .select({
        id: fundableProjects.id,
        archivedAt: fundableProjects.archivedAt,
      })
      .from(fundableProjects)
      .where(eq(fundableProjects.id, rule.targetFundableProjectId))
      .then((r) => r[0]);
    if (!proj || proj.archivedAt) return false;
  }

  // Donor XOR — the minted gift is attributed solely to the rule's target org.
  if (
    validateGiftInvariants({
      organizationId: orgId,
      individualGiverPersonId: null,
      householdId: null,
    }).length > 0
  ) {
    return false;
  }

  const giftId = newId();
  let applied = false;
  await db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(stagedPayments)
      .where(eq(stagedPayments.id, stagedId))
      .for("update")
      .then((r) => r[0]);
    if (!locked || locked.status !== "pending") return;

    const amt = locked.amount == null ? NaN : Number(locked.amount);
    if (Number.isNaN(amt) || amt <= 0) return;

    await tx.insert(giftsAndPayments).values(
      buildGiftValuesFromStaged(
        giftId,
        {
          qbEntityType: source.qbEntityType,
          qbEntityId: source.qbEntityId,
          amount: locked.amount,
          dateReceived: locked.dateReceived,
          payerName: locked.payerName,
          rawReference: locked.rawReference,
          organizationId: orgId,
          individualGiverPersonId: null,
          householdId: null,
          matchedPaymentIntermediaryId: locked.matchedPaymentIntermediaryId,
        },
        // Auto-created at ingest — no acting user.
        null,
      ),
    );

    await tx.insert(giftAllocations).values({
      id: newId(),
      giftId,
      subAmount: locked.amount,
      intendedUsage: rule.targetIntendedUsage as
        (typeof giftAllocations.$inferInsert)["intendedUsage"],
      fundableProjectId:
        rule.targetIntendedUsage === "project"
          ? rule.targetFundableProjectId
          : null,
    });

    await tx
      .update(stagedPayments)
      .set({
        status: "approved",
        matchStatus: "matched",
        createdGiftId: giftId,
        autoApplied: true,
        // Pin the staged row's donor to the gift's donor (the target org).
        organizationId: orgId,
        individualGiverPersonId: null,
        householdId: null,
        matchedRuleId: rule.ruleId,
        updatedAt: new Date(),
      })
      .where(eq(stagedPayments.id, stagedId));
    applied = true;
  });
  if (applied) {
    // The minted gift now carries QB linkage — persist its tie status.
    await applyGiftQbTieMany(giftId);
  }
  return applied;
}

export interface ApplyRuleToPendingResult {
  matched: number;
  excluded: number;
  autoCreated: number;
  skipped: number;
}

/**
 * Apply (or dry-run preview) a single admin-editable handling rule against all
 * currently-pending staged payments. Only `status='pending'` rows are touched;
 * approved / rejected / excluded rows are never altered.
 *
 * - `exclude` rules mark matching pending rows as excluded (same reason as the
 *   ingest path, classificationSource='manual' to distinguish from auto).
 * - `auto_create_approve` rules mint + allocate + approve with the same
 *   fail-safe as ingest: if the rule can't apply cleanly the row is left
 *   pending and counted as skipped.
 *
 * When `dryRun=true`, no rows are written; only the `matched` count is
 * meaningful (excluded / autoCreated / skipped will be 0).
 */
export async function applyRuleToPendingPayments(
  rule: EngineRule,
  dryRun: boolean,
): Promise<ApplyRuleToPendingResult> {
  const rows = await db
    .select()
    .from(stagedPayments)
    .where(eq(stagedPayments.status, "pending"));

  let matched = 0;
  let excluded = 0;
  let autoCreated = 0;
  let skipped = 0;

  for (const row of rows) {
    const input = {
      amount: row.amount,
      payerName: row.payerName,
      lineItemNames: row.lineItemNames,
      lineAccountNames: row.lineAccountNames,
      rawReference: row.rawReference,
      lineDescription: row.lineDescription,
      lineClasses: row.lineClasses,
    };

    const result = evaluateRules([rule], input);
    if (!result) continue;
    matched += 1;

    if (dryRun) continue;

    if (result.action === "exclude") {
      const updated = await db
        .update(stagedPayments)
        .set({
          status: "excluded",
          exclusionReason: result.reason,
          classificationSource: "manual",
          matchedRuleId: result.ruleId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stagedPayments.id, row.id),
            eq(stagedPayments.status, "pending"),
          ),
        );
      if ((updated.rowCount ?? 0) > 0) excluded += 1;
    } else if (result.action === "auto_create_approve") {
      const did = await applyAutoCreateRuleToRow(row.id, row, result);
      if (did) autoCreated += 1;
      else skipped += 1;
    }
  }

  return { matched, excluded, autoCreated, skipped };
}

/**
 * Variant of `applyAutoCreateRule` that works from an existing staged payment
 * DB row (all needed fields already captured) rather than a fresh QB pull
 * source. Used by the admin "apply to pending" path.
 */
async function applyAutoCreateRuleToRow(
  stagedId: string,
  row: typeof stagedPayments.$inferSelect,
  rule: Extract<RuleEvalResult, { action: "auto_create_approve" }>,
): Promise<boolean> {
  const orgId = rule.targetOrganizationId;
  if (!orgId) return false;

  const org = await db
    .select({ id: organizations.id, archivedAt: organizations.archivedAt })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .then((r) => r[0]);
  if (!org || org.archivedAt) return false;

  if (rule.targetIntendedUsage === "project") {
    if (!rule.targetFundableProjectId) return false;
    const proj = await db
      .select({ id: fundableProjects.id, archivedAt: fundableProjects.archivedAt })
      .from(fundableProjects)
      .where(eq(fundableProjects.id, rule.targetFundableProjectId))
      .then((r) => r[0]);
    if (!proj || proj.archivedAt) return false;
  }

  if (
    validateGiftInvariants({
      organizationId: orgId,
      individualGiverPersonId: null,
      householdId: null,
    }).length > 0
  ) {
    return false;
  }

  const giftId = newId();
  let applied = false;
  await db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(stagedPayments)
      .where(eq(stagedPayments.id, stagedId))
      .for("update")
      .then((r) => r[0]);
    if (!locked || locked.status !== "pending") return;

    const amt = locked.amount == null ? NaN : Number(locked.amount);
    if (Number.isNaN(amt) || amt <= 0) return;

    await tx.insert(giftsAndPayments).values(
      buildGiftValuesFromStaged(
        giftId,
        {
          qbEntityType: locked.qbEntityType,
          qbEntityId: locked.qbEntityId,
          amount: locked.amount,
          dateReceived: locked.dateReceived,
          payerName: locked.payerName,
          rawReference: locked.rawReference,
          organizationId: orgId,
          individualGiverPersonId: null,
          householdId: null,
          matchedPaymentIntermediaryId: locked.matchedPaymentIntermediaryId,
        },
        null,
      ),
    );

    await tx.insert(giftAllocations).values({
      id: newId(),
      giftId,
      subAmount: locked.amount,
      intendedUsage: rule.targetIntendedUsage as
        (typeof giftAllocations.$inferInsert)["intendedUsage"],
      fundableProjectId:
        rule.targetIntendedUsage === "project"
          ? rule.targetFundableProjectId
          : null,
    });

    await tx
      .update(stagedPayments)
      .set({
        status: "approved",
        matchStatus: "matched",
        createdGiftId: giftId,
        autoApplied: true,
        organizationId: orgId,
        individualGiverPersonId: null,
        householdId: null,
        matchedRuleId: rule.ruleId,
        updatedAt: new Date(),
      })
      .where(eq(stagedPayments.id, stagedId));
    applied = true;
  });
  if (applied) {
    // The minted gift now carries QB linkage — persist its tie status.
    await applyGiftQbTieMany(giftId);
  }
  return applied;
}

export async function syncQuickbooks(
  opts: { fullResync?: boolean } = {},
): Promise<QuickbooksSyncSummary> {
  const fullResync = opts.fullResync === true;
  const outcome = await withSyncLock(QB_LOCK_KEY, "quickbooks", async () => {
    const conn = await getValidQuickbooksAccessToken();
    if (!conn) {
      logger.debug("QuickBooks sync: no active connection, skipping");
      return { pulled: 0, staged: 0, matched: 0, autoApplied: 0 };
    }

    const row = await db
      .select({ syncWatermark: quickbooksConnections.syncWatermark })
      .from(quickbooksConnections)
      .where(eq(quickbooksConnections.realmId, conn.realmId))
      .then((r) => r[0]);
    // A full re-pull ignores the watermark to re-fetch the entire back-catalog
    // (since=null), so every existing staged row is re-enriched with the new QB
    // capture fields. The watermark itself is still advanced at the end.
    const since = fullResync ? null : (row?.syncWatermark ?? null);
    const watermarkFloor = row?.syncWatermark ?? null;

    let pulled: Awaited<ReturnType<typeof pullIncomingPayments>>;
    try {
      pulled = await pullIncomingPayments(conn.accessToken, conn.realmId, since);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db
        .update(quickbooksConnections)
        .set({ lastError: msg, updatedAt: new Date() })
        .where(eq(quickbooksConnections.realmId, conn.realmId));
      throw e;
    }

    let staged = 0;
    let matched = 0;
    let autoApplied = 0;
    // Seed from the stored watermark floor (not `since`, which is null on a full
    // re-pull) so a full re-pull never regresses the watermark below where the
    // incremental sync had already advanced it.
    let maxUpdated: number | null = watermarkFloor
      ? watermarkFloor.getTime()
      : null;

    // Admin-editable handling rules drive the INGEST path. Loaded once per run so
    // edits apply to NEW incoming payments only (already-queued rows untouched).
    const handlingRules = await loadHandlingRules();

    for (const p of pulled) {
      if (p.lastUpdatedTime) {
        const t = new Date(p.lastUpdatedTime).getTime();
        if (!Number.isNaN(t) && (maxUpdated === null || t > maxUpdated)) {
          maxUpdated = t;
        }
      }

      // Classify first via the admin-editable rules. `exclude` → noise (skips the
      // costlier scorer); `auto_create_approve` → mint+approve after staging.
      const ruleHit = evaluateRules(handlingRules, {
        amount: p.amount,
        payerName: p.payerName,
        lineItemNames: p.lineItemNames,
        lineAccountNames: p.lineAccountNames,
        rawReference: p.rawReference,
        lineDescription: p.lineDescription,
        lineClasses: p.lineClasses,
      });
      const excluded = ruleHit?.action === "exclude";
      const exclusionReason = excluded ? ruleHit.reason : null;

      // Attribute the money to its Wildflower entity (orthogonal to exclusion):
      // even excluded rows carry their entity so historical filtering stays right.
      const entityId = detectEntity({
        amount: p.amount,
        payerName: p.payerName,
        lineItemNames: p.lineItemNames,
        lineAccountNames: p.lineAccountNames,
        lineClasses: p.lineClasses,
        rawReference: p.rawReference,
        lineDescription: p.lineDescription,
      });

      // Seed the money's origin (provenance defaults to 'auto'). Text + the QB
      // instrument only — Stripe evidence and the intermediary's type aren't
      // resolved at first ingest; they refine the origin later via the backfill.
      const fundingSource = detectFundingSource({
        payerName: p.payerName,
        qbPaymentMethod: p.qbPaymentMethod,
        rawReference: p.rawReference,
        lineDescription: p.lineDescription,
        qbTransactionMemo: p.qbTransactionMemo,
        qbDepositToAccountName: p.qbDepositToAccountName,
      });

      const scored: ScoredMatch | null = excluded
        ? null
        : await scoreStagedPayment({
            payerName: p.payerName,
            payerEmail: p.payerEmail,
            rawReference: p.rawReference,
            lineDescription: p.lineDescription,
            amount: p.amount,
            dateReceived: p.dateReceived,
          });

      const matchStatus = excluded
        ? "unmatched"
        : scored && scored.tier === "high"
          ? "matched"
          : scored && scored.tier === "suggested"
            ? "suggested"
            : "unmatched";
      // Donor hint is recorded for high + suggested tiers (the system's best
      // guess); a human confirms/overrides it in the reconciler.
      const donor =
        scored && scored.tier !== "none"
          ? scored.donor
          : { organizationId: null, individualGiverPersonId: null, householdId: null };

      const inserted = await buildStagedLineUpsert({
        id: newId(),
        realmId: conn.realmId,
        qbEntityType: p.qbEntityType,
        qbEntityId: p.qbEntityId,
        qbLineId: p.qbLineId,
        qbDepositId: p.qbDepositId,
        amount: p.amount,
        dateReceived: p.dateReceived,
        payerName: p.payerName,
        payerEmail: p.payerEmail,
        rawReference: p.rawReference,
        lineDescription: p.lineDescription,
        status: excluded ? "excluded" : "pending",
        exclusionReason,
        classificationSource: "auto",
        matchedRuleId: ruleHit?.ruleId ?? null,
        entityId,
        fundingSource,
        matchStatus,
        matchScore: scored && scored.method ? scored.score : null,
        matchMethod: scored ? scored.method : null,
        organizationId: donor.organizationId,
        individualGiverPersonId: donor.individualGiverPersonId,
        householdId: donor.householdId,
        matchedPaymentIntermediaryId: scored ? scored.intermediaryId : null,
        lineItemNames: p.lineItemNames,
        lineAccountNames: p.lineAccountNames,
        lineClasses: p.lineClasses,
        qbPayerType: p.qbPayerType,
        qbPayerId: p.qbPayerId,
        qbPaymentMethod: p.qbPaymentMethod,
        qbCheckNumber: p.qbCheckNumber,
        qbDepositToAccountName: p.qbDepositToAccountName,
        qbDocNumber: p.qbDocNumber,
        qbBillingAddress: p.qbBillingAddress,
        qbTransactionMemo: p.qbTransactionMemo,
        qbCurrency: p.qbCurrency,
        qbExchangeRate: p.qbExchangeRate,
        qbCreateTime: p.qbCreateTime ? new Date(p.qbCreateTime) : null,
        qbLinkedTxn: p.qbLinkedTxn,
        qbRaw: p.qbRaw,
        qbRawLine: p.qbRawLine,
      }, { enrichAllStatuses: fullResync }).returning({
        id: stagedPayments.id,
        isInsert: sql<boolean>`(xmax = 0)`,
      });

      const newRow = inserted[0];
      if (!newRow?.isInsert) continue;
      staged += 1;
      if (scored && scored.method && scored.tier !== "none") matched += 1;

      // ── auto_create_approve rule: mint + allocate + approve (reversible). ──
      // FAIL-SAFE: if the rule can't apply cleanly, fall through to normal
      // high-confidence auto-apply so the payment still lands for review.
      if (ruleHit?.action === "auto_create_approve") {
        const did = await applyAutoCreateRule(newRow.id, p, ruleHit);
        if (did) {
          autoApplied += 1;
          continue;
        }
      }

      // ── Auto-apply high-confidence matches (reversible). ──
      // Only RECONCILES to a single existing gift; never mints a new one. Rows
      // with no single match stay pending in the needs-review queue.
      if (scored && scored.tier === "high") {
        const did = await autoApply(newRow.id, scored);
        if (did) autoApplied += 1;
      }
    }

    const newWatermark =
      maxUpdated !== null ? new Date(maxUpdated) : since ?? new Date();
    await db
      .update(quickbooksConnections)
      .set({
        syncWatermark: newWatermark,
        lastSyncedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(quickbooksConnections.realmId, conn.realmId));

    return { pulled: pulled.length, staged, matched, autoApplied };
  });

  if (!outcome.ran) {
    return { ran: false, pulled: 0, staged: 0, matched: 0, autoApplied: 0 };
  }
  return { ran: true, ...outcome.result! };
}

/**
 * Apply a high-confidence match to the ledger inside a guarded transaction.
 *   single unambiguous gift     → RECONCILE (matchedGiftId): one exact-amount
 *                                 gift, or one fee-band gift when none are exact.
 *   zero OR many in-window gifts → leave the row PENDING (needs review).
 * The worker NEVER mints a gift here. Auto-creating a brand-new gift without a
 * human is reserved for explicit admin rules (`auto_create_approve`, e.g. the
 * AmazonSmile rule) applied at ingest BEFORE this runs. When there is no single
 * existing gift to reconcile to, the row keeps its confident donor hint and
 * stays in the needs-review queue so a person can create or match it.
 * Each write re-checks the row is still pending so a concurrent human action is
 * never clobbered. Returns true when an action was applied.
 */
async function autoApply(
  stagedId: string,
  scored: ScoredMatch,
): Promise<boolean> {
  const stillPending = and(
    eq(stagedPayments.id, stagedId),
    eq(stagedPayments.status, "pending"),
  );

  // RECONCILE to the single matching existing gift. Guard that no other staged
  // row has already grabbed this gift (NOT EXISTS for the common case; the
  // partial-unique index backstops a true race). On a race, leave the row
  // pending for human review rather than double-linking the gift.
  if (scored.matchedGiftId) {
    const giftId = scored.matchedGiftId;
    try {
      const upd = await db
        .update(stagedPayments)
        .set({
          status: "approved",
          matchStatus: "matched",
          matchedGiftId: giftId,
          autoApplied: true,
          updatedAt: new Date(),
        })
        .where(
          and(
            stillPending,
            sql`NOT EXISTS (
              SELECT 1 FROM staged_payments sp2
              WHERE (sp2.matched_gift_id = ${giftId}
                     OR sp2.created_gift_id = ${giftId})
                AND sp2.id <> ${stagedId}
            )`,
          ),
        )
        .returning({ id: stagedPayments.id });
      if (upd.length > 0) {
        // The reconciled gift now carries QB linkage — persist its tie status.
        await applyGiftQbTieMany(giftId);
        return true;
      }
      return false;
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  }

  // No single existing gift to reconcile to (zero candidates → would-be new
  // gift, or several ambiguous candidates). The worker does not mint: keep the
  // confident donor hint and leave the row in "needs review" for a human to
  // create the gift or pick the right match.
  return false;
}

export interface QuickbooksRematchSummary {
  ran: boolean;
  scanned: number;
  matched: number;
}

const REMATCH_CONCURRENCY = 8;

/**
 * On-demand backfill: re-score still-`pending` + `unmatched` + donor-less rows
 * with the latest matching logic and record any donor hint it finds (matched /
 * suggested). DONOR-ONLY by design — it never mints or reconciles a gift (that
 * auto-apply happens only on fresh ingestion), so a manual "rematch" button can
 * never bulk-write the ledger by surprise. Purely additive: each write is a
 * guarded conditional UPDATE (still pending + unmatched + donor-less), so a
 * concurrent human resolve is never clobbered. Advisory-locked under the shared
 * QuickBooks key.
 */
export async function rematchStagedPayments(): Promise<QuickbooksRematchSummary> {
  const outcome = await withSyncLock(QB_LOCK_KEY, "quickbooks", async () => {
    const candidates = await db
      .select({
        id: stagedPayments.id,
        payerName: stagedPayments.payerName,
        payerEmail: stagedPayments.payerEmail,
        rawReference: stagedPayments.rawReference,
        lineDescription: stagedPayments.lineDescription,
        amount: stagedPayments.amount,
        dateReceived: stagedPayments.dateReceived,
      })
      .from(stagedPayments)
      .where(
        and(
          eq(stagedPayments.status, "pending"),
          eq(stagedPayments.matchStatus, "unmatched"),
          isNull(stagedPayments.organizationId),
          isNull(stagedPayments.individualGiverPersonId),
          isNull(stagedPayments.householdId),
        ),
      );

    let matched = 0;
    for (let i = 0; i < candidates.length; i += REMATCH_CONCURRENCY) {
      const chunk = candidates.slice(i, i + REMATCH_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (row) => {
          const scored = await scoreStagedPayment({
            payerName: row.payerName,
            payerEmail: row.payerEmail,
            rawReference: row.rawReference,
            lineDescription: row.lineDescription,
            amount: row.amount,
            dateReceived: row.dateReceived,
          });
          if (scored.tier === "none" || !scored.method) return false;
          const newMatchStatus =
            scored.tier === "high" ? "matched" : "suggested";
          const upd = await db
            .update(stagedPayments)
            .set({
              matchStatus: newMatchStatus,
              matchScore: scored.score,
              matchMethod: scored.method,
              organizationId: scored.donor.organizationId,
              individualGiverPersonId: scored.donor.individualGiverPersonId,
              householdId: scored.donor.householdId,
              matchedPaymentIntermediaryId: scored.intermediaryId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(stagedPayments.id, row.id),
                eq(stagedPayments.status, "pending"),
                eq(stagedPayments.matchStatus, "unmatched"),
                isNull(stagedPayments.organizationId),
                isNull(stagedPayments.individualGiverPersonId),
                isNull(stagedPayments.householdId),
              ),
            )
            .returning({ id: stagedPayments.id });
          return upd.length > 0;
        }),
      );
      matched += results.filter(Boolean).length;
    }

    return { scanned: candidates.length, matched };
  });

  if (!outcome.ran) return { ran: false, scanned: 0, matched: 0 };
  return { ran: true, ...outcome.result! };
}

export interface QuickbooksReclassifySummary {
  ran: boolean;
  scanned: number;
  excluded: number;
  included: number;
}

/**
 * Re-runnable classifier pass. Re-applies the noise rules to rows whose
 * classification is still `auto` AND status IN (pending, excluded), so refining
 * the rules retroactively cleans up (or restores) already-staged rows. NEVER
 * touches a `manual` row (a human include/exclude is permanent) or an
 * approved/rejected row. Each write is guarded so it can't clobber a concurrent
 * manual override. Advisory-locked under the shared QuickBooks key.
 */
export async function reclassifyStagedPayments(): Promise<QuickbooksReclassifySummary> {
  const outcome = await withSyncLock(QB_LOCK_KEY, "quickbooks", async () => {
    const candidates = await db
      .select({
        id: stagedPayments.id,
        status: stagedPayments.status,
        entitySource: stagedPayments.entitySource,
        fundingSourceProvenance: stagedPayments.fundingSourceProvenance,
        amount: stagedPayments.amount,
        payerName: stagedPayments.payerName,
        rawReference: stagedPayments.rawReference,
        lineDescription: stagedPayments.lineDescription,
        lineItemNames: stagedPayments.lineItemNames,
        lineAccountNames: stagedPayments.lineAccountNames,
        lineClasses: stagedPayments.lineClasses,
        qbPaymentMethod: stagedPayments.qbPaymentMethod,
        qbTransactionMemo: stagedPayments.qbTransactionMemo,
        qbDepositToAccountName: stagedPayments.qbDepositToAccountName,
      })
      .from(stagedPayments)
      .where(
        and(
          eq(stagedPayments.classificationSource, "auto"),
          inArray(stagedPayments.status, ["pending", "excluded"]),
        ),
      );

    const guard = (id: string) =>
      and(
        eq(stagedPayments.id, id),
        eq(stagedPayments.classificationSource, "auto"),
        inArray(stagedPayments.status, ["pending", "excluded"]),
      );

    let excluded = 0;
    let included = 0;
    for (const row of candidates) {
      const input = {
        amount: row.amount,
        payerName: row.payerName,
        lineItemNames: row.lineItemNames,
        lineAccountNames: row.lineAccountNames,
        rawReference: row.rawReference,
        lineDescription: row.lineDescription,
        lineClasses: row.lineClasses,
      };
      const cls = classifyStagedPayment(input);
      // Entity attribution is refreshed on every reclassified row, independent of
      // the exclusion status transition below, so marker changes re-file rows —
      // EXCEPT on rows a human pinned (entity_source = 'manual'), whose
      // attribution is review state and must never be clobbered by detectEntity.
      const entitySet =
        row.entitySource === "manual" ? {} : { entityId: detectEntity(input) };
      // Funding source is refreshed on every auto row alongside entity, and is
      // never touched on a human-pinned (provenance 'manual') row.
      const fundingSet =
        row.fundingSourceProvenance === "manual"
          ? {}
          : {
              fundingSource: detectFundingSource({
                payerName: row.payerName,
                qbPaymentMethod: row.qbPaymentMethod,
                rawReference: row.rawReference,
                lineDescription: row.lineDescription,
                qbTransactionMemo: row.qbTransactionMemo,
                qbDepositToAccountName: row.qbDepositToAccountName,
              }),
            };
      if (cls.excluded && row.status !== "excluded") {
        const upd = await db
          .update(stagedPayments)
          .set({
            status: "excluded",
            exclusionReason: cls.reason,
            ...entitySet,
            ...fundingSet,
            updatedAt: new Date(),
          })
          .where(guard(row.id))
          .returning({ id: stagedPayments.id });
        if (upd.length) excluded += 1;
      } else if (cls.excluded && row.status === "excluded") {
        // Already excluded — keep status, just refresh the reason if it drifted.
        await db
          .update(stagedPayments)
          .set({
            exclusionReason: cls.reason,
            ...entitySet,
            ...fundingSet,
            updatedAt: new Date(),
          })
          .where(guard(row.id));
      } else if (!cls.excluded && row.status === "excluded") {
        const upd = await db
          .update(stagedPayments)
          .set({
            status: "pending",
            exclusionReason: null,
            ...entitySet,
            ...fundingSet,
            updatedAt: new Date(),
          })
          .where(guard(row.id))
          .returning({ id: stagedPayments.id });
        if (upd.length) included += 1;
      } else {
        // Pending and staying pending — still refresh entity + funding source.
        await db
          .update(stagedPayments)
          .set({ ...entitySet, ...fundingSet, updatedAt: new Date() })
          .where(guard(row.id));
      }
    }

    return { scanned: candidates.length, excluded, included };
  });

  if (!outcome.ran) {
    return { ran: false, scanned: 0, excluded: 0, included: 0 };
  }
  return { ran: true, ...outcome.result! };
}
