import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { funders, peopleEntityRoles, emails, addresses } from "@workspace/db/schema";
import { and, asc, count, eq, ilike, type SQL } from "drizzle-orm";
import {
  ListFundersQueryParams,
  CreateFunderBody,
  UpdateFunderBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/funders",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListFundersQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) filters.push(ilike(funders.name, `%${q.search}%`));
    if (q.subtype) filters.push(eq(funders.fundingEntitySubtype, q.subtype));
    if (q.activeStatus) filters.push(eq(funders.activeStatus, q.activeStatus));
    if (q.connectionStatus) filters.push(eq(funders.connectionStatus, q.connectionStatus));
    if (q.enthusiasm) filters.push(eq(funders.enthusiasm, q.enthusiasm));
    if (q.capacityRating) filters.push(eq(funders.capacityRating, q.capacityRating));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(funders).where(where).orderBy(asc(funders.name)).limit(limit).offset(offset),
      db.select({ value: count() }).from(funders).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/funders/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const row = await db.select().from(funders).where(eq(funders.id, id)).then((r) => r[0]);
    if (!row) return notFound(res, "funder");
    const [people, emailRows, addressRows] = await Promise.all([
      db.select().from(peopleEntityRoles).where(eq(peopleEntityRoles.funderId, id)),
      db.select().from(emails).where(eq(emails.funderId, id)),
      db.select().from(addresses).where(eq(addresses.funderId, id)),
    ]);
    res.json({ ...row, people, emails: emailRows, addresses: addressRows });
  }),
);

router.post(
  "/funders",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateFunderBody, req.body, res);
    if (!body) return;
    const [row] = await db.insert(funders).values({ id: newId(), ...body }).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/funders/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateFunderBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(funders)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(funders.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "funder");
    res.json(row);
  }),
);

router.delete(
  "/funders/:id",
  asyncHandler(async (req, res) => {
    await db.delete(funders).where(eq(funders.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
