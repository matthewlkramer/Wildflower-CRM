import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { auditLog, users } from "@workspace/db/schema";
import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
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

// A real ISO calendar date (YYYY-MM-DD). Format-only checks let "2026-13-40"
// through to the date comparison and raise a Postgres 500, so verify the value
// round-trips through Date before we build the query.
function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Chicago calendar day of an audit entry. `created_at` is `timestamp without
// time zone` storing UTC wall-clock (the session runs in UTC), so we interpret
// it as UTC then convert to America/Chicago before taking the date — matching
// the timezone the rest of the app uses. The column is written table-qualified
// on purpose: `users` (the LEFT JOIN target) also has a `created_at` column, and
// interpolating `${auditLog.createdAt}` would render it as the bare, ambiguous
// `"created_at"`.
const chicagoDayExpr = sql`(audit_log.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')::date`;

// Escape ILIKE wildcards so a literal % or _ in the search box matches itself.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

router.get(
  "/audit-log",
  asyncHandler(async (req, res) => {
    // Admin-only — the timeline can reference any record in the system.
    if (!requireAdmin(req, res)) return;

    const q = parseOrBadRequest(ListAuditLogQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);

    // Validate raw date params before they reach the `::date` cast — a
    // format-only check still lets impossible dates (e.g. 2026-13-40) raise a
    // Postgres 500 instead of a clean 400.
    if (q.dateFrom && !isValidIsoDate(q.dateFrom)) {
      res
        .status(400)
        .json({ error: "dateFrom must be a valid YYYY-MM-DD date." });
      return;
    }
    if (q.dateTo && !isValidIsoDate(q.dateTo)) {
      res.status(400).json({ error: "dateTo must be a valid YYYY-MM-DD date." });
      return;
    }

    const filters: SQL[] = [];
    if (q.entityType) filters.push(eq(auditLog.entityType, q.entityType));
    if (q.entityId) filters.push(eq(auditLog.entityId, q.entityId));
    if (q.actorUserId) filters.push(eq(auditLog.actorUserId, q.actorUserId));
    if (q.action) filters.push(eq(auditLog.action, q.action));

    // Free-text: case-insensitive partial match across the entry summary, the
    // joined actor name/email, and the field-change diffs (JSON cast to text),
    // OR-ed together then AND-ed with the rest.
    const search = q.search?.trim();
    if (search) {
      const like = `%${escapeLike(search)}%`;
      filters.push(
        or(
          ilike(auditLog.summary, like),
          sql`${actorNameExpr} ILIKE ${like}`,
          ilike(users.email, like),
          sql`audit_log.changes::text ILIKE ${like}`,
        )!,
      );
    }

    // Chicago-day bounds (both inclusive).
    if (q.dateFrom) filters.push(sql`${chicagoDayExpr} >= ${q.dateFrom}::date`);
    if (q.dateTo) filters.push(sql`${chicagoDayExpr} <= ${q.dateTo}::date`);

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
      // Same JOIN + WHERE as the rows query so the count matches the filtered
      // set (the search/date filters reference the joined `users` columns).
      db
        .select({ value: count() })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorUserId))
        .where(where),
    ]);

    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

export default router;
