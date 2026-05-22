import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { opportunitiesAndPledges, pledgeAllocations, giftsAndPayments } from "@workspace/db/schema";
import { and, count, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import {
  ListOpportunitiesAndPledgesQueryParams,
  CreateOpportunityOrPledgeBody,
  UpdateOpportunityOrPledgeBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/opportunities-and-pledges",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListOpportunitiesAndPledgesQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) filters.push(ilike(opportunitiesAndPledges.name, `%${q.search}%`));
    if (q.status) filters.push(eq(opportunitiesAndPledges.status, q.status));
    if (q.stage) filters.push(eq(opportunitiesAndPledges.stage, q.stage));
    if (q.type) filters.push(eq(opportunitiesAndPledges.type, q.type));
    if (q.funderId) filters.push(eq(opportunitiesAndPledges.funderId, q.funderId));
    if (q.ownerUserId) filters.push(eq(opportunitiesAndPledges.ownerUserId, q.ownerUserId));
    if (q.entityId) filters.push(sql`${q.entityId} = ANY(${opportunitiesAndPledges.entityIds})`);
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(opportunitiesAndPledges).where(where).orderBy(desc(opportunitiesAndPledges.projectedCloseDate)).limit(limit).offset(offset),
      db.select({ value: count() }).from(opportunitiesAndPledges).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/opportunities-and-pledges/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const row = await db.select().from(opportunitiesAndPledges).where(eq(opportunitiesAndPledges.id, id)).then((r) => r[0]);
    if (!row) return notFound(res, "opportunity");
    const [allocations, payments] = await Promise.all([
      db.select().from(pledgeAllocations).where(eq(pledgeAllocations.pledgeOrOpportunityId, id)),
      db.select().from(giftsAndPayments).where(eq(giftsAndPayments.paymentOnPledgeId, id)),
    ]);
    res.json({ ...row, allocations, payments });
  }),
);

router.post(
  "/opportunities-and-pledges",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateOpportunityOrPledgeBody, req.body, res);
    if (!body) return;
    const [row] = await db.insert(opportunitiesAndPledges).values({ id: newId(), ...body }).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/opportunities-and-pledges/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateOpportunityOrPledgeBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(opportunitiesAndPledges)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(opportunitiesAndPledges.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "opportunity");
    res.json(row);
  }),
);

router.delete(
  "/opportunities-and-pledges/:id",
  asyncHandler(async (req, res) => {
    await db.delete(opportunitiesAndPledges).where(eq(opportunitiesAndPledges.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
