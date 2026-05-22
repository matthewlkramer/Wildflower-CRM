import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { giftAllocations } from "@workspace/db/schema";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import {
  ListGiftAllocationsQueryParams,
  CreateGiftAllocationBody,
  UpdateGiftAllocationBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/gift-allocations",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListGiftAllocationsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.giftId) filters.push(eq(giftAllocations.giftId, q.giftId));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(giftAllocations).where(where).orderBy(desc(giftAllocations.createdAt)).limit(limit).offset(offset),
      db.select({ value: count() }).from(giftAllocations).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.post(
  "/gift-allocations",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateGiftAllocationBody, req.body, res);
    if (!body) return;
    const [row] = await db.insert(giftAllocations).values({ id: newId(), ...body }).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/gift-allocations/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateGiftAllocationBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(giftAllocations)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(giftAllocations.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "allocation");
    res.json(row);
  }),
);

router.delete(
  "/gift-allocations/:id",
  asyncHandler(async (req, res) => {
    await db.delete(giftAllocations).where(eq(giftAllocations.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
