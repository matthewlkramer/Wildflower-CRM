import { db } from "@workspace/db";
import { quickbooksConnections, stagedPayments } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { newId } from "./helpers";
import { logger } from "./logger";
import { withSyncLock } from "./syncLock";
import { getValidQuickbooksAccessToken } from "./quickbooksTokenStore";
import { pullIncomingPayments } from "./quickbooksClient";
import { autoMatchDonor } from "./quickbooksMatch";
import { classifyStagedPayment } from "./quickbooksExclusionRules";

/**
 * One-way QuickBooks → CRM payment pull. Resolves the active company,
 * pulls incoming-money entities updated since the watermark, stages each
 * as a review-queue row (idempotent via the unique index), runs donor
 * auto-match, and advances the watermark.
 *
 * Pull-only: this never writes back to QuickBooks.
 *
 * Noise filtering: each newly-staged row is run through the noise classifier
 * (zero-amount / loan / membership). Matching rows are inserted as `excluded`
 * with a reason instead of `pending`, so the default review queue stays clean.
 * Excluded rows are kept and auditable, never deleted.
 *
 * Re-syncs of an already-staged entity do NOT re-classify or change its status
 * (so a manual re-include is never clobbered): they only refresh the captured
 * line-item detail, and only for rows still in `pending`/`excluded` (never
 * touching approved/rejected). Classification of existing rows is a one-time
 * reclassification pass (backfill SQL), not an every-sync action.
 */

// Org-wide lock key. QuickBooks is a single shared company connection, so
// we use a fixed pseudo-user id for the per-(source,user) advisory lock.
const QB_LOCK_KEY = "quickbooks-global";

export interface QuickbooksSyncSummary {
  ran: boolean;
  pulled: number;
  staged: number;
  matched: number;
}

export async function syncQuickbooks(): Promise<QuickbooksSyncSummary> {
  const outcome = await withSyncLock(QB_LOCK_KEY, "quickbooks", async () => {
    const conn = await getValidQuickbooksAccessToken();
    if (!conn) {
      logger.debug("QuickBooks sync: no active connection, skipping");
      return { pulled: 0, staged: 0, matched: 0 };
    }

    // Read the persisted watermark for the incremental pull.
    const row = await db
      .select({ syncWatermark: quickbooksConnections.syncWatermark })
      .from(quickbooksConnections)
      .where(eq(quickbooksConnections.realmId, conn.realmId))
      .then((r) => r[0]);
    const since = row?.syncWatermark ?? null;

    let pulled: Awaited<ReturnType<typeof pullIncomingPayments>>;
    try {
      pulled = await pullIncomingPayments(
        conn.accessToken,
        conn.realmId,
        since,
      );
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
    let maxUpdated: number | null = since ? since.getTime() : null;

    for (const p of pulled) {
      if (p.lastUpdatedTime) {
        const t = new Date(p.lastUpdatedTime).getTime();
        if (!Number.isNaN(t) && (maxUpdated === null || t > maxUpdated)) {
          maxUpdated = t;
        }
      }
      const { match, matched: didMatch } = await autoMatchDonor(
        p.payerName,
        p.payerEmail,
      );
      // Auto-exclude noise (zero / loan / membership) at insert time.
      const cls = classifyStagedPayment({
        amount: p.amount,
        payerName: p.payerName,
        lineItemNames: p.lineItemNames,
        lineAccountNames: p.lineAccountNames,
        rawReference: p.rawReference,
      });
      const inserted = await db
        .insert(stagedPayments)
        .values({
          id: newId(),
          realmId: conn.realmId,
          qbEntityType: p.qbEntityType,
          qbEntityId: p.qbEntityId,
          amount: p.amount,
          dateReceived: p.dateReceived,
          payerName: p.payerName,
          payerEmail: p.payerEmail,
          rawReference: p.rawReference,
          status: cls.excluded ? "excluded" : "pending",
          exclusionReason: cls.reason,
          matchStatus: didMatch ? "matched" : "unmatched",
          organizationId: match.organizationId,
          individualGiverPersonId: match.individualGiverPersonId,
          householdId: match.householdId,
          lineItemNames: p.lineItemNames,
          lineAccountNames: p.lineAccountNames,
          lineClasses: p.lineClasses,
        })
        // On re-sync of an existing entity: refresh only the captured line
        // detail (and updatedAt), and only while still pending/excluded.
        // Status, reason, donor match are intentionally left untouched so a
        // manual re-include or an approve/reject is never clobbered.
        .onConflictDoUpdate({
          target: [
            stagedPayments.realmId,
            stagedPayments.qbEntityType,
            stagedPayments.qbEntityId,
          ],
          set: {
            lineItemNames: p.lineItemNames,
            lineAccountNames: p.lineAccountNames,
            lineClasses: p.lineClasses,
            updatedAt: new Date(),
          },
          setWhere: sql`${stagedPayments.status} in ('pending', 'excluded')`,
        })
        // xmax = 0 ⇒ this row was freshly INSERTed (not an ON CONFLICT update),
        // so we only count genuinely new staged rows.
        .returning({
          id: stagedPayments.id,
          isInsert: sql<boolean>`(xmax = 0)`,
        });
      if (inserted[0]?.isInsert) {
        staged += 1;
        if (didMatch) matched += 1;
      }
    }

    // Advance the watermark. Use the max LastUpdatedTime we saw (so a
    // future sync re-checks that boundary row, which the idempotent
    // onConflict upsert makes harmless), falling back to now when nothing
    // was pulled.
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

    return { pulled: pulled.length, staged, matched };
  });

  if (!outcome.ran) {
    return { ran: false, pulled: 0, staged: 0, matched: 0 };
  }
  return { ran: true, ...outcome.result! };
}
