import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { households, peopleEntityRoles, emails, addresses } from "@workspace/db/schema";
import { and, asc, count, eq, ilike, type SQL } from "drizzle-orm";
import {
  ListHouseholdsQueryParams,
  CreateHouseholdBody,
  UpdateHouseholdBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/households",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListHouseholdsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) filters.push(ilike(households.name, `%${q.search}%`));
    if (q.active !== undefined) filters.push(eq(households.active, q.active));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(households).where(where).orderBy(asc(households.name)).limit(limit).offset(offset),
      db.select({ value: count() }).from(households).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/households/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const row = await db.select().from(households).where(eq(households.id, id)).then((r) => r[0]);
    if (!row) return notFound(res, "household");
    const [people, emailRows, addressRows] = await Promise.all([
      db.select().from(peopleEntityRoles).where(eq(peopleEntityRoles.householdId, id)),
      db.select().from(emails).where(eq(emails.householdId, id)),
      db.select().from(addresses).where(eq(addresses.householdId, id)),
    ]);
    res.json({ ...row, people, emails: emailRows, addresses: addressRows });
  }),
);

router.post(
  "/households",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateHouseholdBody, req.body, res);
    if (!body) return;
    const [row] = await db.insert(households).values({ id: newId(), ...body } as any).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/households/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateHouseholdBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(households)
      .set({ ...body, updatedAt: new Date() } as any)
      .where(eq(households.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "household");
    res.json(row);
  }),
);

router.delete(
  "/households/:id",
  asyncHandler(async (req, res) => {
    await db.delete(households).where(eq(households.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
