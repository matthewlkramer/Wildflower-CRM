import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { bulkOperations } from "@workspace/db/schema";
import { eq, inArray, type SQL } from "drizzle-orm";
import { newId, parseOrBadRequest } from "./helpers";
import { getAppUser } from "./appRequest";

interface ZodLike<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
}

// Generic bulk-delete body: every entity uses the same envelope (ids[]).
export type BulkDeleteBody = { ids: string[] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TX = any;

// Sentinel written to the bulk_operations audit row's `fields` column so a
// delete op is distinguishable from a bulk update (which records the touched
// column names). bulk_operations carries no explicit op-type column.
export const BULK_DELETE_FIELD = "__deleted__";

export interface BulkDeleteConfig<Row extends Record<string, unknown>> {
  /** Audit-log entity name (e.g. "people"). */
  entity: string;
  /** Drizzle table. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Zod schema for the body ({ ids }). */
  bodySchema: ZodLike<BulkDeleteBody>;
  /**
   * Optional per-row guard run BEFORE the row's savepoint (and before any
   * cleanup). Return an error string to fail the row (recorded in the
   * response `failed[]` and the audit log's `failedIds`); return null to
   * proceed. Used to block deletes the single-delete route also blocks
   * (e.g. a gift linked to a QuickBooks split).
   */
  precheck?: (row: Row) => Promise<string | null>;
  /**
   * Optional cleanup run INSIDE the row's savepoint, before the row itself
   * is deleted. Use to remove RESTRICT-FK children (e.g. gift_allocations)
   * so the parent delete can proceed. A throw rolls back just this row.
   */
  cleanup?: (tx: TX, row: Row) => Promise<void>;
  /**
   * Optional post-commit hook receiving the rows that were actually
   * deleted. Runs once, after the outer transaction commits, outside any
   * savepoint. Use for derived-state recomputation (e.g. recompute a
   * pledge's coverage after its payments were removed). Errors are
   * swallowed (logged via req.log) so they don't undo a committed batch.
   */
  afterCommit?: (rows: Row[]) => Promise<void>;
}

interface BulkFailure {
  id: string;
  message: string;
}

/**
 * Execute a bulk-delete operation. Validates the body, loads existing rows,
 * deletes per-row inside a savepoint (so one row's failure — a guard or an
 * FK violation — doesn't abort the others), and writes a single
 * `bulk_operations` audit row capturing both successes and failures.
 *
 * The whole operation is wrapped in one outer transaction so the audit row
 * + per-row deletes commit (or roll back) atomically.
 */
export async function executeBulkDelete<Row extends Record<string, unknown>>(
  req: Request,
  res: Response,
  cfg: BulkDeleteConfig<Row>,
): Promise<void> {
  const parsed = parseOrBadRequest(cfg.bodySchema, req.body, res);
  if (!parsed) return;
  const { ids } = parsed;

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

  // Load existing rows in one shot. Rows not found become failures.
  const existingRows = (await db
    .select()
    .from(cfg.table)
    .where(inArray(cfg.table.id, uniqueIds))) as Row[];
  const byId = new Map<string, Row>(
    existingRows.map((r) => [r.id as string, r]),
  );

  const succeededIds: string[] = [];
  const succeededRows: Row[] = [];
  const failed: BulkFailure[] = [];
  const actor = getAppUser(req);

  // Single outer transaction wraps every per-row savepoint and the audit
  // insert. Per-row savepoints let a guard rejection or a constraint
  // violation roll back just that row without aborting the whole batch
  // (postgres requires SAVEPOINT to recover an aborted statement within a
  // transaction).
  await db.transaction(async (tx) => {
    for (const id of uniqueIds) {
      const row = byId.get(id);
      if (!row) {
        failed.push({ id, message: "not found" });
        continue;
      }
      if (cfg.precheck) {
        const err = await cfg.precheck(row);
        if (err) {
          failed.push({ id, message: err });
          continue;
        }
      }
      try {
        await tx.transaction(async (sp: TX) => {
          if (cfg.cleanup) await cfg.cleanup(sp, row);
          await sp.delete(cfg.table).where(eq(cfg.table.id, id) as SQL);
        });
        succeededIds.push(id);
        succeededRows.push(row);
      } catch (e) {
        failed.push({
          id,
          message: e instanceof Error ? e.message : "delete failed",
        });
      }
    }

    await tx.insert(bulkOperations).values({
      id: newId(),
      actorUserId: actor?.id ?? "unknown",
      entity: cfg.entity,
      fields: [BULK_DELETE_FIELD],
      targetIds: uniqueIds,
      succeededIds,
      failedIds: failed.map((f) => f.id),
    });
  });

  // Post-commit hook (derived-state recomputation). Errors are isolated so
  // a hook failure doesn't undo an already-committed batch.
  if (cfg.afterCommit && succeededRows.length > 0) {
    try {
      await cfg.afterCommit(succeededRows);
    } catch (e) {
      const log = (req as unknown as { log?: { error?: (...args: unknown[]) => void } }).log;
      log?.error?.({ err: e, entity: cfg.entity }, "bulk afterCommit hook failed");
    }
  }

  res.json({
    requested: uniqueIds.length,
    succeededIds,
    failed,
  });
}
