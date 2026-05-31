import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { funders, peopleEntityRoles, emails, addresses, paymentIntermediaries } from "@workspace/db/schema";
import { and, asc, count, eq, getTableColumns, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  ListFundersQueryParams,
  CreateFunderBody,
  UpdateFunderBody,
  BulkUpdateFundersBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, normalizeArrayQuery, notFound, parseOrBadRequest, parsePagination, paramId, splitBlank } from "../lib/helpers";
import { executeBulkUpdate } from "../lib/bulkUpdate";
import { inArray } from "drizzle-orm";
import { peopleEntityRolesQuery } from "../lib/peopleRolesSelect";

const FUNDERS_ARRAY_PARAMS = ["subtype", "activeStatus", "connectionStatus", "enthusiasm", "strategicAlignment", "capacityRating", "ownerUserId", "priority"] as const;

const router: IRouter = Router();
router.use(requireAuth);

// Per-row aggregates for the funders list view.
// - primaryContact: the one people_entity_roles row flagged
//   `primary_contact=true` for the funder (LIMIT 1 — there is no DB
//   unique constraint enforcing only one, so pick the most-recently
//   updated to stay deterministic). Display name uses the same
//   COALESCE(full_name, first||' '||last) pattern as donor joins.
// - lifetimeGiving: sum of gifts.amount for this funder.
// - openOpportunityCount: count of open opps for this funder.
// See people.ts: the outer-scope id reference must be the raw
// fragment `"funders"."id"` rather than `${funders.id}`, which
// Drizzle inlines as bare `"id"` and Postgres flags as ambiguous in
// subqueries whose own FROM table has an `id` column (people_entity_roles,
// opportunities_and_pledges, joined people, …).
const FUNDERS_ID = sql.raw(`"funders"."id"`);

// Rollup expressions reused by both the SELECT and the presence WHERE
// filters so the two can't drift. Each is correlated to `funders.id`.
const fundersPrimaryContactIdExpr = sql`(
  SELECT per.person_id FROM people_entity_roles per
  WHERE per.funder_id = ${FUNDERS_ID} AND per.primary_contact = true
  ORDER BY per.updated_at DESC
  LIMIT 1
)`;
const fundersLifetimeGivingExpr = sql`(
  SELECT COALESCE(SUM(amount), 0) FROM gifts_and_payments
    WHERE funder_id = ${FUNDERS_ID}
)`;
const fundersOpenOppCountExpr = sql`(
  SELECT COUNT(*)::int FROM opportunities_and_pledges
    WHERE funder_id = ${FUNDERS_ID} AND status = 'open'
)`;

const fundersListSelect = {
  ...getTableColumns(funders),
  primaryContactPersonId: sql<string | null>`${fundersPrimaryContactIdExpr}`.as("primary_contact_person_id"),
  primaryContactPersonName: sql<string | null>`(
    SELECT COALESCE(
      NULLIF(TRIM(p.full_name), ''),
      NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '')
    )
    FROM people_entity_roles per
    JOIN people p ON p.id = per.person_id
    WHERE per.funder_id = ${FUNDERS_ID} AND per.primary_contact = true
    ORDER BY per.updated_at DESC
    LIMIT 1
  )`.as("primary_contact_person_name"),
  lifetimeGiving: sql<string | null>`${fundersLifetimeGivingExpr}::text`.as("lifetime_giving"),
  openOpportunityCount: sql<number>`${fundersOpenOppCountExpr}`.as("open_opportunity_count"),
};

