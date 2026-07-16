import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { auditLog, users } from "@workspace/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { asyncHandler } from "../../lib/helpers";
import { type ReconUndoKind } from "../../lib/reconciliationAudit";

/**
 * GET /reconciliation/workbench-recent-changes — the workbench's recent-changes
 * rail. Hydrates from the audit log's reconciliation-domain entries (every
 * human queue action records exactly one, tagged metadata.domain =
 * "reconciliation" via reconAudit). The undo pointer is read back verbatim from
 * the metadata — validity is NOT re-checked here; the target endpoint keeps its
 * own guards and 409s cleanly if state moved on. Team-wide (requireAuth is
 * applied by the reconciliation composition root; NOT admin-gated — unlike the
 * full audit-log page, this surfaces only reconciliation queue actions).
 */
const router: IRouter = Router();

// Human-readable actor label: display name, then first+last, then email.
// (Same precedence as the audit-log page.)
const actorNameExpr = sql<string | null>`COALESCE(
  NULLIF(${users.displayName}, ''),
  NULLIF(TRIM(CONCAT_WS(' ', ${users.firstName}, ${users.lastName})), ''),
  ${users.email}
)`;

const UNDO_KINDS: ReadonlySet<string> = new Set([
  "revert_staged_payment",
  "reinclude_staged_payment",
  "revert_stripe_charge",
  "reinclude_stripe_charge",
] satisfies ReconUndoKind[]);

// Defensive read of the undo pointer out of the stored metadata JSON — a
// malformed/legacy entry degrades to "no undo" instead of breaking the rail.
function undoOf(
  metadata: unknown,
): { kind: string; targetId: string } | null {
  if (!metadata || typeof metadata !== "object") return null;
  const u = (metadata as Record<string, unknown>).undo;
  if (!u || typeof u !== "object") return null;
  const { kind, targetId } = u as Record<string, unknown>;
  if (typeof kind !== "string" || !UNDO_KINDS.has(kind)) return null;
  if (typeof targetId !== "string" || !targetId) return null;
  return { kind, targetId };
}

router.get(
  "/workbench-recent-changes",
  asyncHandler(async (_req, res) => {
    const rows = await db
      .select({
        id: auditLog.id,
        at: auditLog.createdAt,
        actorName: actorNameExpr.as("actor_name"),
        summary: auditLog.summary,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(sql`${auditLog.metadata} ->> 'domain' = 'reconciliation'`)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(20);

    res.json({
      items: rows.map((r) => ({
        id: r.id,
        at: r.at,
        actorName: r.actorName,
        summary: r.summary ?? "",
        undo: undoOf(r.metadata),
      })),
    });
  }),
);

export default router;
