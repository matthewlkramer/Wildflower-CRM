import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { people, peopleEntityRoles, emails, phoneNumbers, addresses, connectionEnthusiasmHistory } from "@workspace/db/schema";
import { getAppUser } from "../lib/appRequest";
import { and, asc, count, eq, getTableColumns, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  ListPeopleQueryParams,
  CreatePersonBody,
  UpdatePersonBody,
  BulkUpdatePeopleBody,
  BulkArchivePeopleBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, normalizeArrayQuery, notFound, parseBoolQuery, parseOrBadRequest, parsePagination, paramId, splitBlank } from "../lib/helpers";
import { auditCreate, auditUpdate } from "../lib/audit";
import { executeBulkUpdate } from "../lib/bulkUpdate";
import { activeOnlyUnlessAdmin, archiveOne, executeBulkArchive, requireAdmin, unarchiveOne } from "../lib/archive";
import { mergeEntity, PERSON_MERGE_CONFIG } from "../lib/mergeEntities";
import { inArray } from "drizzle-orm";
import { peopleEntityRolesQuery, maskPeopleEntityRoles } from "../lib/peopleRolesSelect";
import { getViewer, maskName, type Viewer } from "../lib/identityVisibility";
import { syncPersonToFlodeskInBackground } from "../lib/flodeskSync";

// JSON object shape carried by the active/past organization-name aggregates so
// the consumer can mask anonymous org names server-side (see maskOrgNameList).
type OrgNameAgg = { name: string | null; anonymous: boolean | null; ownerUserId: string | null };

// Map an aggregated list of orgs back to the public string[] shape, replacing
// anonymous orgs the viewer can't see with "Anonymous". Preserves null (the
// ARRAY_AGG/JSONB_AGG "no rows" sentinel) so the response shape is unchanged.
function maskOrgNameList(list: OrgNameAgg[] | null, viewer: Viewer): string[] | null {
  if (!list) return null;
  return list
    .map((o) => maskName(o.name, { anonymous: o.anonymous, ownerUserId: o.ownerUserId }, viewer))
    .filter((n): n is string => n !== null);
}

// Replace the active/past organization-name aggregates on a peopleListSelect
// row with the masked string[] shape.
function maskPersonRow<
  T extends {
    activeOrganizationNames: OrgNameAgg[] | null;
    pastOrganizationNames: OrgNameAgg[] | null;
  },
>(row: T, viewer: Viewer) {
  return {
    ...row,
    activeOrganizationNames: maskOrgNameList(row.activeOrganizationNames, viewer),
    pastOrganizationNames: maskOrgNameList(row.pastOrganizationNames, viewer),
  };
}

const PEOPLE_ARRAY_PARAMS = ["capacityRating", "connectionStatus", "enthusiasm", "ownerUserId", "priority", "regionIds", "newsletterStatus"] as const;

