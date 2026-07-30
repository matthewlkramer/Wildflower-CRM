import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  households,
  people,
  peopleEntityRoles,
  emails,
  addresses,
} from "@workspace/db/schema";
import {
  and,
  asc,
  count,
  eq,
  getTableColumns,
  ilike,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  ListHouseholdsQueryParams,
  CreateHouseholdBody,
  UpdateHouseholdBody,
  BulkUpdateHouseholdsBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import {
  asyncHandler,
  newId,
  notFound,
  parseBoolQuery,
  parseOrBadRequest,
  parsePagination,
  paramId,
} from "../lib/helpers";
import { auditCreate, auditUpdate } from "../lib/audit";
import { executeBulkUpdate } from "../lib/bulkUpdate";
import {
  activeOnlyUnlessAdmin,
  archiveOne,
  unarchiveOne,
} from "../lib/archive";
import {
  peopleEntityRolesQuery,
  maskPeopleEntityRoles,
} from "../lib/peopleRolesSelect";
import { getViewer } from "../lib/identityVisibility";

const router: IRouter = Router();
router.use(requireAuth);

// Per-row related-giving aggregates. A household receives credit for:
// 1. gifts recorded directly to the household;
// 2. gifts recorded to people whose primary household is this household; and
// 3. gifts from organizations where one of those current members is a current
//    principal. Archived gifts are excluded from every path.
const HOUSEHOLDS_ID = sql.raw(`"households"."id"`);
const householdGiftWhere = sql`(
  archived_at IS NULL AND (
    household_id = ${HOUSEHOLDS_ID}
    OR individual_giver_person_id IN (
      SELECT id FROM people WHERE primary_household_id = ${HOUSEHOLDS_ID}
    )
    OR organization_id IN (
      SELECT DISTINCT per.organization_id
      FROM people_entity_roles per
      JOIN people p ON p.id = per.person_id
      WHERE p.primary_household_id = ${HOUSEHOLDS_ID}
        AND per.connection = 'principal'
        AND per.current = 'current'
        AND per.organization_id IS NOT NULL
    )
  )
)`;
const householdsListSelect = {
  ...getTableColumns(households),
  lifetimeGiving: sql<string | null>`(
    SELECT COALESCE(SUM(amount), 0)
    FROM gifts_and_payments
    WHERE ${householdGiftWhere}
  )::text`.as("lifetime_giving"),
  mostRecentGiftDate: sql<string | null>`(
    SELECT MAX(date_received)
    FROM gifts_and_payments
    WHERE ${householdGiftWhere}
  )`.as("most_recent_gift_date"),
  openOpportunityCount: sql<number>`(
    SELECT COUNT(*)::int FROM opportunities_and_pledges
      WHERE household_id = ${HOUSEHOLDS_ID} AND status = 'open'
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
    const archivedFilter = activeOnlyUnlessAdmin(req, households.archivedAt);
    if (archivedFilter) filters.push(archivedFilter);
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
    const row = await db
      .select(householdsListSelect)
      .from(households)
      .where(eq(households.id, id))
      .then((r) => r[0]);
    if (!row) return notFound(res, "household");
    const [people, emailRows, addressRows] = await Promise.all([
      peopleEntityRolesQuery().where(eq(peopleEntityRoles.householdId, id)),
      db.select().from(emails).where(eq(emails.householdId, id)),
      db.select().from(addresses).where(eq(addresses.householdId, id)),
    ]);
    res.json({
      ...row,
      people: maskPeopleEntityRoles(people, getViewer(req)),
      emails: emailRows,
      addresses: addressRows,
    });
  }),
);

router.post(
  "/households/bulk-update",
  asyncHandler(async (req, res) => {
    await executeBulkUpdate(req, res, {
      entity: "households",
      table: households,
      bodySchema: BulkUpdateHouseholdsBody,
      allowedFields: ["active"],
    });
  }),
);

router.post(
  "/households",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateHouseholdBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .insert(households)
      .values({ id: newId(), ...body })
      .returning();
    if (row)
      await auditCreate(
        req,
        "household",
        row.id,
        `Created household ${row.name}`,
      );
    res.status(201).json(row);
  }),
);

router.patch(
  "/households/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateHouseholdBody, req.body, res);
    if (!body) return;
    const id = paramId(req);
    const [before] = await db
      .select()
      .from(households)
      .where(eq(households.id, id));
    const [row] = await db
      .update(households)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(households.id, id))
      .returning();
    if (!row) return notFound(res, "household");
    await auditUpdate(
      req,
      "household",
      row.id,
      before as Record<string, unknown> | undefined,
      row as Record<string, unknown>,
      Object.keys(body),
      `Updated household ${row.name}`,
    );
    res.json(row);
  }),
);

router.post(
  "/households/:id/archive",
  asyncHandler(async (req, res) => {
    await archiveOne(req, res, { entity: "household", table: households });
  }),
);

router.post(
  "/households/:id/unarchive",
  asyncHandler(async (req, res) => {
    await unarchiveOne(req, res, { entity: "household", table: households });
  }),
);

export default router;
