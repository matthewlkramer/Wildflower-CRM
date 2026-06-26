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
import { giftAllocationCodingPreview } from "../lib/revenueCoding";

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
    const [row] = await db
      .insert(giftAllocations)
      .values({
        id: newId(),
        ...body,
      })
      .returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/gift-allocations/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateGiftAllocationBody, req.body, res);
    if (!body) return;
    const id = paramId(req);
    const [existing] = await db.select().from(giftAllocations).where(eq(giftAllocations.id, id));
    if (!existing) return notFound(res, "allocation");
    const [row] = await db
      .update(giftAllocations)
      .set({
        ...body,
        updatedAt: new Date(),
      })
      .where(eq(giftAllocations.id, id))
      .returning();
    if (!row) return notFound(res, "allocation");
    res.json(row);
  }),
);

// On-demand revenue-coding preview (not persisted on the allocation). The
// authoritative coding lives on the QuickBooks payment record; this surfaces a
// live "coding instructions" preview derived from the allocation's scope.
router.get(
  "/gift-allocations/:id/coding-preview",
  asyncHandler(async (req, res) => {
    const preview = await giftAllocationCodingPreview(paramId(req));
    if (!preview) return notFound(res, "allocation");
    res.json(preview);
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
