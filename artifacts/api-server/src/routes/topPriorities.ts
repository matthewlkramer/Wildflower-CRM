import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { organizations, people } from "@workspace/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler } from "../lib/helpers";
import { getAppUser } from "../lib/appRequest";
import { ANON_LABEL, canSeeIdentity } from "../lib/identityVisibility";

const router: IRouter = Router();
router.use(requireAuth);

const ORGS_ID = sql.raw(`"organizations"."id"`);
const PEOPLE_ID = sql.raw(`"people"."id"`);

// ─── Correlated subquery fragments scoped to organizations.id ──────────────

const orgOpenOppCountExpr = sql`(
  SELECT COUNT(*)::int FROM opportunities_and_pledges
  WHERE organization_id = ${ORGS_ID} AND status = 'open'
)`;

const orgOpenTaskCountExpr = sql`(
  SELECT COUNT(*)::int FROM tasks
  WHERE ${ORGS_ID} = ANY(organization_ids) AND status = 'open'
)`;

// Aggregates this org's open opportunities (asks) as a JSON array.
const orgOpenAsksExpr = sql`(
  SELECT COALESCE(
    JSON_AGG(
      JSON_BUILD_OBJECT(
        'opportunityId',   o.id,
        'opportunityName', COALESCE(NULLIF(TRIM(o.name), ''), 'Untitled ' || o.id)
      )
      ORDER BY o.name NULLS LAST, o.id
    ),
    '[]'::json
  )
  FROM opportunities_and_pledges o
  WHERE o.organization_id = ${ORGS_ID} AND o.status = 'open'
)`;

const orgLastGiftDateExpr = sql`(
  SELECT MAX(date_received)::text FROM gifts_and_payments
  WHERE organization_id = ${ORGS_ID}
)`;

const orgLastGiftAmountExpr = sql`(
  SELECT amount::text FROM gifts_and_payments
  WHERE organization_id = ${ORGS_ID}
  ORDER BY date_received DESC NULLS LAST
  LIMIT 1
)`;

// Aggregates current affiliated people as a JSON array.
const orgAffiliatedPeopleExpr = sql`(
  SELECT COALESCE(
    JSON_AGG(
      JSON_BUILD_OBJECT(
        'personId',    p.id,
        'personName',  COALESCE(
                         NULLIF(TRIM(p.full_name), ''),
                         NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), ''),
                         p.id
                       ),
        'anonymous',   p.anonymous,
        'ownerUserId', p.owner_user_id
      )
      ORDER BY p.last_name NULLS LAST, p.first_name NULLS LAST
    ),
    '[]'::json
  )
  FROM people_entity_roles per
  JOIN people p ON p.id = per.person_id
  WHERE per.organization_id = ${ORGS_ID}
    AND per.current = 'current'
)`;

// ─── Correlated subquery fragments scoped to people.id ────────────────────

const personOpenOppCountExpr = sql`(
  SELECT COUNT(*)::int FROM opportunities_and_pledges
  WHERE individual_giver_person_id = ${PEOPLE_ID} AND status = 'open'
)`;

const personOpenTaskCountExpr = sql`(
  SELECT COUNT(*)::int FROM tasks
  WHERE ${PEOPLE_ID} = ANY(person_ids) AND status = 'open'
)`;

// Aggregates this person's open opportunities (asks, as individual giver) as a JSON array.
const personOpenAsksExpr = sql`(
  SELECT COALESCE(
    JSON_AGG(
      JSON_BUILD_OBJECT(
        'opportunityId',   o.id,
        'opportunityName', COALESCE(NULLIF(TRIM(o.name), ''), 'Untitled ' || o.id)
      )
      ORDER BY o.name NULLS LAST, o.id
    ),
    '[]'::json
  )
  FROM opportunities_and_pledges o
  WHERE o.individual_giver_person_id = ${PEOPLE_ID} AND o.status = 'open'
)`;

