import type { Response } from "express";
import { db } from "@workspace/db";
import { bulkOperations } from "@workspace/db/schema";
import { eq, inArray, type AnyColumn, type SQL } from "drizzle-orm";
import { newId, parseOrBadRequest } from "./helpers";
import type { Request } from "express";
import { getAppUser } from "./appRequest";
import { recordAudit } from "./audit";

interface ZodLike<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
}

// Generic bulk-update body shape: every entity uses the same envelope
// (ids[] + patch object). The patch's allowed keys are constrained
// per-entity via the `allowedFields` whitelist below — anything else is
// stripped before hitting the DB. Forward-only: missing keys are never
// written.
export type BulkUpdateBody<P extends object> = {
  ids: string[];
  patch: Partial<P>;
};

// Per-row pre-check hook. Return null to accept the row, or a string
// to reject it with that error message (caught up into the response
// `failed[]` and the audit log's `failedIds`). Used to enforce CHECK
// constraint invariants the DB would otherwise raise as a 500
// (e.g. opportunities donor_xor / closed_requires_completion_date).
export type RowValidator<Row, P> = (
  existing: Row,
  patch: P,
) => string | null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TX = any;

// Optional per-row side-effect step. Runs INSIDE the row's savepoint
// AFTER the main column update, so a failure rolls back this row's
// updates (column + side-effect) atomically without affecting other
// rows. Used for reconciling related tables (e.g. pledge_allocations
// for opportunities' `coveredFiscalYears`).
export type ExtraApply<P extends object> = (
  tx: TX,
  id: string,
  virtualPatch: Partial<P>,
) => Promise<void>;

export interface BulkUpdateConfig<Row, P extends object> {
  /** Audit-log entity name (e.g. "people"). */
  entity: string;
  /** Drizzle table. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Zod schema for the full body (ids + patch). */
  bodySchema: ZodLike<BulkUpdateBody<P>>;
  /**
   * Whitelist of column keys this endpoint writes via UPDATE. Any
   * extra keys from the (zod-validated) body are silently dropped —
   * defence in depth against the body schema accidentally allowing a
   * non-bulk field through. Must be a subset of writable columns on
   * `table`.
   */
  allowedFields: ReadonlyArray<keyof P & string>;
  /**
   * Virtual fields — present in the body schema but NOT written by
   * .set(). Passed to `extraApply` so handlers can reconcile related
   * tables (e.g. `coveredFiscalYears` -> pledge_allocations rows).
   */
  virtualFields?: ReadonlyArray<keyof P & string>;
  /**
   * Optional per-row pre-check. Receives the existing row and the
   * (already-whitelisted) patch; returns an error string to fail the
   * row, or null to proceed.
   */
  validateRow?: RowValidator<Row, Partial<P>>;
  /** See ExtraApply. */
  extraApply?: ExtraApply<P>;
  /**
   * Optional post-commit per-row hook. Runs AFTER the outer transaction
   * commits, once per successfully-updated id, and outside the
   * savepoint. Use for derived-state recomputation (e.g. auto-advance
   * pledge stage when the patch may have made it newly eligible).
   * Errors are swallowed (logged via req.log if available) so a
   * post-hook failure doesn't undo an already-committed batch.
   */
  afterApply?: (id: string) => Promise<void>;
  /**
   * Optional derived-column hook. Given the (already-whitelisted) column
   * patch, returns extra column values to write atomically in the SAME
   * per-row UPDATE — use to keep a mirrored column in lockstep with a
   * user-set one (e.g. gifts' loan_or_grant mirrored from `type`). Only
   * invoked when there is a column patch; return {} to write nothing.
   */
  deriveColumns?: (cleanPatch: Partial<P>) => Record<string, unknown>;
}

interface BulkFailure {
  id: string;
  message: string;
}

/**
 * Execute a bulk-update operation. Validates the body, loads existing
 * rows, runs the per-entity invariant check on each row's merged
 * post-update state, performs the writes per-row inside a savepoint
 * (so one row's failure doesn't block the others), and writes a
 * single `bulk_operations` audit row capturing both successes and
 * failures.
 *
 * The whole operation is wrapped in one outer transaction so the
 * audit row + per-row updates commit (or roll back) atomically — if
 * the audit insert itself fails, no row updates persist.
 */
