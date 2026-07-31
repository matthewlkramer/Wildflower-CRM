import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { households, people, emails, addresses } from "@workspace/db/schema";
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
import { getViewer, maskName } from "../lib/identityVisibility";
import { personDisplayNameSql } from "../lib/personNameSql";

const router: IRouter = Router();
router.use(requireAuth);

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

const householdMemberSelect = {
  id: sql<string>`'primary_household:' || ${people.id}`.as("id"),
  personId: people.id,
  entityType: sql<"household">`'household'`.as("entity_type"),
  organizationId: sql<string | null>`NULL::text`.as("organization_id"),
  paymentIntermediaryId: sql<string | null>`NULL::text`.as(
    "payment_intermediary_id",
  ),
  householdId: people.primaryHouseholdId,
  connection: sql<string | null>`NULL::text`.as("connection"),
  notes: sql<string | null>`NULL::text`.as("notes"),
  externalTitleOrRole: sql<string | null>`NULL::text`.as(
    "external_title_or_role",
  ),
  current: sql<"current">`'current'`.as("current"),
  primaryContact: sql<boolean>`false`.as("primary_contact"),
  createdAt: people.createdAt,
  updatedAt: people.updatedAt,
  personName: personDisplayNameSql(people).as("person_name"),
  personEmail: sql<string | null>`(
    SELECT e.email FROM emails e
    WHERE e.person_id = ${people.id}
    ORDER BY e.is_preferred DESC, e.created_at ASC
    LIMIT 1
  )`.as("person_email"),
  personAnonymous: people.anonymous,
  personOwnerUserId: people.ownerUserId,
};

router.get(
  "/households",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListHouseholdsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) filters.push(ilike(households.name, `%${q.search}%`));
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
    const [memberRows, emailRows, addressRows] = await Promise.all([
      db
        .select(householdMemberSelect)
        .from(people)
        .where(eq(people.primaryHouseholdId, id))
        .orderBy(asc(people.lastName), asc(people.firstName)),
      db.select().from(emails).where(eq(emails.householdId, id)),
      db.select().from(addresses).where(eq(addresses.householdId, id)),
    ]);
    const viewer = getViewer(req);
    const members = memberRows.map(
      ({ personAnonymous, personOwnerUserId, ...member }) => ({
        ...member,
        personName: maskName(
          member.personName,
          { anonymous: personAnonymous, ownerUserId: personOwnerUserId },
          viewer,
        ),
      }),
    );
    res.json({
      ...row,
      people: members,
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
