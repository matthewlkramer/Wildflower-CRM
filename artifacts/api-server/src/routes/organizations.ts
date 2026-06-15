import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  organizations,
  peopleEntityRoles,
  emails,
  phoneNumbers,
  addresses,
  paymentIntermediaries,
  connectionEnthusiasmHistory,
} from "@workspace/db/schema";
import { getAppUser } from "../lib/appRequest";
import {
  and,
  asc,
  count,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  ListOrganizationsQueryParams,
  CreateOrganizationBody,
  UpdateOrganizationBody,
  BulkUpdateOrganizationsBody,
  BulkDeleteOrganizationsBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import {
  asyncHandler,
  newId,
  normalizeArrayQuery,
  notFound,
  parseBoolQuery,
  parseOrBadRequest,
  parsePagination,
  paramId,
  splitBlank,
} from "../lib/helpers";
import { executeBulkUpdate } from "../lib/bulkUpdate";
import { executeBulkDelete } from "../lib/bulkDelete";
import { mergeEntity, ORGANIZATION_MERGE_CONFIG } from "../lib/mergeEntities";
import { peopleEntityRolesQuery } from "../lib/peopleRolesSelect";

const ORGANIZATIONS_ARRAY_PARAMS = [
  "entityType",
  "activeStatus",
  "connectionStatus",
  "enthusiasm",
  "strategicAlignment",
  "capacityRating",
  "ownerUserId",
  "priority",
  "regionIds",
] as const;

const router: IRouter = Router();
router.use(requireAuth);

// Raw SQL fragment for the organizations table's own id, used in correlated
// subqueries. Using sql.raw avoids Drizzle inlining it as bare "id", which
// Postgres flags as ambiguous inside subqueries that also have an id column.
const ORGS_ID = sql.raw(`"organizations"."id"`);

// Rollup expressions reused by both the SELECT and the presence WHERE filters.
const orgsPrimaryContactIdExpr = sql`(
  SELECT per.person_id FROM people_entity_roles per
  WHERE per.organization_id = ${ORGS_ID} AND per.primary_contact = true
  ORDER BY per.updated_at DESC
  LIMIT 1
)`;

const orgsLifetimeGivingExpr = sql`(
  SELECT COALESCE(SUM(amount), 0) FROM gifts_and_payments
    WHERE organization_id = ${ORGS_ID}
)`;

const orgsOpenOppCountExpr = sql`(
  SELECT COUNT(*)::int FROM opportunities_and_pledges
    WHERE organization_id = ${ORGS_ID} AND status = 'open'
)`;

const orgsListSelect = {
  ...getTableColumns(organizations),
  primaryContactPersonId: sql<string | null>`${orgsPrimaryContactIdExpr}`.as(
    "primary_contact_person_id",
  ),
  primaryContactPersonName: sql<string | null>`(
    SELECT COALESCE(
      NULLIF(TRIM(p.full_name), ''),
      NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '')
    )
    FROM people_entity_roles per
    JOIN people p ON p.id = per.person_id
    WHERE per.organization_id = ${ORGS_ID} AND per.primary_contact = true
    ORDER BY per.updated_at DESC
    LIMIT 1
  )`.as("primary_contact_person_name"),
  lifetimeGiving: sql<string | null>`${orgsLifetimeGivingExpr}::text`.as(
    "lifetime_giving",
  ),
  openOpportunityCount: sql<number>`${orgsOpenOppCountExpr}`.as(
    "open_opportunity_count",
  ),
};

router.get(
  "/organizations",
  asyncHandler(async (req, res) => {
    const normalizedQuery = normalizeArrayQuery(
      req.query as Record<string, unknown>,
      ORGANIZATIONS_ARRAY_PARAMS,
    );
    const q = parseOrBadRequest(
      ListOrganizationsQueryParams,
      normalizedQuery,
      res,
    );
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];

    if (q.search)
      filters.push(ilike(organizations.name, `%${q.search}%`));
    if (q.parentOrganizationId)
      filters.push(
        eq(organizations.parentOrganizationId, q.parentOrganizationId),
      );
    // Booleans must be read from the raw query — orval emits
    // zod.coerce.boolean() which turns the string "false" into `true`.
    const issuesGrants = parseBoolQuery(req, "issuesGrants");
    if (issuesGrants != null)
      filters.push(eq(organizations.issuesGrants, issuesGrants));
    const makesPris = parseBoolQuery(req, "makesPris");
    if (makesPris != null)
      filters.push(eq(organizations.makesPris, makesPris));

    // Array-enum filters (support __blank__ sentinel via splitBlank).
    {
      const f = splitBlank(q.entityType as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0)
        filters.push(or(isNull(organizations.entityType), inArray(organizations.entityType, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(organizations.entityType));
      else if (f.values.length > 0) filters.push(inArray(organizations.entityType, f.values as never[]));
    }
    {
      const f = splitBlank(q.activeStatus as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0)
        filters.push(or(isNull(organizations.activeStatus), inArray(organizations.activeStatus, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(organizations.activeStatus));
      else if (f.values.length > 0) filters.push(inArray(organizations.activeStatus, f.values as never[]));
    }
    {
      const f = splitBlank(q.connectionStatus as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0)
        filters.push(or(isNull(organizations.connectionStatus), inArray(organizations.connectionStatus, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(organizations.connectionStatus));
      else if (f.values.length > 0) filters.push(inArray(organizations.connectionStatus, f.values as never[]));
    }
    {
      const f = splitBlank(q.enthusiasm as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0)
        filters.push(or(isNull(organizations.enthusiasm), inArray(organizations.enthusiasm, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(organizations.enthusiasm));
      else if (f.values.length > 0) filters.push(inArray(organizations.enthusiasm, f.values as never[]));
    }
    {
      const f = splitBlank(q.strategicAlignment as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0)
        filters.push(or(isNull(organizations.strategicAlignment), inArray(organizations.strategicAlignment, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(organizations.strategicAlignment));
      else if (f.values.length > 0) filters.push(inArray(organizations.strategicAlignment, f.values as never[]));
    }
    {
      const f = splitBlank(q.capacityRating as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0)
        filters.push(or(isNull(organizations.capacityRating), inArray(organizations.capacityRating, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(organizations.capacityRating));
      else if (f.values.length > 0) filters.push(inArray(organizations.capacityRating, f.values as never[]));
    }
    {
      const f = splitBlank(q.ownerUserId as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0)
        filters.push(or(isNull(organizations.ownerUserId), inArray(organizations.ownerUserId, f.values))!);
      else if (f.wantsBlank) filters.push(isNull(organizations.ownerUserId));
      else if (f.values.length > 0) filters.push(inArray(organizations.ownerUserId, f.values));
    }
    {
      const f = splitBlank(q.priority as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0)
        filters.push(or(isNull(organizations.priority), inArray(organizations.priority, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(organizations.priority));
      else if (f.values.length > 0) filters.push(inArray(organizations.priority, f.values as never[]));
    }
    {
      const ids = q.regionIds as string[] | undefined;
      if (ids && ids.length > 0) {
        filters.push(
          sql`${organizations.regionIds} && ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::text[]`,
        );
      }
    }

    // Presence filters on computed rollup fields.
    if (q.lifetimeGivingPresence === "has")
      filters.push(sql`${orgsLifetimeGivingExpr} > 0`);
    else if (q.lifetimeGivingPresence === "blank")
      filters.push(sql`${orgsLifetimeGivingExpr} <= 0`);
    if (q.openAsksPresence === "has")
      filters.push(sql`${orgsOpenOppCountExpr} > 0`);
    else if (q.openAsksPresence === "blank")
      filters.push(sql`${orgsOpenOppCountExpr} = 0`);
    if (q.primaryContactPresence === "has")
      filters.push(sql`${orgsPrimaryContactIdExpr} IS NOT NULL`);
    else if (q.primaryContactPresence === "blank")
      filters.push(sql`${orgsPrimaryContactIdExpr} IS NULL`);

    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select(orgsListSelect)
        .from(organizations)
        .where(where)
        .orderBy(asc(organizations.name))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(organizations).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/organizations/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const row = await db
      .select(orgsListSelect)
      .from(organizations)
      .where(eq(organizations.id, id))
      .then((r) => r[0]);
    if (!row) return notFound(res, "organization");
    const [people, emailRows, phoneRows, addressRows, paymentIntermediary] =
      await Promise.all([
        peopleEntityRolesQuery().where(
          eq(peopleEntityRoles.organizationId, id),
        ),
        db.select().from(emails).where(eq(emails.organizationId, id)),
        db.select().from(phoneNumbers).where(eq(phoneNumbers.organizationId, id)),
        db.select().from(addresses).where(eq(addresses.organizationId, id)),
        row.paymentIntermediaryId
          ? db
              .select()
              .from(paymentIntermediaries)
              .where(
                eq(paymentIntermediaries.id, row.paymentIntermediaryId),
              )
              .then((r) => r[0] ?? null)
          : Promise.resolve(null),
      ]);
    res.json({
      ...row,
      people,
      emails: emailRows,
      phoneNumbers: phoneRows,
      addresses: addressRows,
      paymentIntermediary,
    });
  }),
);

router.post(
  "/organizations/bulk-update",
  asyncHandler(async (req, res) => {
    await executeBulkUpdate(req, res, {
      entity: "organizations",
      table: organizations,
      bodySchema: BulkUpdateOrganizationsBody,
      allowedFields: [
        "ownerUserId",
        "activeStatus",
        "connectionStatus",
        "capacityRating",
        "enthusiasm",
        "priority",
        "entityType",
        "issuesGrants",
        "makesPris",
      ],
    });
  }),
);

router.post(
  "/organizations/bulk-delete",
  asyncHandler(async (req, res) => {
    await executeBulkDelete(req, res, {
      entity: "organizations",
      table: organizations,
      bodySchema: BulkDeleteOrganizationsBody,
    });
  }),
);

router.post(
  "/organizations/merge",
  asyncHandler(async (req, res) => {
    await mergeEntity(req, res, ORGANIZATION_MERGE_CONFIG);
  }),
);

router.post(
  "/organizations",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateOrganizationBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .insert(organizations)
      .values({ id: newId(), ...body, entityType: (body.entityType ?? null) as never })
      .returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/organizations/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateOrganizationBody, req.body, res);
    if (!body) return;
    const id = paramId(req);
    if (body.parentOrganizationId != null && body.parentOrganizationId === id) {
      res.status(400).json({ error: "An organization cannot be its own parent." });
      return;
    }

    // Pre-fetch the tracked fields only when they appear in the patch body.
    const trackingFields = ["connectionStatus", "enthusiasm"] as const;
    const needsTracking = trackingFields.some((f) => f in body);
    let before: { connectionStatus: string | null; enthusiasm: string | null } | undefined;
    if (needsTracking) {
      const [cur] = await db
        .select({ connectionStatus: organizations.connectionStatus, enthusiasm: organizations.enthusiasm })
        .from(organizations)
        .where(eq(organizations.id, id));
      before = cur;
    }

    const [row] = await db
      .update(organizations)
      .set({ ...body, updatedAt: new Date() } as never)
      .where(eq(organizations.id, id))
      .returning();
    if (!row) return notFound(res, "organization");

    // Write history entries for any tracked fields that actually changed.
    if (before !== undefined) {
      const user = getAppUser(req);
      if (user) {
        const entries: (typeof connectionEnthusiasmHistory.$inferInsert)[] = [];
        if ("connectionStatus" in body && row.connectionStatus !== before.connectionStatus) {
          entries.push({ id: newId(), entityType: "organization", entityId: row.id, field: "connectionStatus", fromValue: before.connectionStatus, toValue: row.connectionStatus, changedByUserId: user.id });
        }
        if ("enthusiasm" in body && row.enthusiasm !== before.enthusiasm) {
          entries.push({ id: newId(), entityType: "organization", entityId: row.id, field: "enthusiasm", fromValue: before.enthusiasm, toValue: row.enthusiasm, changedByUserId: user.id });
        }
        if (entries.length > 0) {
          await db.insert(connectionEnthusiasmHistory).values(entries);
        }
      }
    }

    res.json(row);
  }),
);

router.delete(
  "/organizations/:id",
  asyncHandler(async (req, res) => {
    await db
      .delete(organizations)
      .where(eq(organizations.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