// Derived newsletter status WHERE fragments. `unsubscribed` wins over
// the `newsletter` flag (matches the detail-page display + Flodesk
// precedence), so the three statuses are mutually exclusive and cover
// every row.
const NEWSLETTER_STATUS_SQL: Record<string, SQL> = {
  subscribed: sql`(${people.newsletter} = true AND ${people.unsubscribedToNewsletter} = false)`,
  unsubscribed: sql`${people.unsubscribedToNewsletter} = true`,
  not_subscribed: sql`(${people.newsletter} = false AND ${people.unsubscribedToNewsletter} = false)`,
};

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
// Soft-credit fragment: an organization-donor gift (organization_id IS NOT NULL)
// that this person should be credited for, because they are its primary contact,
// its advisor, OR a *current principal* of the donor organization (the
// owner/controller, even when someone else is the primary contact — the
// Katherine Bradley → Bradley Holdings case). Scoping to organization-donor gifts
// keeps this set disjoint from the direct + household sums (donor XOR guarantees
// those gifts have a NULL organization_id), so no gift is ever double-counted, and
// the three signals are OR-combined inside one subquery so a gift matching several
// of them is still counted once. Aliased `g` so the inner principal lookup's
// `organization_id` can't collide. archived_at IS NULL aligns with the app-wide
// "archived gifts are excluded from financial totals" invariant.
const peopleOrgCreditGiftWhere = sql`(
  g.organization_id IS NOT NULL AND g.archived_at IS NULL
  AND (
    g.primary_contact_person_id = ${PEOPLE_ID}
    OR g.advisor_person_id = ${PEOPLE_ID}
    OR g.organization_id IN (
      SELECT organization_id FROM people_entity_roles
      WHERE person_id = ${PEOPLE_ID}
        AND connection = 'principal'
        AND current = 'current'
        AND organization_id IS NOT NULL
    )
  )
)`;
const peopleLifetimeGivingExpr = sql`(
  COALESCE(
    (SELECT SUM(amount) FROM gifts_and_payments
      WHERE individual_giver_person_id = ${PEOPLE_ID} AND archived_at IS NULL),
    0
  ) + COALESCE(
    (SELECT SUM(amount) FROM gifts_and_payments
      WHERE archived_at IS NULL AND household_id IN (
        SELECT household_id FROM people_entity_roles
        WHERE person_id = ${PEOPLE_ID} AND household_id IS NOT NULL
      )),
    0
  ) + COALESCE(
    (SELECT SUM(g.amount) FROM gifts_and_payments g
      WHERE ${peopleOrgCreditGiftWhere}),
    0
  )
)`;
const peopleMostRecentGiftExpr = sql`(
  SELECT MAX(d) FROM (
    SELECT MAX(date_received) AS d FROM gifts_and_payments
      WHERE individual_giver_person_id = ${PEOPLE_ID} AND archived_at IS NULL
    UNION ALL
    SELECT MAX(date_received) AS d FROM gifts_and_payments
      WHERE archived_at IS NULL AND household_id IN (
        SELECT household_id FROM people_entity_roles
        WHERE person_id = ${PEOPLE_ID} AND household_id IS NOT NULL
      )
    UNION ALL
    SELECT MAX(g.date_received) AS d FROM gifts_and_payments g
      WHERE ${peopleOrgCreditGiftWhere}
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

// The Wildflower Foundation organization (name "Wildflower Foundation", email
// domain wildflowerschools.org). People with a *current* role here are internal
// staff ("foundation partners"); the individuals list hides them by default via
// the showFoundationPartners toggle. The org PK is an Airtable record id (stable
// across dev/prod since both seed from the same base).
const FOUNDATION_ORG_ID = "rec6Imee3i0zIjcJ8";
const peopleCurrentFoundationRoleExists = sql`EXISTS (
  SELECT 1 FROM people_entity_roles per
  WHERE per.person_id = ${PEOPLE_ID}
    AND per.current = 'current'
    AND per.organization_id = ${FOUNDATION_ORG_ID}
)`;

// Default list sort key. Mirrors the client's personDisplayName() so the
// server-paginated order matches the name shown in the UI (the full
// "First Last" name), instead of the old last_name,first_name order — which
// looked unsorted next to the displayed name and disagreed with the
// click-to-sort "Name" order. Uses the same fallback chain as
// personDisplayName (full name → first+last → nickname → "Person <id>").
const peopleDisplayNameOrder = sql`lower(coalesce(
  nullif(btrim("people"."full_name"), ''),
  nullif(btrim(concat_ws(' ', "people"."first_name", "people"."last_name")), ''),
  nullif(btrim("people"."nickname"), ''),
  'Person ' || "people"."id"
))`;

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
  // at the same organization (different role titles, etc.). We aggregate
  // JSON objects carrying name + anonymous + owner so the consumer can mask
  // anonymous org names (see maskOrgNameList); the DISTINCT happens in the
  // derived table (DISTINCT + ORDER BY can't coexist inside JSONB_AGG) and
  // the public response is mapped back to string[].
  activeOrganizationNames: sql<OrgNameAgg[] | null>`(
    SELECT JSONB_AGG(
      JSONB_BUILD_OBJECT('name', o.name, 'anonymous', o.anonymous, 'ownerUserId', o.owner_user_id)
      ORDER BY o.name
    )
    FROM (
      SELECT DISTINCT o.id, o.name, o.anonymous, o.owner_user_id
      FROM people_entity_roles per
      JOIN organizations o ON o.id = per.organization_id
      WHERE per.person_id = ${PEOPLE_ID}
        AND per.current = 'current'
        AND per.organization_id IS NOT NULL
    ) o
  )`.as("active_organization_names"),
  // Past organization roles — fallback in the list column.
  pastOrganizationNames: sql<OrgNameAgg[] | null>`(
    SELECT JSONB_AGG(
      JSONB_BUILD_OBJECT('name', o.name, 'anonymous', o.anonymous, 'ownerUserId', o.owner_user_id)
      ORDER BY o.name
    )
    FROM (
      SELECT DISTINCT o.id, o.name, o.anonymous, o.owner_user_id
      FROM people_entity_roles per
      JOIN organizations o ON o.id = per.organization_id
      WHERE per.person_id = ${PEOPLE_ID}
        AND per.current = 'past'
        AND per.organization_id IS NOT NULL
    ) o
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
    // Hide internal Wildflower Foundation staff unless the "Show foundation
    // partners" toggle is on. Read from the raw query string (like deceased,
    // the generated zod coerces "false" to true). Param absent = no filter, so
    // other listPeople consumers (pickers, etc.) are unaffected.
    const showFoundationPartners = parseBoolQuery(req, "showFoundationPartners");
    if (showFoundationPartners === false) filters.push(sql`NOT ${peopleCurrentFoundationRoleExists}`);
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
    // Derived newsletter status — OR the selected statuses together.
    {
      const statuses = (q.newsletterStatus as string[] | undefined) ?? [];
      const clauses = statuses
        .map((s) => NEWSLETTER_STATUS_SQL[s])
        .filter((c): c is SQL => !!c);
      if (clauses.length > 0) filters.push(or(...clauses)!);
    }
    const archivedFilter = activeOnlyUnlessAdmin(req, people.archivedAt);
    if (archivedFilter) filters.push(archivedFilter);
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select(peopleListSelect)
        .from(people)
        .where(where)
        // Tiebreak on id so offset pagination is stable for duplicate names.
        .orderBy(asc(peopleDisplayNameOrder), asc(people.id))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(people).where(where),
    ]);
    const viewer = getViewer(req);
    const data = rows.map((r) => maskPersonRow(r, viewer));
    res.json({ data, pagination: { page, limit, total: Number(total) } });
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
    const viewer = getViewer(req);
    res.json({
      ...maskPersonRow(row, viewer),
      roles: maskPeopleEntityRoles(roles, viewer),
      emails: emailRows,
      phoneNumbers: phoneRows,
      addresses: addressRows,
    });
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
        "newsletter",
      ],
      // Mirror newsletter changes out to Flodesk per updated row, the
      // same way the single PATCH does. Fire-and-forget + no-op when
      // Flodesk isn't configured; precedence rules still apply (a
      // Flodesk unsubscribe wins). Only worth doing when the patch
      // actually touched the newsletter flag.
      afterApply: Object.prototype.hasOwnProperty.call(req.body?.patch ?? {}, "newsletter")
        ? async (id: string) => {
            syncPersonToFlodeskInBackground(id);
          }
        : undefined,
    });
  }),
);

