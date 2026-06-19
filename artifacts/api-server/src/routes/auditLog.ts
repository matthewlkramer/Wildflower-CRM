import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { auditLog, users } from "@workspace/db/schema";
import { and, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { ListAuditLogQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireAdmin } from "../lib/archive";
import { asyncHandler, parseOrBadRequest, parsePagination } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

// Human-readable actor label: display name, then first+last, then email.
const actorNameExpr = sql<string | null>`COALESCE(
  NULLIF(${users.displayName}, ''),
  NULLIF(TRIM(CONCAT_WS(' ', ${users.firstName}, ${users.lastName})), ''),
  ${users.email}
)`;

router.get(
  "/audit-log",
  asyncHandler(async (req, res) => {
    // Admin-only — the timeline can reference any record in the system.
    if (!requireAdmin(req, res)) return;

    const q = parseOrBadRequest(ListAuditLogQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);

    const filters: SQL[] = [];
    if (q.entityType) filters.push(eq(auditLog.entityType, q.entityType));
    if (q.entityId) filters.push(eq(auditLog.entityId, q.entityId));
    if (q.actorUserId) filters.push(eq(auditLog.actorUserId, q.actorUserId));
    if (q.action) filters.push(eq(auditLog.action, q.action));
    const where = filters.length ? and(...filters) : undefined;

    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select({
          id: auditLog.id,
          actorUserId: auditLog.actorUserId,
          actorName: actorNameExpr.as("actor_name"),
          actorEmail: users.email,
          action: auditLog.action,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          summary: auditLog.summary,
          changes: auditLog.changes,
          metadata: auditLog.metadata,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorUserId))
        .where(where)
        .orderBy(desc(auditLog.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(auditLog).where(where),
    ]);

    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

export default router;
