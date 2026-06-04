import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { addresses } from "@workspace/db/schema";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import {
  ListAddressesQueryParams,
  CreateAddressBody,
  UpdateAddressBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/addresses",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListAddressesQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.personId) filters.push(eq(addresses.personId, q.personId));
    
    if (q.organizationId) filters.push(eq(addresses.organizationId, q.organizationId));
    if (q.paymentIntermediaryId) filters.push(eq(addresses.paymentIntermediaryId, q.paymentIntermediaryId));
    if (q.householdId) filters.push(eq(addresses.householdId, q.householdId));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(addresses).where(where).orderBy(desc(addresses.createdAt)).limit(limit).offset(offset),
      db.select({ value: count() }).from(addresses).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.post(
  "/addresses",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateAddressBody, req.body, res);
    if (!body) return;
    const [row] = await db.insert(addresses).values({ id: newId(), ...body }).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/addresses/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateAddressBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(addresses)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(addresses.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "address");
    res.json(row);
  }),
);

router.delete(
  "/addresses/:id",
  asyncHandler(async (req, res) => {
    await db.delete(addresses).where(eq(addresses.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
