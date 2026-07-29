import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { auditLog, users } from "@workspace/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { asyncHandler } from "../../lib/helpers";
import { getAppUser } from "../../lib/appRequest";
import { type ReconUndoKind } from "../../lib/reconciliationAudit";

/**
 * GET /reconciliation/workbench-recent-changes — the signed-in reviewer's
 * recent reversible reconciliation actions.
 *
 * The rail exists primarily as a quick undo surface, not as a team-wide audit
 * feed. Intermediate/non-reversible actions (for example, setting a donor
 * immediately before creating a gift) remain in audit_log but do not displace
 * the actions this reviewer can actually undo. The full audit log remains the
 * authority for team-wide history.
 */
const router: IRouter = Router();

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

function undoOf(
  metadata: unknown,
): { kind: ReconUndoKind; targetId: string } | null {
  if (!metadata || typeof metadata !== "object") return null;
  const u = (metadata as Record<string, unknown>).undo;
  if (!u || typeof u !== "object") return null;
  const { kind, targetId } = u as Record<string, unknown>;
  if (typeof kind !== "string" || !UNDO_KINDS.has(kind)) return null;
  if (typeof targetId !== "string" || !targetId) return null;
  return { kind: kind as ReconUndoKind, targetId };
}

router.get(
  "/reconciliation/workbench-recent-changes",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user?.id) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Keep the proven reconciliation-domain query shape, then apply the
    // reviewer/undo filters in memory. A wider window prevents intermediate
    // non-reversible events from displacing useful undo entries.
    const rows = await db
      .select({
        id: auditLog.id,
        at: auditLog.createdAt,
        actorUserId: auditLog.actorUserId,
        actorName: actorNameExpr.as("actor_name"),
        summary: auditLog.summary,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(sql`${auditLog.metadata} ->> 'domain' = 'reconciliation'`)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(500);

    const items = rows
      .filter((row) => row.actorUserId === user.id)
      .map((row) => ({
        id: row.id,
        at: row.at,
        actorName: row.actorName,
        summary: row.summary ?? "",
        undo: undoOf(row.metadata),
      }))
      .slice(0, 20);

    res.json({ items });
  }),
);

export default router;