router.get(
  "/funders",
  asyncHandler(async (req, res) => {
    const normalizedQuery = normalizeArrayQuery(
      req.query as Record<string, unknown>,
      FUNDERS_ARRAY_PARAMS,
    );
    const q = parseOrBadRequest(ListFundersQueryParams, normalizedQuery, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) filters.push(ilike(funders.name, `%${q.search}%`));
    if (q.parentFunderId) filters.push(eq(funders.parentFunderId, q.parentFunderId));
    // Each filter folds the "__blank__" sentinel into an IS NULL OR-clause.
    {
      const f = splitBlank(q.subtype as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(funders.fundingEntitySubtype), inArray(funders.fundingEntitySubtype, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(funders.fundingEntitySubtype));
      else if (f.values.length > 0) filters.push(inArray(funders.fundingEntitySubtype, f.values as never[]));
    }
    {
      const f = splitBlank(q.activeStatus as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(funders.activeStatus), inArray(funders.activeStatus, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(funders.activeStatus));
      else if (f.values.length > 0) filters.push(inArray(funders.activeStatus, f.values as never[]));
    }
    {
      const f = splitBlank(q.connectionStatus as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(funders.connectionStatus), inArray(funders.connectionStatus, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(funders.connectionStatus));
      else if (f.values.length > 0) filters.push(inArray(funders.connectionStatus, f.values as never[]));
    }
    {
      const f = splitBlank(q.enthusiasm as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(funders.enthusiasm), inArray(funders.enthusiasm, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(funders.enthusiasm));
      else if (f.values.length > 0) filters.push(inArray(funders.enthusiasm, f.values as never[]));
    }
    {
      const f = splitBlank(q.strategicAlignment as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(funders.strategicAlignment), inArray(funders.strategicAlignment, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(funders.strategicAlignment));
      else if (f.values.length > 0) filters.push(inArray(funders.strategicAlignment, f.values as never[]));
    }
    {
      const f = splitBlank(q.capacityRating as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(funders.capacityRating), inArray(funders.capacityRating, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(funders.capacityRating));
      else if (f.values.length > 0) filters.push(inArray(funders.capacityRating, f.values as never[]));
    }
    {
      const f = splitBlank(q.ownerUserId as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(funders.ownerUserId), inArray(funders.ownerUserId, f.values))!);
      else if (f.wantsBlank) filters.push(isNull(funders.ownerUserId));
      else if (f.values.length > 0) filters.push(inArray(funders.ownerUserId, f.values));
    }
    {
      const f = splitBlank(q.priority as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(funders.priority), inArray(funders.priority, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(funders.priority));
      else if (f.values.length > 0) filters.push(inArray(funders.priority, f.values as never[]));
    }
    // Presence filters on computed rollup fields (has value vs blank).
    if (q.lifetimeGivingPresence === "has") filters.push(sql`${fundersLifetimeGivingExpr} > 0`);
    else if (q.lifetimeGivingPresence === "blank") filters.push(sql`${fundersLifetimeGivingExpr} <= 0`);
    if (q.openAsksPresence === "has") filters.push(sql`${fundersOpenOppCountExpr} > 0`);
    else if (q.openAsksPresence === "blank") filters.push(sql`${fundersOpenOppCountExpr} = 0`);
    if (q.primaryContactPresence === "has") filters.push(sql`${fundersPrimaryContactIdExpr} IS NOT NULL`);
    else if (q.primaryContactPresence === "blank") filters.push(sql`${fundersPrimaryContactIdExpr} IS NULL`);
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select(fundersListSelect)
        .from(funders)
        .where(where)
        .orderBy(asc(funders.name))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(funders).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/funders/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const row = await db.select(fundersListSelect).from(funders).where(eq(funders.id, id)).then((r) => r[0]);
    if (!row) return notFound(res, "funder");
    const [people, emailRows, addressRows, paymentIntermediary] = await Promise.all([
      peopleEntityRolesQuery().where(eq(peopleEntityRoles.funderId, id)),
      db.select().from(emails).where(eq(emails.funderId, id)),
      db.select().from(addresses).where(eq(addresses.funderId, id)),
      row.paymentIntermediaryId
        ? db
            .select()
            .from(paymentIntermediaries)
            .where(eq(paymentIntermediaries.id, row.paymentIntermediaryId))
            .then((r) => r[0] ?? null)
        : Promise.resolve(null),
    ]);
    res.json({ ...row, people, emails: emailRows, addresses: addressRows, paymentIntermediary });
  }),
);

router.post(
  "/funders/bulk-update",
  asyncHandler(async (req, res) => {
    await executeBulkUpdate(req, res, {
      entity: "funders",
      table: funders,
      bodySchema: BulkUpdateFundersBody,
      allowedFields: [
        "ownerUserId",
        "activeStatus",
        "connectionStatus",
        "capacityRating",
        "enthusiasm",
        "priority",
        "fundingEntitySubtype",
      ],
    });
  }),
);

router.post(
  "/funders",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateFunderBody, req.body, res);
    if (!body) return;
    const [row] = await db.insert(funders).values({ id: newId(), ...body }).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/funders/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateFunderBody, req.body, res);
    if (!body) return;
    if (body.parentFunderId != null && body.parentFunderId === paramId(req)) {
      res.status(400).json({ error: "A funder cannot be its own parent." });
      return;
    }
    const [row] = await db
      .update(funders)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(funders.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "funder");
    res.json(row);
  }),
);

router.delete(
  "/funders/:id",
  asyncHandler(async (req, res) => {
    await db.delete(funders).where(eq(funders.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
