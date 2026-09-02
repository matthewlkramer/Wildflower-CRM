import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { fiscalYears, pledgeAllocations, pledgeExpectedPayments } from "@workspace/db/schema";
import { and, asc, count, desc, eq, inArray, type SQL } from "drizzle-orm";
import {
  ListPledgeAllocationsQueryParams,
  CreatePledgeAllocationBody,
  ApplyPledgeAllocationToScheduleBody,
  UpdatePledgeAllocationBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";
import { resolvePledgeAllocationFreeze, respondFrozen } from "../lib/freezeGuard";
import { pledgeAllocationCodingPreview } from "../lib/revenueCoding";
import { applyDerivedOppFields } from "../lib/pledgeStage";
import { fiscalYearSlugForDate } from "../lib/giftAllocationSeed";

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
    // Freeze guard: gated by the parent pledge's governing FY.
    const freeze = await resolvePledgeAllocationFreeze(body.pledgeOrOpportunityId);
    if (freeze.frozen) return respondFrozen(res, freeze);
    // A concrete school recipient implies the funds flow directly to a school.
    const directToSchool = body.schoolRecipientId ? true : body.directToSchool;
    const [row] = await db
      .insert(pledgeAllocations)
      .values({
        id: newId(),
        ...body,
        directToSchool,
      })
      .returning();
    // Conditions now live on the allocation; recompute the header conditional
    // rollup + win-probability for the parent opportunity/pledge.
    await applyDerivedOppFields(row?.pledgeOrOpportunityId);
    res.status(201).json(row);
  }),
);

// Cross-apply one allocation template across the pledge's entire installment
// schedule: one allocation row per pledge_expected_payments row, grantYear
// derived SERVER-SIDE from each payment's expectedDate (never caller-set).
// All-or-nothing: a single transaction inserts every row or none.
// NOTE: must be registered BEFORE the /pledge-allocations/:id routes.
router.post(
  "/pledge-allocations/apply-to-schedule",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(ApplyPledgeAllocationToScheduleBody, req.body, res);
    if (!body) return;
    const { pledgeOrOpportunityId, ...template } = body;
    // Freeze guard: gated by the parent pledge's governing FY.
    const freeze = await resolvePledgeAllocationFreeze(pledgeOrOpportunityId);
    if (freeze.frozen) return respondFrozen(res, freeze);
    const schedule = await db
      .select()
      .from(pledgeExpectedPayments)
      .where(eq(pledgeExpectedPayments.pledgeOrOpportunityId, pledgeOrOpportunityId))
      .orderBy(asc(pledgeExpectedPayments.expectedDate));
    if (schedule.length === 0) {
      return res.status(400).json({
        error: "This pledge has no scheduled payments to apply the allocation to.",
      });
    }
    // grant_year is a RESTRICT FK to fiscal_years — only stamp slugs whose row
    // actually exists (mirrors giftAllocationSeed); missing FYs stay null for
    // the fundraiser to fill in later rather than aborting the whole insert.
    const wantedSlugs = [
      ...new Set(schedule.map((p) => fiscalYearSlugForDate(p.expectedDate)).filter((s): s is string => !!s)),
    ];
    const existingFyRows = wantedSlugs.length
      ? await db.select({ id: fiscalYears.id }).from(fiscalYears).where(inArray(fiscalYears.id, wantedSlugs))
      : [];
    const knownFy = new Set(existingFyRows.map((r) => r.id));
    // A concrete school recipient implies the funds flow directly to a school.
    const directToSchool = template.schoolRecipientId ? true : template.directToSchool;
    const rows = schedule.map((payment) => {
      const slug = fiscalYearSlugForDate(payment.expectedDate);
      return {
        id: newId(),
        ...template,
        pledgeOrOpportunityId,
        directToSchool,
        grantYear: slug && knownFy.has(slug) ? slug : null,
      };
    });
    const created = await db.transaction(async (tx) => {
      return tx.insert(pledgeAllocations).values(rows).returning();
    });
    // Conditions live on the allocations; recompute the header conditional
    // rollup + win-probability for the parent opportunity/pledge.
    await applyDerivedOppFields(pledgeOrOpportunityId);
    res.status(201).json({ createdCount: created.length, data: created });
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
    // Freeze guard: block if the current OR (when re-pointed) the target pledge's
    // governing FY is audit-closed.
    const freeze = await resolvePledgeAllocationFreeze(existing.pledgeOrOpportunityId);
    if (freeze.frozen) return respondFrozen(res, freeze);
    const targetParent = (body as { pledgeOrOpportunityId?: string }).pledgeOrOpportunityId;
    if (targetParent && targetParent !== existing.pledgeOrOpportunityId) {
      const targetFreeze = await resolvePledgeAllocationFreeze(targetParent);
      if (targetFreeze.frozen) return respondFrozen(res, targetFreeze);
    }
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
        updatedAt: new Date(),
      })
      .where(eq(pledgeAllocations.id, id))
      .returning();
    if (!row) return notFound(res, "allocation");
    // Conditions live on the allocation; a conditional change re-derives the
    // header rollup + win-probability. Re-point covers both the old and new
    // parent when the allocation was moved between opportunities.
    await applyDerivedOppFields(existing.pledgeOrOpportunityId);
    if (row.pledgeOrOpportunityId !== existing.pledgeOrOpportunityId) {
      await applyDerivedOppFields(row.pledgeOrOpportunityId);
    }
    res.json(row);
  }),
);

// On-demand revenue-coding preview (not persisted on the allocation).
router.get(
  "/pledge-allocations/:id/coding-preview",
  asyncHandler(async (req, res) => {
    const preview = await pledgeAllocationCodingPreview(paramId(req));
    if (!preview) return notFound(res, "allocation");
    res.json(preview);
  }),
);

router.delete(
  "/pledge-allocations/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const [existing] = await db.select().from(pledgeAllocations).where(eq(pledgeAllocations.id, id));
    if (existing) {
      // Freeze guard: gated by the parent pledge's governing FY.
      const freeze = await resolvePledgeAllocationFreeze(existing.pledgeOrOpportunityId);
      if (freeze.frozen) return respondFrozen(res, freeze);
    }
    await db.delete(pledgeAllocations).where(eq(pledgeAllocations.id, id));
    // Removing an allocation can change the header conditional rollup.
    await applyDerivedOppFields(existing?.pledgeOrOpportunityId);
    res.status(204).end();
  }),
);

export default router;
