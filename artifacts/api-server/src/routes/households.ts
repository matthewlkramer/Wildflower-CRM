import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { households, peopleEntityRoles, emails, addresses } from "@workspace/db/schema";
import { and, asc, count, eq, getTableColumns, ilike, sql, type SQL } from "drizzle-orm";
import {
  ListHouseholdsQueryParams,
  CreateHouseholdBody,
  UpdateHouseholdBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseBoolQuery, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

// Same pattern as people: per-row aggregates via correlated subqueries.
// Lifetime giving and most-recent gift fold in gifts to member
// individuals (peopleEntityRoles where household_id matches) so the
// view answers "what has this household given, in any form?".
const householdsListSelect = {
  ...getTableColumns(households),
  lifetimeGiving: sql<string | null>`(
    COALESCE(
      (SELECT SUM(amount) FROM gifts_and_payments
        WHERE household_id = ${households.id}),
      0
    ) + COALESCE(
      (SELECT SUM(amount) FROM gifts_and_payments
        WHERE individual_giver_person_id IN (
          SELECT person_id FROM people_entity_roles
          WHERE household_id = ${households.id}
        )),
      0
    )
  )::text`.as("lifetime_giving"),
  // See people.ts — Postgres GREATEST is NULL-poisoning, so MAX over a
  // UNION is what we actually want.
  mostRecentGiftDate: sql<string | null>`(
    SELECT MAX(d) FROM (
      SELECT MAX(date_received) AS d FROM gifts_and_payments
        WHERE household_id = ${households.id}
      UNION ALL
      SELECT MAX(date_received) AS d FROM gifts_and_payments
        WHERE individual_giver_person_id IN (
          SELECT person_id FROM people_entity_roles
          WHERE household_id = ${households.id}
        )
    ) AS _gift_dates
  )`.as("most_recent_gift_date"),
  openOpportunityCount: sql<number>`(
    SELECT COUNT(*)::int FROM opportunities_and_pledges
      WHERE household_id = ${households.id} AND status = 'open'
  )`.as("open_opportunity_count"),
};

router.get(
  "/households",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListHouseholdsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) filters.push(ilike(households.name, `%${q.search}%`));
    // See parseBoolQuery — bypass the buggy generated zod boolean coercion.
    const active = parseBoolQuery(req, "active");
    if (active !== undefined) filters.push(eq(households.active, active));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select(householdsListSelect)
        .from(households)
        .where(where)
        .orderBy(asc(households.name))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(households).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/households/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const row = await db.select(householdsListSelect).from(households).where(eq(households.id, id)).then((r) => r[0]);
    if (!row) return notFound(res, "household");
    const [people, emailRows, addressRows] = await Promise.all([
      db.select().from(peopleEntityRoles).where(eq(peopleEntityRoles.householdId, id)),
      db.select().from(emails).where(eq(emails.householdId, id)),
      db.select().from(addresses).where(eq(addresses.householdId, id)),
    ]);
    res.json({ ...row, people, emails: emailRows, addresses: addressRows });
  }),
);

router.post(
  "/households",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateHouseholdBody, req.body, res);
    if (!body) return;
    const [row] = await db.insert(households).values({ id: newId(), ...body }).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/households/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateHouseholdBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(households)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(households.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "household");
    res.json(row);
  }),
);

router.delete(
  "/households/:id",
  asyncHandler(async (req, res) => {
    await db.delete(households).where(eq(households.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
