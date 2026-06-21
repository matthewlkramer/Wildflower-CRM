import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  cleanupQueue,
  opportunitiesAndPledges,
  users,
} from "@workspace/db/schema";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { ListCleanupQueueQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  notFound,
  paramId,
  parseOrBadRequest,
  parsePagination,
} from "../lib/helpers";

// Cleanup queue — records flagged as needing manual data cleanup that can't be
// auto-fixed (e.g. conditional-commitment pledges whose conditional aspect
// should be moved into the conditions field with a non-conditional stage).
//
// Each row links a target record (targetType + targetId) to a human-readable
// note. A fundraiser works the queue and either resolves (record fixed) or
// dismisses (false flag) each item; both drop the item out of the default view.
// Not admin-gated — fundraisers use it directly.

const router: IRouter = Router();
router.use(requireAuth);

// Human-readable owner label: display name, then first+last, then email.
const userNameExpr = sql<string | null>`COALESCE(
  NULLIF(${users.displayName}, ''),
  NULLIF(TRIM(CONCAT_WS(' ', ${users.firstName}, ${users.lastName})), ''),
  ${users.email}
)`;

type CleanupRow = typeof cleanupQueue.$inferSelect & {
  targetName: string | null;
  resolvedByUserName: string | null;
};

function serialize(row: CleanupRow) {
  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    targetName: row.targetName,
    reasonCode: row.reasonCode,
    note: row.note,
    status: row.status,
    flaggedAt: row.flaggedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByUserId: row.resolvedByUserId ?? null,
    resolvedByUserName: row.resolvedByUserName ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get(
  "/cleanup-queue",
  asyncHandler(async (req, res) => {
    const params = parseOrBadRequest(
      ListCleanupQueueQueryParams,
      req.query,
      res,
    );
    if (!params) return;

    const { limit, page, offset } = parsePagination(params);
    // Default view is open items only; an explicit status reveals the rest.
    const status = params.status ?? "open";
    const where = eq(cleanupQueue.status, status);

    const [rows, totalRows] = await Promise.all([
      db
        .select({
          id: cleanupQueue.id,
          targetType: cleanupQueue.targetType,
          targetId: cleanupQueue.targetId,
          reasonCode: cleanupQueue.reasonCode,
          note: cleanupQueue.note,
          status: cleanupQueue.status,
          flaggedAt: cleanupQueue.flaggedAt,
          resolvedAt: cleanupQueue.resolvedAt,
          resolvedByUserId: cleanupQueue.resolvedByUserId,
          createdAt: cleanupQueue.createdAt,
          updatedAt: cleanupQueue.updatedAt,
          // Resolve the target's display name for opportunity/pledge targets
          // (the only seeded kind). Other target types fall back to null.
          targetName: sql<string | null>`(
            SELECT ${opportunitiesAndPledges.name}
            FROM ${opportunitiesAndPledges}
            WHERE ${opportunitiesAndPledges.id} = ${cleanupQueue.targetId}
              AND ${cleanupQueue.targetType} IN ('pledge', 'opportunity')
          )`,
          resolvedByUserName: userNameExpr,
        })
        .from(cleanupQueue)
        .leftJoin(users, eq(users.id, cleanupQueue.resolvedByUserId))
        .where(where)
        .orderBy(desc(cleanupQueue.flaggedAt))
        .limit(limit)
        .offset(offset),
      db.select({ c: count() }).from(cleanupQueue).where(where),
    ]);

    res.json({
      data: rows.map((r) => serialize(r as CleanupRow)),
      pagination: { page, limit, total: Number(totalRows[0]?.c ?? 0) },
    });
  }),
);

// Shared open → terminal transition. Guards status='open' in the UPDATE WHERE so
// concurrent resolve/dismiss can't both win; 0 rows ⇒ 404 (gone) or 409 (taken).
async function transition(
  id: string,
  to: "resolved" | "dismissed",
  userId: string | null,
): Promise<{ row: CleanupRow | null; conflict: boolean }> {
  const updated = await db
    .update(cleanupQueue)
    .set({
      status: to,
      resolvedAt: new Date(),
      resolvedByUserId: userId,
      updatedAt: new Date(),
    })
    .where(and(eq(cleanupQueue.id, id), eq(cleanupQueue.status, "open")))
    .returning();

  if (updated[0]) {
    const enriched = await enrich([updated[0]]);
    return { row: enriched[0] ?? null, conflict: false };
  }

  // No row updated: either the item doesn't exist (404) or it's not open (409).
  const existing = await db
    .select({ id: cleanupQueue.id })
    .from(cleanupQueue)
    .where(eq(cleanupQueue.id, id))
    .limit(1);
  return { row: null, conflict: existing.length > 0 };
}

async function enrich(
  rows: (typeof cleanupQueue.$inferSelect)[],
): Promise<CleanupRow[]> {
  if (rows.length === 0) return [];
  const oppIds = [
    ...new Set(
      rows
        .filter(
          (r) => r.targetType === "pledge" || r.targetType === "opportunity",
        )
        .map((r) => r.targetId),
    ),
  ];
  const userIds = [
    ...new Set(rows.map((r) => r.resolvedByUserId).filter(Boolean) as string[]),
  ];

  const [oppRows, userRows] = await Promise.all([
    oppIds.length > 0
      ? db
          .select({
            id: opportunitiesAndPledges.id,
            name: opportunitiesAndPledges.name,
          })
          .from(opportunitiesAndPledges)
          .where(inArray(opportunitiesAndPledges.id, oppIds))
      : Promise.resolve([]),
    userIds.length > 0
      ? db
          .select({ id: users.id, name: userNameExpr })
          .from(users)
          .where(inArray(users.id, userIds))
      : Promise.resolve([]),
  ]);

  const oppMap = new Map(oppRows.map((o) => [o.id, o.name]));
  const userMap = new Map(userRows.map((u) => [u.id, u.name]));

  return rows.map((r) => ({
    ...r,
    targetName:
      r.targetType === "pledge" || r.targetType === "opportunity"
        ? (oppMap.get(r.targetId) ?? null)
        : null,
    resolvedByUserName: r.resolvedByUserId
      ? (userMap.get(r.resolvedByUserId) ?? null)
      : null,
  }));
}

function makeTransitionHandler(to: "resolved" | "dismissed") {
  return asyncHandler(async (req, res) => {
    const id = paramId(req);
    const { row, conflict } = await transition(
      id,
      to,
      getAppUser(req)?.id ?? null,
    );
    if (row) {
      res.json(serialize(row));
      return;
    }
    if (conflict) {
      res.status(409).json({
        error: "conflict",
        message: "This item is no longer open.",
      });
      return;
    }
    notFound(res, "cleanup item");
  });
}

router.post("/cleanup-queue/:id/resolve", makeTransitionHandler("resolved"));
router.post("/cleanup-queue/:id/dismiss", makeTransitionHandler("dismissed"));

export default router;
