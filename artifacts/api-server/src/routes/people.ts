import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { people, peopleEntityRoles, emails, phoneNumbers, addresses } from "@workspace/db/schema";
import { and, asc, count, eq, getTableColumns, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  ListPeopleQueryParams,
  CreatePersonBody,
  UpdatePersonBody,
  BulkUpdatePeopleBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, normalizeArrayQuery, notFound, parseBoolQuery, parseOrBadRequest, parsePagination, paramId, splitBlank } from "../lib/helpers";
import { executeBulkUpdate } from "../lib/bulkUpdate";
import { mergeEntity, PERSON_MERGE_CONFIG } from "../lib/mergeEntities";
import { inArray } from "drizzle-orm";
import { peopleEntityRolesQuery } from "../lib/peopleRolesSelect";

const PEOPLE_ARRAY_PARAMS = ["capacityRating", "connectionStatus", "enthusiasm", "ownerUserId", "priority", "regionIds"] as const;

const router: IRouter = Router();
router.use(requireAuth);

// Server-computed aggregates appended to every list row. Each is a
// correlated subquery scoped to `people.id` so we get one number per
// row without an explicit GROUP BY (and without needing CTEs that
// would force two round-trips). Lifetime giving and most-recent gift
// both fold in gifts to households the person is a member of — per
// the agreed rule, members claim the full household amount with no
// splitting. See replit.md "lifetime giving" decision.
//
// NB: the outer-scope reference must be written as the raw fragment
// `"people"."id"` rather than `${people.id}`. Drizzle inlines column
// objects as bare `"id"` here, which Postgres flags as ambiguous in
// any subquery whose own FROM table also has an `id` column
// (people_entity_roles, opportunities_and_pledges, funders, …).
const PEOPLE_ID = sql.raw(`"people"."id"`);

// Rollup expressions are defined once and reused by both the SELECT
// (cast/aliased) and the presence WHERE filters so the two can never
// drift. Each is a correlated fragment scoped to `people.id`.
const peopleLifetimeGivingExpr = sql`(
  COALESCE(
    (SELECT SUM(amount) FROM gifts_and_payments
      WHERE individual_giver_person_id = ${PEOPLE_ID}),
    0
  ) + COALESCE(
    (SELECT SUM(amount) FROM gifts_and_payments
      WHERE household_id IN (
        SELECT household_id FROM people_entity_roles
        WHERE person_id = ${PEOPLE_ID} AND household_id IS NOT NULL
      )),
    0
  )
)`;
const peopleMostRecentGiftExpr = sql`(
  SELECT MAX(d) FROM (
    SELECT MAX(date_received) AS d FROM gifts_and_payments
      WHERE individual_giver_person_id = ${PEOPLE_ID}
    UNION ALL
    SELECT MAX(date_received) AS d FROM gifts_and_payments
      WHERE household_id IN (
        SELECT household_id FROM people_entity_roles
        WHERE person_id = ${PEOPLE_ID} AND household_id IS NOT NULL
      )
  ) AS _gift_dates
)`;
const peopleOpenOppCountExpr = sql`(
  SELECT COUNT(*)::int FROM opportunities_and_pledges
    WHERE individual_giver_person_id = ${PEOPLE_ID} AND status = 'open'
)`;
// True when the person holds at least one current funder or org role.
const peopleActiveAffiliationExists = sql`EXISTS (
  SELECT 1 FROM people_entity_roles per
  WHERE per.person_id = ${PEOPLE_ID}
    AND per.current = 'current'
    AND (per.funder_id IS NOT NULL OR per.organization_id IS NOT NULL)
)`;

const peopleListSelect = {
  ...getTableColumns(people),
  lifetimeGiving: sql<string | null>`${peopleLifetimeGivingExpr}::text`.as("lifetime_giving"),
  // Postgres GREATEST returns NULL if any arg is NULL, which is wrong
  // here (a person with only direct gifts and no household gifts would
  // get NULL). Take MAX over a UNION of both sources instead — MAX
  // naturally ignores NULLs.
  mostRecentGiftDate: sql<string | null>`${peopleMostRecentGiftExpr}`.as("most_recent_gift_date"),
  openOpportunityCount: sql<number>`${peopleOpenOppCountExpr}`.as("open_opportunity_count"),
  // DISTINCT to dedupe in case a person has multiple current role rows
  // at the same funder (different role titles, etc.).
  activeFunderNames: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT f.name ORDER BY f.name)
    FROM people_entity_roles per
    JOIN funders f ON f.id = per.funder_id
    WHERE per.person_id = ${PEOPLE_ID}
      AND per.current = 'current'
      AND per.funder_id IS NOT NULL
  )`.as("active_funder_names"),
  // Current non-funding organization roles, mirroring activeFunderNames.
  activeOrganizationNames: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT o.name ORDER BY o.name)
    FROM people_entity_roles per
    JOIN organizations o ON o.id = per.organization_id
    WHERE per.person_id = ${PEOPLE_ID}
      AND per.current = 'current'
      AND per.organization_id IS NOT NULL
  )`.as("active_organization_names"),
  // Past funder roles (current='past') — used as fallback in the list column.
  pastFunderNames: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT f.name ORDER BY f.name)
    FROM people_entity_roles per
    JOIN funders f ON f.id = per.funder_id
    WHERE per.person_id = ${PEOPLE_ID}
      AND per.current = 'past'
      AND per.funder_id IS NOT NULL
  )`.as("past_funder_names"),
  // Past non-funding organization roles — fallback alongside pastFunderNames.
  pastOrganizationNames: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT o.name ORDER BY o.name)
    FROM people_entity_roles per
    JOIN organizations o ON o.id = per.organization_id
    WHERE per.person_id = ${PEOPLE_ID}
      AND per.current = 'past'
      AND per.organization_id IS NOT NULL
  )`.as("past_organization_names"),
};

