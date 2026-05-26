import type { Response } from "express";
import { db } from "@workspace/db";
import { bulkOperations } from "@workspace/db/schema";
import { eq, inArray, type SQL } from "drizzle-orm";
import { newId, parseOrBadRequest } from "./helpers";
import type { Request } from "express";
import { getAppUser } from "./appRequest";

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

export interface BulkUpdateConfig<Row, P extends object> {
  /** Audit-log entity name (e.g. "people"). */
  entity: string;
  /** Drizzle table. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Zod schema for the full body (ids + patch). */
  bodySchema: ZodLike<BulkUpdateBody<P>>;
  /**
   * Whitelist of patch keys this endpoint will write. Any extra keys
   * from the (zod-validated) body are silently dropped — defence in
   * depth against the body schema accidentally allowing a non-bulk
   * field through. Must be a subset of writable columns on `table`.
   */
  allowedFields: ReadonlyArray<keyof P & string>;
  /**
   * Optional per-row pre-check. Receives the existing row and the
   * (already-whitelisted) patch; returns an error string to fail the
   * row, or null to proceed.
   */
  validateRow?: RowValidator<Row, Partial<P>>;
}

interface BulkFailure {
  id: string;
  message: string;
}

/**
 * Execute a bulk-update operation. Validates the body, loads existing
 * rows, runs the per-entity invariant check on each row's merged
 * post-update state, performs the writes per-row (so one row's failure
 * doesn't block the others), and writes a single `bulk_operations`
 * audit row capturing both successes and failures.
 *
 * Returns the JSON response the route handler should send; the route
 * is responsible for actually writing to `res` so we keep this
 * framework-agnostic enough for future reuse.
 */
export async function executeBulkUpdate<Row extends Record<string, unknown>, P extends object>(
  req: Request,
  res: Response,
  cfg: BulkUpdateConfig<Row, P>,
): Promise<void> {
  const parsed = parseOrBadRequest(cfg.bodySchema, req.body, res);
  if (!parsed) return;
  const { ids, patch } = parsed;

  // Whitelist patch keys.
  const cleanPatch: Partial<P> = {};
  for (const k of cfg.allowedFields) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      (cleanPatch as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
    }
  }
  const touchedFields = Object.keys(cleanPatch);
  if (touchedFields.length === 0) {
    res.status(400).json({
      error: "validation_error",
      message: "patch must contain at least one writable field",
    });
    return;
  }

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
      await db
        .update(cfg.table)
        .set({ ...cleanPatch, updatedAt: new Date() })
        .where(eq(cfg.table.id, id) as SQL);
      succeededIds.push(id);
    } catch (e) {
      failed.push({
        id,
        message: e instanceof Error ? e.message : "update failed",
      });
    }
  }

  // Audit log — single row per bulk call. Use the resolved app user
  // (provisioned by requireAuth) so we record our internal user id
  // rather than the raw Clerk id.
  const actor = getAppUser(req);
  await db.insert(bulkOperations).values({
    id: newId(),
    actorUserId: actor?.id ?? "unknown",
    entity: cfg.entity,
    fields: touchedFields,
    targetIds: uniqueIds,
    succeededIds,
    failedIds: failed.map((f) => f.id),
  });

  res.json({
    requested: uniqueIds.length,
    succeededIds,
    failed,
  });
}