const personLastGiftDateExpr = sql`(
  SELECT MAX(d)::text FROM (
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

const personLastGiftAmountExpr = sql`(
  SELECT amount::text FROM gifts_and_payments
  WHERE individual_giver_person_id = ${PEOPLE_ID}
    OR household_id IN (
      SELECT household_id FROM people_entity_roles
      WHERE person_id = ${PEOPLE_ID} AND household_id IS NOT NULL
    )
  ORDER BY date_received DESC NULLS LAST
  LIMIT 1
)`;

// ─── Visibility helpers (mirror UI canSeeIdentity logic server-side) ───────
// canSeeIdentity is the shared helper in ../lib/identityVisibility; the local
// mask* wrappers adapt the (viewerId, viewerRole) call sites to a Viewer.

function maskOrgName(name: string, anonymous: boolean, ownerUserId: string | null, viewerId: string, viewerRole: string): string {
  return canSeeIdentity({ anonymous, ownerUserId }, { id: viewerId, role: viewerRole }) ? name : ANON_LABEL;
}

function maskPersonName(
  raw: { fullName: string | null; firstName: string | null; lastName: string | null; id: string },
  anonymous: boolean,
  ownerUserId: string | null,
  viewerId: string,
  viewerRole: string,
): { firstName: string | null; lastName: string | null; fullName: string | null } {
  if (canSeeIdentity({ anonymous, ownerUserId }, { id: viewerId, role: viewerRole })) {
    return { firstName: raw.firstName, lastName: raw.lastName, fullName: raw.fullName };
  }
  return { firstName: ANON_LABEL, lastName: null, fullName: ANON_LABEL };
}

router.get(
  "/top-priorities",
  asyncHandler(async (req, res) => {
    const viewer = getAppUser(req);
    const viewerId = viewer?.id ?? "";
    const viewerRole = viewer?.role ?? "";

    const [orgRows, personRows] = await Promise.all([
      db
        .select({
          id: organizations.id,
          name: organizations.name,
          anonymous: organizations.anonymous,
          ownerUserId: organizations.ownerUserId,
          openOpportunityCount: sql<number>`${orgOpenOppCountExpr}`.as("open_opportunity_count"),
          openTaskCount: sql<number>`${orgOpenTaskCountExpr}`.as("open_task_count"),
          openAsks: sql<Array<{ opportunityId: string; opportunityName: string }>>`${orgOpenAsksExpr}`.as("open_asks"),
          affiliatedPeople: sql<Array<{ personId: string; personName: string; anonymous: boolean; ownerUserId: string | null }>>`${orgAffiliatedPeopleExpr}`.as("affiliated_people"),
          lastGiftDate: sql<string | null>`${orgLastGiftDateExpr}`.as("last_gift_date"),
          lastGiftAmount: sql<string | null>`${orgLastGiftAmountExpr}`.as("last_gift_amount"),
        })
        .from(organizations)
        .where(eq(organizations.priority, "top"))
        .orderBy(asc(organizations.name)),

      db
        .select({
          id: people.id,
          firstName: people.firstName,
          lastName: people.lastName,
          fullName: people.fullName,
          anonymous: people.anonymous,
          ownerUserId: people.ownerUserId,
          openOpportunityCount: sql<number>`${personOpenOppCountExpr}`.as("open_opportunity_count"),
          openTaskCount: sql<number>`${personOpenTaskCountExpr}`.as("open_task_count"),
          openAsks: sql<Array<{ opportunityId: string; opportunityName: string }>>`${personOpenAsksExpr}`.as("open_asks"),
          lastGiftDate: sql<string | null>`${personLastGiftDateExpr}`.as("last_gift_date"),
          lastGiftAmount: sql<string | null>`${personLastGiftAmountExpr}`.as("last_gift_amount"),
        })
        .from(people)
        .where(
          and(
            eq(people.priority, "top"),
            sql`NOT EXISTS (
              SELECT 1 FROM people_entity_roles per
              JOIN organizations o ON o.id = per.organization_id
              WHERE per.person_id = ${PEOPLE_ID}
                AND per.current = 'current'
                AND o.priority = 'top'
            )`,
          ),
        )
        .orderBy(asc(people.lastName), asc(people.firstName)),
    ]);

    // Apply server-side anonymous masking so the API never exposes a real
    // name to a viewer who isn't the owner or an admin.
    const maskedOrgs = orgRows.map((f) => {
      // Opportunity titles often embed the donor name (e.g. "FY27 Arthur Rock
      // gift"), so mask them in lockstep with the parent org's name visibility.
      const orgVisible = canSeeIdentity({ anonymous: f.anonymous, ownerUserId: f.ownerUserId }, { id: viewerId, role: viewerRole });
      return {
        ...f,
        name: maskOrgName(f.name, f.anonymous, f.ownerUserId, viewerId, viewerRole),
        openAsks: orgVisible
          ? (f.openAsks ?? [])
          : (f.openAsks ?? []).map((a) => ({ ...a, opportunityName: ANON_LABEL })),
        affiliatedPeople: (f.affiliatedPeople ?? []).map((p) => ({
          ...p,
          personName: canSeeIdentity({ anonymous: p.anonymous, ownerUserId: p.ownerUserId }, { id: viewerId, role: viewerRole })
            ? p.personName
            : ANON_LABEL,
        })),
      };
    });

    const maskedPeople = personRows.map((p) => {
      const names = maskPersonName(p, p.anonymous, p.ownerUserId, viewerId, viewerRole);
      const personVisible = canSeeIdentity({ anonymous: p.anonymous, ownerUserId: p.ownerUserId }, { id: viewerId, role: viewerRole });
      const openAsks = personVisible
        ? (p.openAsks ?? [])
        : (p.openAsks ?? []).map((a) => ({ ...a, opportunityName: ANON_LABEL }));
      return { ...p, ...names, openAsks };
    });

    res.json({ organizations: maskedOrgs, individuals: maskedPeople });
  }),
);

export default router;
