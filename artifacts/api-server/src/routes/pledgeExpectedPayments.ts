import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { pledgeExpectedPayments, opportunitiesAndPledges } from "@workspace/db/schema";
import { and, asc, count, eq, type SQL } from "drizzle-orm";
import {
  ListPledgeExpectedPaymentsQueryParams,
  CreatePledgeExpectedPaymentBody,
  UpdatePledgeExpectedPaymentBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";
import { resolvePledgeFreezeById, respondFrozen } from "../lib/freezeGuard";

// Task #788 — installment schedule (expected payments) for FIXED-COMMITMENT
// pledges. Sole authority for installment scheduling; replaces the deprecated
// pledge_allocations.expected_payment_date convention. Pure cash-timing plan:
// scope stays on pledge allocations. Freeze-guarded by the parent pledge's
// governing fiscal year, mirroring pledge-allocations.
const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/pledge-expected-payments",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListPledgeExpectedPaymentsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.pledgeOrOpportunityId) filters.push(eq(pledgeExpectedPayments.pledgeOrOpportunityId, q.pledgeOrOpportunityId));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select()
        .from(pledgeExpectedPayments)
        .where(where)
        .orderBy(asc(pledgeExpectedPayments.expectedDate))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(pledgeExpectedPayments).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.post(
  "/pledge-expected-payments",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreatePledgeExpectedPaymentBody, req.body, res);
    if (!body) return;
    const [parent] = await db
      .select({ id: opportunitiesAndPledges.id })
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, body.pledgeOrOpportunityId));
    if (!parent) return notFound(res, "opportunity");
    const freeze = await resolvePledgeFreezeById(body.pledgeOrOpportunityId);
    if (freeze.frozen) return respondFrozen(res, freeze);
    const [row] = await db
      .insert(pledgeExpectedPayments)
      .values({ id: newId(), ...body })
      .returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/pledge-expected-payments/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdatePledgeExpectedPaymentBody, req.body, res);
    if (!body) return;
    const id = paramId(req);
    const [existing] = await db.select().from(pledgeExpectedPayments).where(eq(pledgeExpectedPayments.id, id));
    if (!existing) return notFound(res, "expected payment");
    const freeze = await resolvePledgeFreezeById(existing.pledgeOrOpportunityId);
    if (freeze.frozen) return respondFrozen(res, freeze);
    const [row] = await db
      .update(pledgeExpectedPayments)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(pledgeExpectedPayments.id, id))
      .returning();
    if (!row) return notFound(res, "expected payment");
    res.json(row);
  }),
);

router.delete(
  "/pledge-expected-payments/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const [existing] = await db.select().from(pledgeExpectedPayments).where(eq(pledgeExpectedPayments.id, id));
    if (!existing) return notFound(res, "expected payment");
    const freeze = await resolvePledgeFreezeById(existing.pledgeOrOpportunityId);
    if (freeze.frozen) return respondFrozen(res, freeze);
    // Plan line items are hard-deleted (like pledge allocations): they are
    // forecast rows, not financial facts — the documented archive exception.
    await db.delete(pledgeExpectedPayments).where(eq(pledgeExpectedPayments.id, id));
    res.status(204).end();
  }),
);

export default router;
