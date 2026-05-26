import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { interactions } from "@workspace/db/schema";
import { and, desc, count, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  ListInteractionsQueryParams,
  CreateInteractionBody,
  UpdateInteractionBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
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

const INTERACTIONS_ARRAY_PARAMS = ["kind"] as const;

router.get(
  "/interactions",
  asyncHandler(async (req, res) => {
    const normalizedQuery = normalizeArrayQuery(
      req.query as Record<string, unknown>,
      INTERACTIONS_ARRAY_PARAMS,
    );
    const q = parseOrBadRequest(ListInteractionsQueryParams, normalizedQuery, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) {
      const term = `%${q.search}%`;
      const orClause = or(
        ilike(interactions.summary, term),
        ilike(interactions.notes, term),
        ilike(interactions.location, term),
      );
      if (orClause) filters.push(orClause);
    }
    if (q.kind && q.kind.length > 0) filters.push(inArray(interactions.kind, q.kind));
    if (q.ownerUserId) filters.push(eq(interactions.ownerUserId, q.ownerUserId));
    // Array containment — same `@>` slug-array pattern used elsewhere in the
    // codebase (see people.regionIds). Cheap thanks to the GIN indexes.
    if (q.personId) {
      filters.push(sql`${interactions.personIds} @> ARRAY[${q.personId}]::text[]`);
    }
    if (q.funderId) {
      filters.push(sql`${interactions.funderIds} @> ARRAY[${q.funderId}]::text[]`);
    }
    if (q.householdId) {
      filters.push(
        sql`${interactions.householdIds} @> ARRAY[${q.householdId}]::text[]`,
      );
    }
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select()
        .from(interactions)
        .where(where)
        .orderBy(desc(interactions.occurredAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(interactions).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/interactions/:id",
  asyncHandler(async (req, res) => {
    const row = await db
      .select()
      .from(interactions)
      .where(eq(interactions.id, paramId(req)))
      .then((r) => r[0]);
    if (!row) return notFound(res, "interaction");
    res.json(row);
  }),
);

router.post(
  "/interactions",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateInteractionBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .insert(interactions)
      .values({
        id: newId(),
        ...body,
        occurredAt: new Date(body.occurredAt),
      })
      .returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/interactions/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateInteractionBody, req.body, res);
    if (!body) return;
    const { occurredAt, ...rest } = body;
    const [row] = await db
      .update(interactions)
      .set({
        ...rest,
        ...(occurredAt !== undefined
          ? { occurredAt: new Date(occurredAt) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(interactions.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "interaction");
    res.json(row);
  }),
);

router.delete(
  "/interactions/:id",
  asyncHandler(async (req, res) => {
    await db.delete(interactions).where(eq(interactions.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
