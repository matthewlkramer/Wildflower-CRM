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

/**
 * Add `months` to a YYYY-MM-DD date string, clamping to the last day of the
 * target month (Jan 31 + 1 month = Feb 28/29). Pure date math — no timezones.
 */
export function addMonthsClamped(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const totalMonths = (y! * 12 + (m! - 1)) + months;
  const ty = Math.floor(totalMonths / 12);
  const tm = totalMonths % 12; // 0-based month
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const td = Math.min(d!, lastDay);
  return `${String(ty).padStart(4, "0")}-${String(tm + 1).padStart(2, "0")}-${String(td).padStart(2, "0")}`;
}

router.post(
  "/pledge-expected-payments",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreatePledgeExpectedPaymentBody, req.body, res);
    if (!body) return;
    const { repeatCount, repeatIntervalMonths, ...fields } = body;
    // repeatCount / repeatIntervalMonths must be provided together.
    if ((repeatCount == null) !== (repeatIntervalMonths == null)) {
      return res.status(400).json({
        error: "request_error",
        message:
          "repeatCount and repeatIntervalMonths must be provided together.",
      });
    }
    // The generated zod schema enforces range but not integrality
    // (orval emits number().min().max() for `type: integer`), and a
    // fractional count would silently under-generate via Array.from.
    if (
      (repeatCount != null && !Number.isInteger(repeatCount)) ||
      (repeatIntervalMonths != null && !Number.isInteger(repeatIntervalMonths))
    ) {
      return res.status(400).json({
        error: "request_error",
        message: "repeatCount and repeatIntervalMonths must be whole numbers.",
      });
    }
    const [parent] = await db
      .select({ id: opportunitiesAndPledges.id })
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, body.pledgeOrOpportunityId));
    if (!parent) return notFound(res, "opportunity");
    const freeze = await resolvePledgeFreezeById(body.pledgeOrOpportunityId);
    if (freeze.frozen) return respondFrozen(res, freeze);
    // Schedule generation: one insert statement (atomic) covering the first
    // installment plus the repeats. Amount/notes are copied onto every row;
    // dates advance by the interval with month-end clamping.
    const total = repeatCount ?? 1;
    const interval = repeatIntervalMonths ?? 0;
    const values = Array.from({ length: total }, (_, i) => ({
      id: newId(),
      ...fields,
      expectedDate:
        i === 0 ? fields.expectedDate : addMonthsClamped(fields.expectedDate, i * interval),
    }));
    const rows = await db.insert(pledgeExpectedPayments).values(values).returning();
    res.status(201).json(rows[0]);
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
