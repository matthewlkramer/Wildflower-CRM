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
  BulkUpdateGiftsAndPaymentsBody,
  validateGiftInvariants,
  type InvariantIssue,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, normalizeArrayQuery, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";
import { executeBulkUpdate } from "../lib/bulkUpdate";
import { applyDerivedOppFieldsMany } from "../lib/pledgeStage";
import { inArray } from "drizzle-orm";

const GIFTS_ARRAY_PARAMS = ["type", "ownerUserId", "entityId"] as const;

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
    // Entity filter — EXISTS on gift_allocations so we don't fan rows out
    // when a single gift has multiple allocations. Driven by the global
    // entity filter in the header.
    if (q.entityId && q.entityId.length > 0) {
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${giftAllocations} WHERE ${giftAllocations.giftId} = ${giftsAndPayments.id} AND ${inArray(giftAllocations.entityId, q.entityId)})`,
      );
    }
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
  "/gifts-and-payments/bulk-update",
  asyncHandler(async (req, res) => {
    await executeBulkUpdate(req, res, {
      entity: "gifts_and_payments",
      table: giftsAndPayments,
      bodySchema: BulkUpdateGiftsAndPaymentsBody,
      allowedFields: ["ownerUserId", "type"],
      // Allocation-set reconciliation fields — managed via extraApply
      // rather than as columns on gifts_and_payments.
      virtualFields: ["entityIds", "entityIdsMode", "grantYears", "grantYearsMode"],
      // Reconcile gift_allocations to match the requested entityIds /
      // grantYears sets. Each virtual field is independent and only
      // touches allocation rows where that column is set; replace
      // wipes those rows (DESTRUCTIVE — loses subAmount and the
      // counterpart field on those rows), append adds missing values
      // only.
      extraApply: async (tx, id, vp) => {
        const v = vp as {
          entityIds?: string[];
          entityIdsMode?: string;
          grantYears?: string[];
          grantYearsMode?: string;
        };
        if (v.entityIds) {
          const mode = v.entityIdsMode === "append" ? "append" : "replace";
          if (mode === "replace") {
            await tx
              .delete(giftAllocations)
              .where(
                and(
                  eq(giftAllocations.giftId, id),
                  sql`${giftAllocations.entityId} IS NOT NULL`,
                ),
              );
          }
          const existing =
            mode === "append"
              ? (
                  await tx
                    .select({ e: giftAllocations.entityId })
                    .from(giftAllocations)
                    .where(eq(giftAllocations.giftId, id))
                )
                  .map((r: { e: string | null }) => r.e)
                  .filter((e: string | null): e is string => !!e)
              : [];
          for (const entityId of v.entityIds.filter((e) => !existing.includes(e))) {
            await tx.insert(giftAllocations).values({
              id: newId(),
              giftId: id,
              entityId,
            });
          }
        }
        if (v.grantYears) {
          const mode = v.grantYearsMode === "append" ? "append" : "replace";
          if (mode === "replace") {
            await tx
              .delete(giftAllocations)
              .where(
                and(
                  eq(giftAllocations.giftId, id),
                  sql`${giftAllocations.grantYear} IS NOT NULL`,
                ),
              );
          }
          const existing =
            mode === "append"
              ? (
                  await tx
                    .select({ y: giftAllocations.grantYear })
                    .from(giftAllocations)
                    .where(eq(giftAllocations.giftId, id))
                )
                  .map((r: { y: string | null }) => r.y)
                  .filter((y: string | null): y is string => !!y)
              : [];
          for (const fy of v.grantYears.filter((y) => !existing.includes(y))) {
            await tx.insert(giftAllocations).values({
              id: newId(),
              giftId: id,
              grantYear: fy,
            });
          }
        }
      },
    });
  }),
);

router.post(
  "/gifts-and-payments",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateGiftOrPaymentBodyRefined, req.body, res);
    if (!body) return;
    const [row] = await db.insert(giftsAndPayments).values({ id: newId(), ...body }).returning();
    await applyDerivedOppFieldsMany(row?.paymentOnPledgeId);
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
    // PATCH may re-point payment_on_pledge_id — recompute on both the
    // old and the new pledge so a newly-covered target advances.
    await applyDerivedOppFieldsMany(existing.paymentOnPledgeId, row.paymentOnPledgeId);
    res.json(row);
  }),
);

router.delete(
  "/gifts-and-payments/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    // Capture the link before delete so we can still recompute the
    // pledge's coverage afterwards. (Deletion can only *reduce* paid
    // total, so the helper will no-op unless a concurrent insert just
    // pushed it over — cheap to call regardless.)
    const existing = await db
      .select({ paymentOnPledgeId: giftsAndPayments.paymentOnPledgeId })
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, id))
      .then((r) => r[0]);
    await db.delete(giftsAndPayments).where(eq(giftsAndPayments.id, id));
    await applyDerivedOppFieldsMany(existing?.paymentOnPledgeId);
    res.status(204).end();
  }),
);

export default router;