export async function executeBulkUpdate<Row extends Record<string, unknown>, P extends object>(
  req: Request,
  res: Response,
  cfg: BulkUpdateConfig<Row, P>,
): Promise<void> {
  const parsed = parseOrBadRequest(cfg.bodySchema, req.body, res);
  if (!parsed) return;
  const { ids, patch } = parsed;

  // Whitelist patch keys — column patch (goes to UPDATE) and virtual
  // patch (handed to extraApply) are kept separate.
  const cleanPatch: Partial<P> = {};
  for (const k of cfg.allowedFields) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      (cleanPatch as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
    }
  }
  const virtualPatch: Partial<P> = {};
  for (const k of cfg.virtualFields ?? []) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      (virtualPatch as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
    }
  }
  const hasColumnPatch = Object.keys(cleanPatch).length > 0;
  const hasVirtualPatch = Object.keys(virtualPatch).length > 0;
  if (!hasColumnPatch && !hasVirtualPatch) {
    res.status(400).json({
      error: "validation_error",
      message: "patch must contain at least one writable field",
    });
    return;
  }
  const touchedFields = [...Object.keys(cleanPatch), ...Object.keys(virtualPatch)];

  // De-duplicate ids while preserving order so the audit log mirrors
  // exactly what the user asked for.
  const seen = new Set<string>();
  const uniqueIds: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }

  // Load existing rows in one shot so per-row validation has full
  // pre-update state. Rows not found become failures.
  const existingRows = (await db
    .select()
    .from(cfg.table)
    .where(inArray(cfg.table.id, uniqueIds))) as Row[];
  const byId = new Map<string, Row>(
    existingRows.map((r) => [r.id as string, r]),
  );

  const succeededIds: string[] = [];
  const failed: BulkFailure[] = [];
  const actor = getAppUser(req);
  const bulkOpId = newId();

  // Single outer transaction wraps every per-row savepoint and the
  // audit insert. Per-row savepoints let DB constraint violations or
  // extraApply failures roll back just that row without aborting the
  // whole batch (postgres requires SAVEPOINT to recover an aborted
  // statement within a transaction).
  await db.transaction(async (tx) => {
    for (const id of uniqueIds) {
      const existing = byId.get(id);
      if (!existing) {
        failed.push({ id, message: "not found" });
        continue;
      }
      if (cfg.validateRow) {
        const err = cfg.validateRow(existing, cleanPatch);
        if (err) {
          failed.push({ id, message: err });
          continue;
        }
      }
      try {
        await tx.transaction(async (sp: TX) => {
          if (hasColumnPatch) {
            const derived = cfg.deriveColumns?.(cleanPatch) ?? {};
            await sp
              .update(cfg.table)
              .set({ ...cleanPatch, ...derived, updatedAt: new Date() })
              .where(eq(cfg.table.id, id) as SQL);
          }
          if (cfg.extraApply && hasVirtualPatch) {
            await cfg.extraApply(sp, id, virtualPatch);
            if (!hasColumnPatch) {
              // Bump updatedAt even when only side-effects changed,
              // so the row reflects the bulk op.
              await sp
                .update(cfg.table)
                .set({ updatedAt: new Date() })
                .where(eq(cfg.table.id, id) as SQL);
            }
          }
        });
        succeededIds.push(id);
      } catch (e) {
        failed.push({
          id,
          message: e instanceof Error ? e.message : "update failed",
        });
      }
    }

    await tx.insert(bulkOperations).values({
      id: bulkOpId,
      actorUserId: actor?.id ?? "unknown",
      entity: cfg.entity,
      fields: touchedFields,
      targetIds: uniqueIds,
      succeededIds,
      failedIds: failed.map((f) => f.id),
    });
    // One human-readable summary row alongside the detailed bulk_operations
    // ledger. entityId points at the bulk_operations row, not a single record.
    await recordAudit(tx, req, {
      action: "bulk_update",
      entityType: cfg.entity,
      entityId: bulkOpId,
      summary: `Updated ${touchedFields.join(", ")} on ${succeededIds.length} ${cfg.entity}`,
      metadata: {
        bulkOperationId: bulkOpId,
        fields: touchedFields,
        requested: uniqueIds.length,
        succeeded: succeededIds.length,
        failed: failed.length,
      },
    });
  });

  // Post-commit per-row hooks. Run sequentially so we don't fan out
  // concurrent writes from a single bulk op; errors are isolated per row.
  if (cfg.afterApply) {
    for (const id of succeededIds) {
      try {
        await cfg.afterApply(id);
      } catch (e) {
        // Swallow — the row update already committed. Surface via the
        // request logger when present.
        const log = (req as unknown as { log?: { error?: (...args: unknown[]) => void } }).log;
        log?.error?.({ err: e, id, entity: cfg.entity }, "bulk afterApply hook failed");
      }
    }
  }

  res.json({
    requested: uniqueIds.length,
    succeededIds,
    failed,
  });
}

/**
 * One text[]-column reconcile spec for `reconcileArrayColumns`.
 * - `valueKey`  — virtual-patch key holding the desired string[] set,
 *   ALSO the drizzle schema property name written via .set().
 * - `modeKey`   — virtual-patch key holding the "replace" | "append" mode.
 * - `column`    — the drizzle text[] column (used to read existing values
 *   when appending).
 */
export type ArrayColumnSpec<P extends object> = {
  valueKey: keyof P & string;
  modeKey: keyof P & string;
  column: AnyColumn;
};

/**
 * Reconcile one row's text[] columns (e.g. people/organizations'
 * interests_* and region_ids) from a bulk virtual-patch. For each spec
 * whose `valueKey` is present in `vp`:
 *   - replace = overwrite the column with the requested set (DESTRUCTIVE).
 *   - append  = union the requested set into the existing values (deduped).
 * All touched columns are written in a single UPDATE (with updatedAt).
 * Designed to be called from a route's `extraApply` inside the per-row
 * savepoint.
 */
export async function reconcileArrayColumns<P extends object>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: TX,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  id: string,
  vp: Partial<P>,
  specs: ReadonlyArray<ArrayColumnSpec<P>>,
): Promise<void> {
  const updates: Record<string, string[]> = {};
  for (const spec of specs) {
    if (!Object.prototype.hasOwnProperty.call(vp, spec.valueKey)) continue;
    const next = (vp as Record<string, unknown>)[spec.valueKey] as string[] | undefined;
    if (!next) continue;
    const mode =
      (vp as Record<string, unknown>)[spec.modeKey] === "append" ? "append" : "replace";
    if (mode === "append") {
      const rows = (await tx
        .select({ v: spec.column })
        .from(table)
        .where(eq(table.id, id))) as Array<{ v: string[] | null }>;
      const existing = rows[0]?.v ?? [];
      updates[spec.valueKey] = Array.from(new Set([...existing, ...next]));
    } else {
      updates[spec.valueKey] = next;
    }
  }
  if (Object.keys(updates).length > 0) {
    await tx
      .update(table)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(table.id, id));
  }
}
