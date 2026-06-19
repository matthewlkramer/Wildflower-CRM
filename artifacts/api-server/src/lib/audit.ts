import type { Request } from "express";
import { db } from "@workspace/db";
import { auditLog, type AuditFieldChange } from "@workspace/db/schema";
import { getAppUser } from "./appRequest";
import { newId } from "./helpers";

/**
 * Universal audit-log helper. See `lib/db/src/schema/auditLog.ts` for the table
 * rationale (entity-scoped human timeline, parallel to the detailed
 * `bulk_operations` ledger).
 *
 * Two write paths:
 *   - `recordAudit(execOrTx, req, event)` — atomic. Pass a transaction handle
 *     to commit the audit row in lockstep with the mutation (used by the shared
 *     archive/bulk helpers and merges, mirroring how `bulk_operations` is
 *     written). Throws if the insert fails.
 *   - `safeRecordAudit(req, event)` — best-effort, never throws. Used after a
 *     standalone create/update has already committed, so an audit failure can
 *     never break a donor save.
 */

export type AuditAction =
  | "create"
  | "update"
  | "archive"
  | "unarchive"
  | "delete"
  | "merge"
  | "bulk_update"
  | "bulk_archive";

export interface AuditEvent {
  action: AuditAction;
  entityType: string;
  entityId: string;
  summary?: string | null;
  changes?: AuditFieldChange[] | null;
  metadata?: Record<string, unknown> | null;
}

// Anything with a drizzle-style `.insert()` — the base `db` client or a
// transaction handle. Mirrors the loose `TX = any` convention used by the
// bulk-update helper.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = { insert: (table: any) => any };

// Normalize a value for JSON storage / comparison: Date -> ISO string so the
// jsonb diff is stable and comparable across a select (Date) and a returning
// (Date) row.
function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/**
 * Compute field-level `{ field, from, to }` changes by comparing `before` and
 * `after` over the given keys (typically `Object.keys(patchBody)`). Only keys
 * whose value actually changed are emitted, so a no-op PATCH records nothing.
 */
export function diffChanges(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  keys: readonly string[],
): AuditFieldChange[] {
  const changes: AuditFieldChange[] = [];
  for (const field of keys) {
    const from = before?.[field];
    const to = after?.[field];
    if (!valuesEqual(from, to)) {
      changes.push({ field, from: normalize(from), to: normalize(to) });
    }
  }
  return changes;
}

export async function recordAudit(
  exec: Executor,
  req: Request,
  event: AuditEvent,
): Promise<void> {
  const actor = getAppUser(req);
  await exec.insert(auditLog).values({
    id: newId(),
    actorUserId: actor?.id ?? null,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    summary: event.summary ?? null,
    changes: event.changes && event.changes.length > 0 ? event.changes : null,
    metadata: event.metadata ?? null,
  });
}

export async function safeRecordAudit(
  req: Request,
  event: AuditEvent,
): Promise<void> {
  try {
    await recordAudit(db, req, event);
  } catch (e) {
    const log = (req as unknown as { log?: { error?: (...args: unknown[]) => void } }).log;
    log?.error?.({ err: e, event }, "recordAudit failed");
  }
}

/**
 * Convenience for a standalone create handler: best-effort, fired after the row
 * is committed.
 */
export async function auditCreate(
  req: Request,
  entityType: string,
  entityId: string,
  summary?: string | null,
  metadata?: Record<string, unknown> | null,
): Promise<void> {
  await safeRecordAudit(req, {
    action: "create",
    entityType,
    entityId,
    summary,
    metadata,
  });
}

/**
 * Convenience for a standalone update handler: diffs `before`/`after` over the
 * patched keys and records a best-effort `update` row. No-op when nothing
 * material changed.
 */
export async function auditUpdate(
  req: Request,
  entityType: string,
  entityId: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  keys: readonly string[],
  summary?: string | null,
): Promise<void> {
  const changes = diffChanges(before, after, keys);
  if (changes.length === 0) return;
  await safeRecordAudit(req, {
    action: "update",
    entityType,
    entityId,
    summary,
    changes,
  });
}
