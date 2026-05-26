import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import { giftsAndPayments, giftAllocations, funders, households, people } from "@workspace/db/schema";
import { and, count, desc, eq, getTableColumns, ilike, sql, type SQL } from "drizzle-orm";

// See opportunitiesAndPledges.ts for rationale — same denormalized
// donor display names joined from funders / households / people, plus
// three de-duplicated aggregates from gift_allocations so the gifts
// list can render Entities / Usages / Grant years inline without
// fanning out per-row fetches.
const donorJoinSelect = {
  ...getTableColumns(giftsAndPayments),
  funderName: funders.name,
  householdName: households.name,
  individualGiverPersonName: sql<string | null>`
    COALESCE(
      NULLIF(TRIM(${people.fullName}), ''),
      NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
    )
  `.as("individual_giver_person_name"),
  // See opportunitiesAndPledges.ts donorJoinSelect for rationale.
  funderIsPriority: funders.isPriority,
  individualGiverPersonIsPriority: people.isPriority,
  entityIds: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT ga.entity_id ORDER BY ga.entity_id)
    FROM gift_allocations ga
    WHERE ga.gift_id = ${giftsAndPayments.id} AND ga.entity_id IS NOT NULL
  )`.as("entity_ids"),
  displayUsages: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT ga.display_usage ORDER BY ga.display_usage)
    FROM gift_allocations ga
    WHERE ga.gift_id = ${giftsAndPayments.id} AND ga.display_usage IS NOT NULL
  )`.as("display_usages"),
  grantYears: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT ga.grant_year ORDER BY ga.grant_year)
    FROM gift_allocations ga
    WHERE ga.gift_id = ${giftsAndPayments.id} AND ga.grant_year IS NOT NULL
  )`.as("grant_years"),
};
import {
  ListGiftsAndPaymentsQueryParams,
  CreateGiftOrPaymentBodyRefined,
  UpdateGiftOrPaymentBody,
  validateGiftInvariants,
  type InvariantIssue,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, normalizeArrayQuery, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";
import { inArray } from "drizzle-orm";

const GIFTS_ARRAY_PARAMS = ["type", "ownerUserId"] as const;

const router: IRouter = Router();
router.use(requireAuth);

function respondInvariantFailure(res: Response, issues: InvariantIssue[]): void {
  res.status(400).json({
    error: "validation_error",
    message: "Request validation failed",
    details: { issues: issues.map((i) => ({ path: [i.path], message: i.message })) },
  });
}

router.get(
  "/gifts-and-payments",
  asyncHandler(async (req, res) => {
    const normalizedQuery = normalizeArrayQuery(
      req.query as Record<string, unknown>,
      GIFTS_ARRAY_PARAMS,
    );
    const q = parseOrBadRequest(ListGiftsAndPaymentsQueryParams, normalizedQuery, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) filters.push(ilike(giftsAndPayments.name, `%${q.search}%`));
    if (q.type && q.type.length > 0) filters.push(inArray(giftsAndPayments.type, q.type));
    if (q.funderId) filters.push(eq(giftsAndPayments.funderId, q.funderId));
    if (q.householdId) filters.push(eq(giftsAndPayments.householdId, q.householdId));
    if (q.individualGiverPersonId) filters.push(eq(giftsAndPayments.individualGiverPersonId, q.individualGiverPersonId));
    if (q.paymentOnPledgeId) filters.push(eq(giftsAndPayments.paymentOnPledgeId, q.paymentOnPledgeId));
    if (q.paymentMethod) filters.push(eq(giftsAndPayments.paymentMethod, q.paymentMethod));
    if (q.ownerUserId && q.ownerUserId.length > 0) filters.push(inArray(giftsAndPayments.ownerUserId, q.ownerUserId));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select(donorJoinSelect)
        .from(giftsAndPayments)
        .leftJoin(funders, eq(funders.id, giftsAndPayments.funderId))
        .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
        .leftJoin(people, eq(people.id, giftsAndPayments.individualGiverPersonId))
        .where(where)
        .orderBy(desc(giftsAndPayments.dateReceived))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(giftsAndPayments).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/gifts-and-payments/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const row = await db
      .select(donorJoinSelect)
      .from(giftsAndPayments)
      .leftJoin(funders, eq(funders.id, giftsAndPayments.funderId))
      .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
      .leftJoin(people, eq(people.id, giftsAndPayments.individualGiverPersonId))
      .where(eq(giftsAndPayments.id, id))
      .then((r) => r[0]);
    if (!row) return notFound(res, "gift");
    const allocations = await db.select().from(giftAllocations).where(eq(giftAllocations.giftId, id));
    res.json({ ...row, allocations });
  }),
);

router.post(
  "/gifts-and-payments",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateGiftOrPaymentBodyRefined, req.body, res);
    if (!body) return;
    const [row] = await db.insert(giftsAndPayments).values({ id: newId(), ...body }).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/gifts-and-payments/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateGiftOrPaymentBody, req.body, res);
    if (!body) return;
    const id = paramId(req);
    const existing = await db
      .select()
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "gift");

    // Validate merged post-update state so partial PATCHes can't bypass the
    // donor_xor DB CHECK and produce a 500.
    const merged = { ...existing, ...body };
    const issues = validateGiftInvariants({
      funderId: merged.funderId,
      individualGiverPersonId: merged.individualGiverPersonId,
      householdId: merged.householdId,
    });
    if (issues.length) return respondInvariantFailure(res, issues);

    const [row] = await db
      .update(giftsAndPayments)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(giftsAndPayments.id, id))
      .returning();
    if (!row) return notFound(res, "gift");
    res.json(row);
  }),
);

router.delete(
  "/gifts-and-payments/:id",
  asyncHandler(async (req, res) => {
    await db.delete(giftsAndPayments).where(eq(giftsAndPayments.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
