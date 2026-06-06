import { db } from "@workspace/db";
import {
  quickbooksConnections,
  stagedPayments,
  giftsAndPayments,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "./helpers";
import { logger } from "./logger";
import { withSyncLock } from "./syncLock";
import { getValidQuickbooksAccessToken } from "./quickbooksTokenStore";
import { pullIncomingPayments } from "./quickbooksClient";
import { scoreStagedPayment, type ScoredMatch } from "./quickbooksMatch";
import { classifyStagedPayment } from "./quickbooksExclusionRules";
import { buildGiftValuesFromStaged } from "./quickbooksGift";

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

    for (const p of pulled) {
      if (p.lastUpdatedTime) {
        const t = new Date(p.lastUpdatedTime).getTime();
        if (!Number.isNaN(t) && (maxUpdated === null || t > maxUpdated)) {
          maxUpdated = t;
        }
      }

      // Classify first — excluded noise skips the (costlier) scorer.
      const cls = classifyStagedPayment({
        amount: p.amount,
        payerName: p.payerName,
        lineItemNames: p.lineItemNames,
        lineAccountNames: p.lineAccountNames,
        rawReference: p.rawReference,
        lineDescription: p.lineDescription,
        lineClasses: p.lineClasses,
      });

      const scored: ScoredMatch | null = cls.excluded
        ? null
        : await scoreStagedPayment({
            payerName: p.payerName,
            payerEmail: p.payerEmail,
            rawReference: p.rawReference,
            lineDescription: p.lineDescription,
            amount: p.amount,
            dateReceived: p.dateReceived,
          });

      const matchStatus = cls.excluded
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
        status: cls.excluded ? "excluded" : "pending",
        exclusionReason: cls.reason,
        classificationSource: "auto",
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

      // ── Auto-apply high-confidence matches (reversible). ──
      if (scored && scored.tier === "high") {
        const did = await autoApply(newRow.id, p, scored);
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
 *   single unambiguous gift    → RECONCILE (matchedGiftId): one exact-amount
 *                                gift, or one fee-band gift when none are exact.
 *   zero in-window gifts        → MINT a new gift (createdGiftId).
 *   many                        → ambiguous; leave pending for review.
 * Each write re-checks the row is still pending so a concurrent human action is
 * never clobbered. Returns true when an action was applied.
 */
async function autoApply(
  stagedId: string,
  source: Awaited<ReturnType<typeof pullIncomingPayments>>[number],
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
      return upd.length > 0;
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  }

  // MINT a new gift only when there is no plausible existing one.
  if (scored.giftCandidateCount === 0) {
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
            organizationId: locked.organizationId,
            individualGiverPersonId: locked.individualGiverPersonId,
            householdId: locked.householdId,
            matchedPaymentIntermediaryId: locked.matchedPaymentIntermediaryId,
          },
          // Auto-created in the off-hours worker — no acting user.
          null,
        ),
      );
      await tx
        .update(stagedPayments)
        .set({
          status: "approved",
          matchStatus: "matched",
          createdGiftId: giftId,
          autoApplied: true,
          updatedAt: new Date(),
        })
        .where(eq(stagedPayments.id, stagedId));
      applied = true;
    });
    return applied;
  }

  // Ambiguous (multiple candidate gifts): keep the confident donor but leave
  // the row in "needs review" so a human picks the gift.
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
        amount: stagedPayments.amount,
        payerName: stagedPayments.payerName,
        rawReference: stagedPayments.rawReference,
        lineDescription: stagedPayments.lineDescription,
        lineItemNames: stagedPayments.lineItemNames,
        lineAccountNames: stagedPayments.lineAccountNames,
        lineClasses: stagedPayments.lineClasses,
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
      const cls = classifyStagedPayment({
        amount: row.amount,
        payerName: row.payerName,
        lineItemNames: row.lineItemNames,
        lineAccountNames: row.lineAccountNames,
        rawReference: row.rawReference,
        lineDescription: row.lineDescription,
        lineClasses: row.lineClasses,
      });
      if (cls.excluded && row.status !== "excluded") {
        const upd = await db
          .update(stagedPayments)
          .set({
            status: "excluded",
            exclusionReason: cls.reason,
            updatedAt: new Date(),
          })
          .where(guard(row.id))
          .returning({ id: stagedPayments.id });
        if (upd.length) excluded += 1;
      } else if (cls.excluded && row.status === "excluded") {
        // Already excluded — keep status, just refresh the reason if it drifted.
        await db
          .update(stagedPayments)
          .set({ exclusionReason: cls.reason, updatedAt: new Date() })
          .where(guard(row.id));
      } else if (!cls.excluded && row.status === "excluded") {
        const upd = await db
          .update(stagedPayments)
          .set({
            status: "pending",
            exclusionReason: null,
            updatedAt: new Date(),
          })
          .where(guard(row.id))
          .returning({ id: stagedPayments.id });
        if (upd.length) included += 1;
      }
    }

    return { scanned: candidates.length, excluded, included };
  });

  if (!outcome.ran) {
    return { ran: false, scanned: 0, excluded: 0, included: 0 };
  }
  return { ran: true, ...outcome.result! };
}
