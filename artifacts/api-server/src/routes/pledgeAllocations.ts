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
import { derivePledgeAllocationCoding } from "../lib/revenueCoding";

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
    const coding = await derivePledgeAllocationCoding(body.pledgeOrOpportunityId, {
      restrictionType: body.restrictionType,
      entityId: body.entityId,
      intendedUsage: body.intendedUsage,
      fundableProjectId: body.fundableProjectId,
      regionIds: body.regionIds,
    });
    // A concrete school recipient implies the funds flow directly to a school.
    const directToSchool = body.schoolRecipientId ? true : body.directToSchool;
    const [row] = await db
      .insert(pledgeAllocations)
      .values({
        id: newId(),
        ...body,
        directToSchool,
        objectCode: coding.objectCode,
        revenueLocation: coding.revenueLocation,
        revenueClass: coding.revenueClass,
        codingFlags: coding.codingFlags,
      })
      .returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/pledge-allocations/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdatePledgeAllocationBody, req.body, res);
    if (!body) return;
    const id = paramId(req);
    const [existing] = await db.select().from(pledgeAllocations).where(eq(pledgeAllocations.id, id));
    if (!existing) return notFound(res, "allocation");
    const merged = {
      pledgeOrOpportunityId:
        body.pledgeOrOpportunityId !== undefined ? body.pledgeOrOpportunityId : existing.pledgeOrOpportunityId,
      restrictionType: body.restrictionType !== undefined ? body.restrictionType : existing.restrictionType,
      entityId: body.entityId !== undefined ? body.entityId : existing.entityId,
      intendedUsage: body.intendedUsage !== undefined ? body.intendedUsage : existing.intendedUsage,
      fundableProjectId: body.fundableProjectId !== undefined ? body.fundableProjectId : existing.fundableProjectId,
      regionIds: body.regionIds !== undefined ? body.regionIds : existing.regionIds,
    };
    const coding = await derivePledgeAllocationCoding(merged.pledgeOrOpportunityId, merged);
    // Keep schoolRecipientId <-> directToSchool coherent: a concrete school
    // implies direct-to-school; explicitly unchecking direct-to-school clears
    // the school link. Only the keys the caller actually touched are overridden.
    const schoolCoherence: Partial<typeof pledgeAllocations.$inferInsert> = {};
    if (body.schoolRecipientId) {
      schoolCoherence.schoolRecipientId = body.schoolRecipientId;
      schoolCoherence.directToSchool = true;
    } else if (body.directToSchool === false) {
      schoolCoherence.schoolRecipientId = null;
      schoolCoherence.directToSchool = false;
    }
    const [row] = await db
      .update(pledgeAllocations)
      .set({
        ...body,
        ...schoolCoherence,
        objectCode: coding.objectCode,
        revenueLocation: coding.revenueLocation,
        revenueClass: coding.revenueClass,
        codingFlags: coding.codingFlags,
        updatedAt: new Date(),
      })
      .where(eq(pledgeAllocations.id, id))
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
