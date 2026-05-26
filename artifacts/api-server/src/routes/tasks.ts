import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { tasks } from "@workspace/db/schema";
import {
  and,
  desc,
  count,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  ListTasksQueryParams,
  CreateTaskBody,
  UpdateTaskBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  newId,
  normalizeArrayQuery,
  notFound,
  paramId,
  parseOrBadRequest,
  parsePagination,
} from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

const TASKS_ARRAY_PARAMS = ["status"] as const;

router.get(
  "/tasks",
  asyncHandler(async (req, res) => {
    const normalized = normalizeArrayQuery(
      req.query as Record<string, unknown>,
      TASKS_ARRAY_PARAMS,
    );
    const q = parseOrBadRequest(ListTasksQueryParams, normalized, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) {
      const term = `%${q.search}%`;
      const orClause = or(ilike(tasks.title, term), ilike(tasks.description, term));
      if (orClause) filters.push(orClause);
    }
    if (q.status && q.status.length > 0) filters.push(inArray(tasks.status, q.status));
    if (q.assigneeUserId) filters.push(eq(tasks.assigneeUserId, q.assigneeUserId));
    if (q.createdByUserId) filters.push(eq(tasks.createdByUserId, q.createdByUserId));
    if (q.dueBefore) filters.push(lte(tasks.dueDate, q.dueBefore));
    if (q.dueAfter) filters.push(gte(tasks.dueDate, q.dueAfter));
    if (q.personId) filters.push(sql`${tasks.personIds} @> ARRAY[${q.personId}]::text[]`);
    if (q.funderId) filters.push(sql`${tasks.funderIds} @> ARRAY[${q.funderId}]::text[]`);
    if (q.householdId) filters.push(sql`${tasks.householdIds} @> ARRAY[${q.householdId}]::text[]`);
    if (q.opportunityId) filters.push(sql`${tasks.opportunityIds} @> ARRAY[${q.opportunityId}]::text[]`);
    if (q.giftId) filters.push(sql`${tasks.giftIds} @> ARRAY[${q.giftId}]::text[]`);
    if (q.mentionUserId) filters.push(sql`${tasks.mentionUserIds} @> ARRAY[${q.mentionUserId}]::text[]`);
    const where = filters.length ? and(...filters) : undefined;
    // Order: nulls-last on due_date, then ascending so soonest-due rises.
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select()
        .from(tasks)
        .where(where)
        .orderBy(sql`${tasks.dueDate} ASC NULLS LAST`, desc(tasks.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(tasks).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/tasks/:id",
  asyncHandler(async (req, res) => {
    const row = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, paramId(req)))
      .then((r) => r[0]);
    if (!row) return notFound(res, "task");
    res.json(row);
  }),
);

router.post(
  "/tasks",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateTaskBody, req.body, res);
    if (!body) return;
    const user = getAppUser(req);
    if (!user) return notFound(res, "user");
    const [row] = await db
      .insert(tasks)
      .values({
        id: newId(),
        createdByUserId: user.id,
        ...body,
        completedAt: body.status === "done" ? new Date() : null,
      })
      .returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/tasks/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateTaskBody, req.body, res);
    if (!body) return;
    // Auto-stamp completedAt only on done<->non-done TRANSITIONS so the
    // timestamp records the actual completion moment, not every later edit.
    const patch: Record<string, unknown> = { ...body, updatedAt: new Date() };
    if (body.status) {
      const existing = await db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, paramId(req)))
        .then((r) => r[0]);
      if (!existing) return notFound(res, "task");
      if (body.status === "done" && existing.status !== "done") {
        patch.completedAt = new Date();
      } else if (body.status !== "done" && existing.status === "done") {
        patch.completedAt = null;
      }
    }
    const [row] = await db
      .update(tasks)
      .set(patch)
      .where(eq(tasks.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "task");
    res.json(row);
  }),
);

router.delete(
  "/tasks/:id",
  asyncHandler(async (req, res) => {
    await db.delete(tasks).where(eq(tasks.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
