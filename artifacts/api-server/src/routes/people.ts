import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { people, peopleEntityRoles, emails, phoneNumbers, addresses } from "@workspace/db/schema";
import { and, asc, count, eq, getTableColumns, ilike, or, sql, type SQL } from "drizzle-orm";
import {
  ListPeopleQueryParams,
  CreatePersonBody,
  UpdatePersonBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseBoolQuery, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

// Server-computed aggregates appended to every list row. Each is a
// correlated subquery scoped to `people.id` so we get one number per
// row without an explicit GROUP BY (and without needing CTEs that
// would force two round-trips). Lifetime giving and most-recent gift
// both fold in gifts to households the person is a member of — per
// the agreed rule, members claim the full household amount with no
// splitting. See replit.md "lifetime giving" decision.
const peopleListSelect = {
  ...getTableColumns(people),
  lifetimeGiving: sql<string | null>`(
    COALESCE(
      (SELECT SUM(amount) FROM gifts_and_payments
        WHERE individual_giver_person_id = ${people.id}),
      0
    ) + COALESCE(
      (SELECT SUM(amount) FROM gifts_and_payments
        WHERE household_id IN (
          SELECT household_id FROM people_entity_roles
          WHERE person_id = ${people.id} AND household_id IS NOT NULL
        )),
      0
    )
  )::text`.as("lifetime_giving"),
  // Postgres GREATEST returns NULL if any arg is NULL, which is wrong
  // here (a person with only direct gifts and no household gifts would
  // get NULL). Take MAX over a UNION of both sources instead — MAX
  // naturally ignores NULLs.
  mostRecentGiftDate: sql<string | null>`(
    SELECT MAX(d) FROM (
      SELECT MAX(date_received) AS d FROM gifts_and_payments
        WHERE individual_giver_person_id = ${people.id}
      UNION ALL
      SELECT MAX(date_received) AS d FROM gifts_and_payments
        WHERE household_id IN (
          SELECT household_id FROM people_entity_roles
          WHERE person_id = ${people.id} AND household_id IS NOT NULL
        )
    ) AS _gift_dates
  )`.as("most_recent_gift_date"),
  openOpportunityCount: sql<number>`(
    SELECT COUNT(*)::int FROM opportunities_and_pledges
      WHERE individual_giver_person_id = ${people.id} AND status = 'open'
  )`.as("open_opportunity_count"),
  // DISTINCT to dedupe in case a person has multiple current role rows
  // at the same funder (different role titles, etc.).
  activeFunderNames: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT f.name ORDER BY f.name)
    FROM people_entity_roles per
    JOIN funders f ON f.id = per.funder_id
    WHERE per.person_id = ${people.id}
      AND per.current = 'current'
      AND per.funder_id IS NOT NULL
  )`.as("active_funder_names"),
};

router.get(
  "/people",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListPeopleQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) {
      const term = `%${q.search}%`;
      const orClause = or(
        ilike(people.fullName, term),
        ilike(people.firstName, term),
        ilike(people.lastName, term),
      );
      if (orClause) filters.push(orClause);
    }
    // Read deceased from the raw query string — see parseBoolQuery for why
    // we bypass the generated zod field (zod.coerce.boolean inverts "false").
    const deceased = parseBoolQuery(req, "deceased");
    if (deceased !== undefined) filters.push(eq(people.deceased, deceased));
    if (q.regionId) filters.push(eq(people.currentHomeRegionId, q.regionId));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select(peopleListSelect)
        .from(people)
        .where(where)
        .orderBy(asc(people.lastName), asc(people.firstName))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(people).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/people/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const row = await db.select(peopleListSelect).from(people).where(eq(people.id, id)).then((r) => r[0]);
    if (!row) return notFound(res, "person");
    const [roles, emailRows, phoneRows, addressRows] = await Promise.all([
      db.select().from(peopleEntityRoles).where(eq(peopleEntityRoles.personId, id)),
      db.select().from(emails).where(eq(emails.personId, id)),
      db.select().from(phoneNumbers).where(eq(phoneNumbers.personId, id)),
      db.select().from(addresses).where(eq(addresses.personId, id)),
    ]);
    res.json({ ...row, roles, emails: emailRows, phoneNumbers: phoneRows, addresses: addressRows });
  }),
);

router.post(
  "/people",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreatePersonBody, req.body, res);
    if (!body) return;
    const [row] = await db.insert(people).values({ id: newId(), ...body }).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/people/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdatePersonBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(people)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(people.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "person");
    res.json(row);
  }),
);

router.delete(
  "/people/:id",
  asyncHandler(async (req, res) => {
    await db.delete(people).where(eq(people.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
