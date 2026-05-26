import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { funders, peopleEntityRoles, emails, addresses } from "@workspace/db/schema";
import { and, asc, count, eq, getTableColumns, ilike, sql, type SQL } from "drizzle-orm";
import {
  ListFundersQueryParams,
  CreateFunderBody,
  UpdateFunderBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, normalizeArrayQuery, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";
import { inArray } from "drizzle-orm";
import { peopleEntityRolesQuery } from "../lib/peopleRolesSelect";

const FUNDERS_ARRAY_PARAMS = ["subtype", "activeStatus", "connectionStatus", "capacityRating"] as const;

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
const fundersListSelect = {
  ...getTableColumns(funders),
  primaryContactPersonId: sql<string | null>`(
    SELECT per.person_id FROM people_entity_roles per
    WHERE per.funder_id = ${FUNDERS_ID} AND per.primary_contact = true
    ORDER BY per.updated_at DESC
    LIMIT 1
  )`.as("primary_contact_person_id"),
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
  lifetimeGiving: sql<string | null>`(
    SELECT COALESCE(SUM(amount), 0)::text FROM gifts_and_payments
      WHERE funder_id = ${FUNDERS_ID}
  )`.as("lifetime_giving"),
  openOpportunityCount: sql<number>`(
    SELECT COUNT(*)::int FROM opportunities_and_pledges
      WHERE funder_id = ${FUNDERS_ID} AND status = 'open'
  )`.as("open_opportunity_count"),
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
    if (q.subtype && q.subtype.length > 0) filters.push(inArray(funders.fundingEntitySubtype, q.subtype));
    if (q.activeStatus && q.activeStatus.length > 0) filters.push(inArray(funders.activeStatus, q.activeStatus));
    if (q.connectionStatus && q.connectionStatus.length > 0) filters.push(inArray(funders.connectionStatus, q.connectionStatus));
    if (q.enthusiasm) filters.push(eq(funders.enthusiasm, q.enthusiasm));
    if (q.capacityRating && q.capacityRating.length > 0) filters.push(inArray(funders.capacityRating, q.capacityRating));
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
    const [people, emailRows, addressRows] = await Promise.all([
      peopleEntityRolesQuery().where(eq(peopleEntityRoles.funderId, id)),
      db.select().from(emails).where(eq(emails.funderId, id)),
      db.select().from(addresses).where(eq(addresses.funderId, id)),
    ]);
    res.json({ ...row, people, emails: emailRows, addresses: addressRows });
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
