import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { bulkOperations } from "@workspace/db/schema";
import { eq, inArray, isNull, type SQL } from "drizzle-orm";
import { newId, notFound, paramId, parseOrBadRequest } from "./helpers";
import { getAppUser } from "./appRequest";
import { recordAudit } from "./audit";

interface ZodLike<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
}

// Generic bulk-archive body: every entity uses the same envelope (ids[]).
export type BulkArchiveBody = { ids: string[] };

// Sentinel written to the bulk_operations audit row's `fields` column so an
// archive op is distinguishable from a hard delete (__deleted__) or a bulk
// update (which records the touched column names).
export const BULK_ARCHIVE_FIELD = "__archived__";

/** True when the requesting user is an admin (the only role allowed to view or
 * restore archived records). */
export function isAdmin(req: Request): boolean {
  return getAppUser(req)?.role === "admin";
}

/**
 * Admin gate for archive-management routes (unarchive). Writes a 403 and
 * returns false when the caller is not an admin; returns true otherwise.
 */
export function requireAdmin(req: Request, res: Response): boolean {
  if (!isAdmin(req)) {
    res.status(403).json({
      error: "forbidden",
      message: "Admin role required.",
    });
    return false;
  }
  return true;
}

/**
 * True only when the caller is an admin AND explicitly asked to include
 * archived rows (`?includeArchived=true`). A non-admin can never include
 * archived rows even by passing the flag directly — the gate is server-side.
 */
export function canIncludeArchived(req: Request): boolean {
  return isAdmin(req) && req.query.includeArchived === "true";
}

/**
 * Returns the list filter that hides archived rows (`archived_at IS NULL`), or
 * `undefined` when an admin has opted into seeing archived rows. Push the
 * result into a list handler's WHERE array only when defined:
 *
 *   const where = [...];
 *   const archived = activeOnlyUnlessAdmin(req, people.archivedAt);
 *   if (archived) where.push(archived);
 */
export function activeOnlyUnlessAdmin(
  req: Request,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  archivedAtColumn: any,
): SQL | undefined {
  return canIncludeArchived(req) ? undefined : isNull(archivedAtColumn);
}

export interface ArchiveOneConfig {
  /** Audit-log / 404 entity name (e.g. "person"). */
  entity: string;
  /** Drizzle table (must have `id`, `archivedAt`, `updatedAt`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /**
   * Optional column projection for the response `.returning()`. Pass a scrubbed
   * column map (e.g. `giftHeaderColumns`) for a table that carries an
   * @deprecated column which must never be serialized into an API response.
   * Defaults to all columns.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  responseColumns?: Record<string, any>;
}

/**
 * Soft-delete a single record by stamping `archived_at = now()`. Anyone
 * authenticated may archive (it replaces hard delete). 404 when the id is
 * unknown. Idempotent: re-archiving an already-archived row just refreshes the
 * timestamp.
 */
export async function archiveOne(
  req: Request,
  res: Response,
  cfg: ArchiveOneConfig,
): Promise<void> {
  const now = new Date();
  const id = paramId(req);
  // Update + audit row commit atomically (mirrors the bulk_operations pattern).
  const row = await db.transaction(async (tx) => {
    const upd = tx
      .update(cfg.table)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(cfg.table.id, id));
    const [updated] = cfg.responseColumns
      ? await upd.returning(cfg.responseColumns)
      : await upd.returning();
    if (!updated) return undefined;
    await recordAudit(tx, req, {
      action: "archive",
      entityType: cfg.entity,
      entityId: id,
      summary: `Archived ${cfg.entity}`,
    });
    return updated;
  });
  if (!row) {
    notFound(res, cfg.entity);
    return;
  }
  res.json(row);
}

/**
 * Restore a single archived record (`archived_at = null`). Admin-only —
 * enforced here, not just in the UI. 404 when the id is unknown.
 */
export async function unarchiveOne(
  req: Request,
  res: Response,
  cfg: ArchiveOneConfig,
): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const now = new Date();
  const id = paramId(req);
  const row = await db.transaction(async (tx) => {
    const upd = tx
      .update(cfg.table)
      .set({ archivedAt: null, updatedAt: now })
      .where(eq(cfg.table.id, id));
    const [updated] = cfg.responseColumns
      ? await upd.returning(cfg.responseColumns)
      : await upd.returning();
    if (!updated) return undefined;
    await recordAudit(tx, req, {
      action: "unarchive",
      entityType: cfg.entity,
      entityId: id,
      summary: `Restored ${cfg.entity}`,
    });
    return updated;
  });
  if (!row) {
    notFound(res, cfg.entity);
    return;
  }
  res.json(row);
}

interface BulkFailure {
  id: string;
  message: string;
}

export interface BulkArchiveConfig {
  /** Audit-log entity name (e.g. "people"). */
  entity: string;
  /** Drizzle table (must have `id`, `archivedAt`, `updatedAt`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Zod schema for the body ({ ids }). */
  bodySchema: ZodLike<BulkArchiveBody>;
}

/**
 * Execute a bulk-archive operation. Validates the body, loads existing ids
 * (rows not found become failures), stamps `archived_at = now()` on the rest
 * in a single UPDATE, and writes one `bulk_operations` audit row. Archiving
 * never violates FKs, so unlike bulk-delete there is no per-row savepoint —
 * the whole batch + audit row commit atomically.
 */
export async function executeBulkArchive(
  req: Request,
  res: Response,
  cfg: BulkArchiveConfig,
): Promise<void> {
  const parsed = parseOrBadRequest(cfg.bodySchema, req.body, res);
  if (!parsed) return;
  const { ids } = parsed;

  // De-duplicate ids while preserving order so the audit log mirrors exactly
  // what the user asked for.
  const seen = new Set<string>();
  const uniqueIds: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }

  const existing = (await db
    .select({ id: cfg.table.id })
    .from(cfg.table)
    .where(inArray(cfg.table.id, uniqueIds))) as { id: string }[];
  const existingIds = new Set(existing.map((r) => r.id));

  const succeededIds: string[] = [];
  const failed: BulkFailure[] = [];
  for (const id of uniqueIds) {
    if (existingIds.has(id)) succeededIds.push(id);
    else failed.push({ id, message: "not found" });
  }

  const actor = getAppUser(req);
  const now = new Date();
  const bulkOpId = newId();
  await db.transaction(async (tx) => {
    if (succeededIds.length > 0) {
      await tx
        .update(cfg.table)
        .set({ archivedAt: now, updatedAt: now })
        .where(inArray(cfg.table.id, succeededIds));
    }
    await tx.insert(bulkOperations).values({
      id: bulkOpId,
      actorUserId: actor?.id ?? "unknown",
      entity: cfg.entity,
      fields: [BULK_ARCHIVE_FIELD],
      targetIds: uniqueIds,
      succeededIds,
      failedIds: failed.map((f) => f.id),
    });
    // One human-readable summary row alongside the detailed bulk_operations
    // ledger. entityId points at the bulk_operations row, not a single record.
    await recordAudit(tx, req, {
      action: "bulk_archive",
      entityType: cfg.entity,
      entityId: bulkOpId,
      summary: `Archived ${succeededIds.length} ${cfg.entity}`,
      metadata: {
        bulkOperationId: bulkOpId,
        requested: uniqueIds.length,
        succeeded: succeededIds.length,
        failed: failed.length,
      },
    });
  });

  res.json({
    requested: uniqueIds.length,
    succeededIds,
    failed,
  });
}