router.post(
  "/people/bulk-archive",
  asyncHandler(async (req, res) => {
    await executeBulkArchive(req, res, {
      entity: "people",
      table: people,
      bodySchema: BulkArchivePeopleBody,
    });
  }),
);

router.post(
  "/people/:id/archive",
  asyncHandler(async (req, res) => {
    await archiveOne(req, res, { entity: "person", table: people });
  }),
);

router.post(
  "/people/:id/unarchive",
  asyncHandler(async (req, res) => {
    await unarchiveOne(req, res, { entity: "person", table: people });
  }),
);

router.post(
  "/people/merge",
  asyncHandler(async (req, res) => {
    // Merging is irreversible (it archives the duplicate and re-points every FK)
    // — admin-only, same gate as the potential-duplicates queue that surfaces it.
    if (!requireAdmin(req, res)) return;
    await mergeEntity(req, res, PERSON_MERGE_CONFIG);
  }),
);

router.post(
  "/people",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreatePersonBody, req.body, res);
    if (!body) return;
    const [row] = await db.insert(people).values({ id: newId(), ...body }).returning();
    if (row) {
      await auditCreate(req, "person", row.id, `Created person ${[row.firstName, row.lastName].filter(Boolean).join(" ").trim()}`.trimEnd());
      // Push newsletter membership to Flodesk (fire-and-forget; safe + no-op
      // when Flodesk isn't configured or the person has no usable email).
      syncPersonToFlodeskInBackground(row.id);
    }
    res.status(201).json(row);
  }),
);

router.patch(
  "/people/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdatePersonBody, req.body, res);
    if (!body) return;
    const id = paramId(req);

    // Full before-row for the audit diff (also reused for the connection/
    // enthusiasm change history below).
    const [auditBefore] = await db.select().from(people).where(eq(people.id, id));
    const trackingFields = ["connectionStatus", "enthusiasm"] as const;
    const needsTracking = trackingFields.some((f) => f in body);
    const before = needsTracking ? auditBefore : undefined;

    const [row] = await db
      .update(people)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(people.id, id))
      .returning();
    if (!row) return notFound(res, "person");

    // Write history entries for any tracked fields that actually changed.
    if (before !== undefined) {
      const user = getAppUser(req);
      if (user) {
        const entries: (typeof connectionEnthusiasmHistory.$inferInsert)[] = [];
        if ("connectionStatus" in body && row.connectionStatus !== before.connectionStatus) {
          entries.push({ id: newId(), entityType: "person", entityId: row.id, field: "connectionStatus", fromValue: before.connectionStatus, toValue: row.connectionStatus, changedByUserId: user.id });
        }
        if ("enthusiasm" in body && row.enthusiasm !== before.enthusiasm) {
          entries.push({ id: newId(), entityType: "person", entityId: row.id, field: "enthusiasm", fromValue: before.enthusiasm, toValue: row.enthusiasm, changedByUserId: user.id });
        }
        if (entries.length > 0) {
          await db.insert(connectionEnthusiasmHistory).values(entries);
        }
      }
    }

    await auditUpdate(req, "person", row.id, auditBefore as Record<string, unknown> | undefined, row as Record<string, unknown>, Object.keys(body), `Updated person ${[row.firstName, row.lastName].filter(Boolean).join(" ")}`.trimEnd());

    // Propagate newsletter/unsubscribe changes out to Flodesk (fire-and-forget).
    syncPersonToFlodeskInBackground(row.id);
    res.json(row);
  }),
);

export default router;
