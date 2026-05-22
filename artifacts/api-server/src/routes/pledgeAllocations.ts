import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { pledgeAllocations } from "@workspace/db/schema";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import {
  ListPledgeAllocationsQueryParams,
  CreatePledgeAllocationBody,
  UpdatePledgeAllocationBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/pledge-allocations",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListPledgeAllocationsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.pledgeOrOpportunityId) filters.push(eq(pledgeAllocations.pledgeOrOpportunityId, q.pledgeOrOpportunityId));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(pledgeAllocations).where(where).orderBy(desc(pledgeAllocations.createdAt)).limit(limit).offset(offset),
      db.select({ value: count() }).from(pledgeAllocations).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.post(
  "/pledge-allocations",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreatePledgeAllocationBody, req.body, res);
    if (!body) return;
    const [row] = await db.insert(pledgeAllocations).values({ id: newId(), ...body }).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/pledge-allocations/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdatePledgeAllocationBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(pledgeAllocations)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(pledgeAllocations.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "allocation");
    res.json(row);
  }),
);

router.delete(
  "/pledge-allocations/:id",
  asyncHandler(async (req, res) => {
    await db.delete(pledgeAllocations).where(eq(pledgeAllocations.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
