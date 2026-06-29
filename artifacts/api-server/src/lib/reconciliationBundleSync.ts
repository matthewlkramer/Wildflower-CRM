import { db } from "@workspace/db";
import { reconciliationBundleDrafts } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { newId } from "./helpers";
import {
  assembleBundleProposal,
  type BundleAnchorType,
  type StoredBundleOverrides,
} from "./reconciliationBundleProposal";
import type { Viewer } from "./identityVisibility";

/**
 * Sync-time ensure/refresh of settlement-bundle drafts.
 *
 * A money sync (Stripe / QuickBooks / Donorbox) changes the source rows behind
 * settlement bundles. After such a run we want every settlement ANCHOR to have a
 * draft (so the workbench can list it) and existing OPEN drafts to reflect the
 * fresh source state — WITHOUT ever clobbering a human's overrides.
 *
 * Two guards make this safe:
 *
 *   1. Human overrides win. A draft that has any human override is left entirely
 *      untouched — both its overrides AND its cached derivation/fingerprint. The
 *      latter matters because the confirm endpoint's drift guard compares live
 *      state against the STORED fingerprint; silently refreshing it would disarm
 *      that guard for the person actively editing. They re-derive on next
 *      edit/GET anyway.
 *   2. Fingerprint guard. An un-overridden open draft is only rewritten when its
 *      source fingerprint actually changed, so an unchanged sync is a cheap no-op
 *      and `updatedAt` doesn't churn.
 *
 * Confirmed / superseded drafts are terminal and never touched. Everything is
 * best-effort: a draft-refresh failure is logged but never propagated, so it can
 * never break the money sync that triggered it.
 */

// A privileged, request-less viewer for sync-time derivation. The cached
// derivedProposal snapshot is recomputed per real viewer on every GET, so using
// an admin viewer here only avoids baking masked donor labels into the cache; it
// never widens what any user can actually see.
const SYNC_VIEWER: Viewer = { id: "", role: "admin" };

export interface BundleDraftSyncResult {
  created: number;
  refreshed: number;
  skipped: number;
}

export interface BundleAnchorRef {
  anchorType: BundleAnchorType;
  anchorId: string;
}

/** Whether a draft carries any human edit (row or tie override). */
function hasHumanOverrides(
  overrides: StoredBundleOverrides | null | undefined,
): boolean {
  if (!overrides) return false;
  const rowCount = overrides.rows ? Object.keys(overrides.rows).length : 0;
  const tieCount = overrides.tie ? Object.keys(overrides.tie).length : 0;
  return rowCount > 0 || tieCount > 0;
}

/**
 * Ensure a draft exists (and is refreshed when un-overridden) for each given
 * settlement anchor. This is the GENERATE+REFRESH path — used by the Stripe sync
 * for every payout it touched, since a payout is the canonical bundle anchor.
 */
export async function ensureBundleDraftsForAnchors(
  anchors: ReadonlyArray<BundleAnchorRef>,
): Promise<BundleDraftSyncResult> {
  const result: BundleDraftSyncResult = { created: 0, refreshed: 0, skipped: 0 };

  // Dedupe so a repeated anchor in one run is processed once.
  const seen = new Set<string>();
  const unique: BundleAnchorRef[] = [];
  for (const a of anchors) {
    const key = `${a.anchorType}:${a.anchorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(a);
  }

  for (const anchor of unique) {
    try {
      const existing = await db
        .select()
        .from(reconciliationBundleDrafts)
        .where(
          and(
            eq(reconciliationBundleDrafts.anchorType, anchor.anchorType),
            eq(reconciliationBundleDrafts.anchorId, anchor.anchorId),
          ),
        )
        .then((r) => r[0]);

      // Terminal drafts are never re-derived.
      if (existing && existing.status !== "open") {
        result.skipped++;
        continue;
      }

      const overrides = (existing?.overrides ?? {}) as StoredBundleOverrides;

      // A human-edited open draft is preserved wholesale (see guard #1).
      if (existing && hasHumanOverrides(overrides)) {
        result.skipped++;
        continue;
      }

      const assembled = await assembleBundleProposal({
        anchorType: anchor.anchorType,
        anchorId: anchor.anchorId,
        overrides,
        viewer: SYNC_VIEWER,
      });
      if (!assembled) {
        result.skipped++;
        continue;
      }
      const { proposal } = assembled;

      if (!existing) {
        const inserted = await db
          .insert(reconciliationBundleDrafts)
          .values({
            id: newId(),
            anchorType: anchor.anchorType,
            anchorId: anchor.anchorId,
            overrides: {},
            derivedProposal: proposal,
            sourceFingerprint: proposal.sourceFingerprint,
          })
          .onConflictDoNothing({
            target: [
              reconciliationBundleDrafts.anchorType,
              reconciliationBundleDrafts.anchorId,
            ],
          })
          .returning({ id: reconciliationBundleDrafts.id });
        if (inserted.length > 0) result.created++;
        else result.skipped++; // a concurrent assemble/sync created it first
        continue;
      }

      // Un-overridden open draft: refresh the cache only on real drift.
      if (existing.sourceFingerprint === proposal.sourceFingerprint) {
        result.skipped++;
        continue;
      }
      await db
        .update(reconciliationBundleDrafts)
        .set({
          derivedProposal: proposal,
          sourceFingerprint: proposal.sourceFingerprint,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(reconciliationBundleDrafts.id, existing.id),
            eq(reconciliationBundleDrafts.status, "open"),
          ),
        );
      result.refreshed++;
    } catch (e) {
      logger.warn(
        { err: e, anchorType: anchor.anchorType, anchorId: anchor.anchorId },
        "Bundle draft ensure/refresh failed for anchor (continuing)",
      );
    }
  }

  return result;
}

/**
 * Refresh every OPEN, un-overridden bundle draft from current source state. Used
 * by syncs (QuickBooks / Donorbox) that perturb the source data of EXISTING
 * bundles but don't introduce a new payout anchor of their own — e.g. a QB pull
 * that changes a deposit amount tied to a payout, or a Donorbox pull that
 * enriches charges behind a payout. Human-edited drafts are skipped before any
 * derivation work (see guard #1); unchanged drafts are a fingerprint no-op.
 */
export async function refreshOpenBundleDrafts(): Promise<BundleDraftSyncResult> {
  const result: BundleDraftSyncResult = { created: 0, refreshed: 0, skipped: 0 };

  const open = await db
    .select()
    .from(reconciliationBundleDrafts)
    .where(eq(reconciliationBundleDrafts.status, "open"));

  for (const draft of open) {
    try {
      const overrides = (draft.overrides ?? {}) as StoredBundleOverrides;
      if (hasHumanOverrides(overrides)) {
        result.skipped++;
        continue;
      }

      const assembled = await assembleBundleProposal({
        anchorType: draft.anchorType,
        anchorId: draft.anchorId,
        overrides,
        viewer: SYNC_VIEWER,
      });
      if (!assembled) {
        result.skipped++;
        continue;
      }
      const { proposal } = assembled;

      if (draft.sourceFingerprint === proposal.sourceFingerprint) {
        result.skipped++;
        continue;
      }
      await db
        .update(reconciliationBundleDrafts)
        .set({
          derivedProposal: proposal,
          sourceFingerprint: proposal.sourceFingerprint,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(reconciliationBundleDrafts.id, draft.id),
            eq(reconciliationBundleDrafts.status, "open"),
          ),
        );
      result.refreshed++;
    } catch (e) {
      logger.warn(
        { err: e, draftId: draft.id },
        "Bundle draft refresh failed (continuing)",
      );
    }
  }

  return result;
}