router.get(
  "/people",
  asyncHandler(async (req, res) => {
    const normalizedQuery = normalizeArrayQuery(
      req.query as Record<string, unknown>,
      PEOPLE_ARRAY_PARAMS,
    );
    const q = parseOrBadRequest(ListPeopleQueryParams, normalizedQuery, res);
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
    const capacityFilter = splitBlank(q.capacityRating);
    if (capacityFilter.wantsBlank && capacityFilter.values.length > 0) {
      filters.push(or(isNull(people.capacityRating), inArray(people.capacityRating, capacityFilter.values as never[]))!);
    } else if (capacityFilter.wantsBlank) {
      filters.push(isNull(people.capacityRating));
    } else if (capacityFilter.values.length > 0) {
      filters.push(inArray(people.capacityRating, capacityFilter.values as never[]));
    }
    const connectionFilter = splitBlank(q.connectionStatus);
    if (connectionFilter.wantsBlank && connectionFilter.values.length > 0) {
      filters.push(or(isNull(people.connectionStatus), inArray(people.connectionStatus, connectionFilter.values as never[]))!);
    } else if (connectionFilter.wantsBlank) {
      filters.push(isNull(people.connectionStatus));
    } else if (connectionFilter.values.length > 0) {
      filters.push(inArray(people.connectionStatus, connectionFilter.values as never[]));
    }
    {
      const f = splitBlank(q.enthusiasm as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(people.enthusiasm), inArray(people.enthusiasm, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(people.enthusiasm));
      else if (f.values.length > 0) filters.push(inArray(people.enthusiasm, f.values as never[]));
    }
    const ownerFilter = splitBlank(q.ownerUserId);
    if (ownerFilter.wantsBlank && ownerFilter.values.length > 0) {
      filters.push(or(isNull(people.ownerUserId), inArray(people.ownerUserId, ownerFilter.values))!);
    } else if (ownerFilter.wantsBlank) {
      filters.push(isNull(people.ownerUserId));
    } else if (ownerFilter.values.length > 0) {
      filters.push(inArray(people.ownerUserId, ownerFilter.values));
    }
    const priorityFilter = splitBlank(q.priority);
    if (priorityFilter.wantsBlank && priorityFilter.values.length > 0) {
      filters.push(or(isNull(people.priority), inArray(people.priority, priorityFilter.values as never[]))!);
    } else if (priorityFilter.wantsBlank) {
      filters.push(isNull(people.priority));
    } else if (priorityFilter.values.length > 0) {
      filters.push(inArray(people.priority, priorityFilter.values as never[]));
    }
    // Array overlap filter: person must share at least one region with the requested set.
    {
      const ids = q.regionIds as string[] | undefined;
      if (ids && ids.length > 0) {
        filters.push(sql`${people.regionIds} && ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::text[]`);
      }
    }
    // Presence filters on computed rollup fields (has value vs blank).
    if (q.lifetimeGivingPresence === "has") filters.push(sql`${peopleLifetimeGivingExpr} > 0`);
    else if (q.lifetimeGivingPresence === "blank") filters.push(sql`${peopleLifetimeGivingExpr} <= 0`);
    if (q.lastGiftPresence === "has") filters.push(sql`${peopleMostRecentGiftExpr} IS NOT NULL`);
    else if (q.lastGiftPresence === "blank") filters.push(sql`${peopleMostRecentGiftExpr} IS NULL`);
    if (q.openAsksPresence === "has") filters.push(sql`${peopleOpenOppCountExpr} > 0`);
    else if (q.openAsksPresence === "blank") filters.push(sql`${peopleOpenOppCountExpr} = 0`);
    if (q.activeAffiliationPresence === "has") filters.push(peopleActiveAffiliationExists);
    else if (q.activeAffiliationPresence === "blank") filters.push(sql`NOT ${peopleActiveAffiliationExists}`);
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
      peopleEntityRolesQuery().where(eq(peopleEntityRoles.personId, id)),
      db.select().from(emails).where(eq(emails.personId, id)),
      db.select().from(phoneNumbers).where(eq(phoneNumbers.personId, id)),
      db.select().from(addresses).where(eq(addresses.personId, id)),
    ]);
    res.json({ ...row, roles, emails: emailRows, phoneNumbers: phoneRows, addresses: addressRows });
  }),
);

router.post(
  "/people/bulk-update",
  asyncHandler(async (req, res) => {
    await executeBulkUpdate(req, res, {
      entity: "people",
      table: people,
      bodySchema: BulkUpdatePeopleBody,
      allowedFields: [
        "ownerUserId",
        "currentHomeRegionId",
        "capacityRating",
        "priority",
        "deceased",
      ],
    });
  }),
);

router.post(
  "/people/merge",
  asyncHandler(async (req, res) => {
    await mergeEntity(req, res, PERSON_MERGE_CONFIG);
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
