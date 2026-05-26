import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import { opportunitiesAndPledges, pledgeAllocations, giftsAndPayments, funders, households, people } from "@workspace/db/schema";
import { alias } from "drizzle-orm/pg-core";
import { and, count, desc, eq, exists, getTableColumns, ilike, inArray, sql, type SQL } from "drizzle-orm";

// Second `people` alias so we can join *both* the individual giver
// (via individual_giver_person_id) and the primary contact (via
// primary_contact_person_id) in the same query without collision.
const primaryContact = alias(people, "primary_contact_person");

// Returns all opportunity columns plus denormalized donor display names
// (funder / household / individual giver), primary-contact display name,
// the derived fiscal-year slug, and the de-duplicated set of grant
// years from pledge_allocations. Keeps list + detail responses
// self-contained so the UI doesn't fire one fetch per row.
// Person display name matches the client's `personDisplayName`:
// COALESCE(full_name, trim(first||' '||last)).
const donorJoinSelect = {
  ...getTableColumns(opportunitiesAndPledges),
  funderName: funders.name,
  householdName: households.name,
  individualGiverPersonName: sql<string | null>`
    COALESCE(
      NULLIF(TRIM(${people.fullName}), ''),
      NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
    )
  `.as("individual_giver_person_name"),
  // Denormalized top-priority flags so the donor cell can render a
  // star without an extra fetch. NULL when the corresponding ID isn't
  // set (xor — only one of funder / household / person is non-null
  // per row).
  funderIsPriority: funders.isPriority,
  individualGiverPersonIsPriority: people.isPriority,
  primaryContactPersonName: sql<string | null>`
    COALESCE(
      NULLIF(TRIM(${primaryContact.fullName}), ''),
      NULLIF(TRIM(CONCAT_WS(' ', ${primaryContact.firstName}, ${primaryContact.lastName})), '')
    )
  `.as("primary_contact_person_name"),
  // FY ends Jun 30 in America/Chicago, so Jul-Dec roll forward. We
  // shift the date by 6 months and read the year off — gives the same
  // answer as a CASE on EXTRACT(MONTH) but in fewer ops. Apostrophe-
  // free slug: "FY26". Null when projected_close_date is null.
  fiscalYear: sql<string | null>`
    CASE WHEN ${opportunitiesAndPledges.projectedCloseDate} IS NULL THEN NULL
    ELSE 'FY' || RIGHT(
      EXTRACT(YEAR FROM (${opportunitiesAndPledges.projectedCloseDate}::date + INTERVAL '6 months'))::text,
      2
    ) END
  `.as("fiscal_year"),
  coveredFiscalYears: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT pa.grant_year ORDER BY pa.grant_year)
    FROM pledge_allocations pa
    WHERE pa.pledge_or_opportunity_id = ${opportunitiesAndPledges.id}
      AND pa.grant_year IS NOT NULL
  )`.as("covered_fiscal_years"),
};

import {
  ListOpportunitiesAndPledgesQueryParams,
  CreateOpportunityOrPledgeBodyRefined,
  UpdateOpportunityOrPledgeBody,
  BulkUpdateOpportunitiesAndPledgesBody,
  validateOppInvariants,
  type InvariantIssue,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, normalizeArrayQuery, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";
import { executeBulkUpdate } from "../lib/bulkUpdate";

const router: IRouter = Router();
router.use(requireAuth);

const OPP_ARRAY_PARAMS = ["fiscalYear", "status", "stage", "type", "ownerUserId"] as const;

function respondInvariantFailure(res: Response, issues: InvariantIssue[]): void {
  res.status(400).json({
    error: "validation_error",
    message: "Request validation failed",
    details: { issues: issues.map((i) => ({ path: [i.path], message: i.message })) },
  });
}

router.get(
  "/opportunities-and-pledges",
  asyncHandler(async (req, res) => {
    // Pre-normalize array params so the generated array<…> zod schemas
    // accept the orval comma-form (single string).
    const normalizedQuery = normalizeArrayQuery(
      req.query as Record<string, unknown>,
      OPP_ARRAY_PARAMS,
    );
    // Fiscal-year slugs are stored lowercase (`fy2026`, `future`). Preserve
    // the prior route behavior of accepting manually-typed uppercase values
    // by lowercasing here, after the comma-form split.
    if (Array.isArray(normalizedQuery.fiscalYear)) {
      normalizedQuery.fiscalYear = (normalizedQuery.fiscalYear as unknown[]).map(
        (v) => (typeof v === "string" ? v.toLowerCase() : v),
      );
    }
    const q = parseOrBadRequest(ListOpportunitiesAndPledgesQueryParams, normalizedQuery, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) filters.push(ilike(opportunitiesAndPledges.name, `%${q.search}%`));
    if (q.status && q.status.length > 0) filters.push(inArray(opportunitiesAndPledges.status, q.status));
    if (q.stage && q.stage.length > 0) filters.push(inArray(opportunitiesAndPledges.stage, q.stage));
    if (q.type && q.type.length > 0) filters.push(inArray(opportunitiesAndPledges.type, q.type));
    if (q.funderId) filters.push(eq(opportunitiesAndPledges.funderId, q.funderId));
    if (q.householdId) filters.push(eq(opportunitiesAndPledges.householdId, q.householdId));
    if (q.individualGiverPersonId) filters.push(eq(opportunitiesAndPledges.individualGiverPersonId, q.individualGiverPersonId));
    if (q.ownerUserId && q.ownerUserId.length > 0) filters.push(inArray(opportunitiesAndPledges.ownerUserId, q.ownerUserId));
    // Multi-value fiscal-year filter — matches opps that have at least
    // one pledge_allocation row whose grant_year is in the selected set.
    // Use EXISTS rather than a JOIN so we don't fan rows out (one opp
    // with three allocations should still count once).
    const fiscalYearSelected = q.fiscalYear ?? [];
    if (fiscalYearSelected.length > 0) {
      filters.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(pledgeAllocations)
            .where(
              and(
                eq(pledgeAllocations.pledgeOrOpportunityId, opportunitiesAndPledges.id),
                inArray(pledgeAllocations.grantYear, fiscalYearSelected),
              ),
            ),
        ),
      );
    }
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select(donorJoinSelect)
        .from(opportunitiesAndPledges)
        .leftJoin(funders, eq(funders.id, opportunitiesAndPledges.funderId))
        .leftJoin(households, eq(households.id, opportunitiesAndPledges.householdId))
        .leftJoin(people, eq(people.id, opportunitiesAndPledges.individualGiverPersonId))
        .leftJoin(primaryContact, eq(primaryContact.id, opportunitiesAndPledges.primaryContactPersonId))
        .where(where)
        .orderBy(desc(opportunitiesAndPledges.projectedCloseDate))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(opportunitiesAndPledges).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/opportunities-and-pledges/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const row = await db
      .select(donorJoinSelect)
      .from(opportunitiesAndPledges)
      .leftJoin(funders, eq(funders.id, opportunitiesAndPledges.funderId))
      .leftJoin(households, eq(households.id, opportunitiesAndPledges.householdId))
      .leftJoin(people, eq(people.id, opportunitiesAndPledges.individualGiverPersonId))
      .leftJoin(primaryContact, eq(primaryContact.id, opportunitiesAndPledges.primaryContactPersonId))
      .where(eq(opportunitiesAndPledges.id, id))
      .then((r) => r[0]);
    if (!row) return notFound(res, "opportunity");
    const [allocations, payments] = await Promise.all([
      db.select().from(pledgeAllocations).where(eq(pledgeAllocations.pledgeOrOpportunityId, id)),
      db.select().from(giftsAndPayments).where(eq(giftsAndPayments.paymentOnPledgeId, id)),
    ]);
    res.json({ ...row, allocations, payments });
  }),
);

router.post(
  "/opportunities-and-pledges/bulk-update",
  asyncHandler(async (req, res) => {
    await executeBulkUpdate(req, res, {
      entity: "opportunities_and_pledges",
      table: opportunitiesAndPledges,
      bodySchema: BulkUpdateOpportunitiesAndPledgesBody,
      allowedFields: ["ownerUserId", "status", "stage", "type", "actualCompletionDate"],
      // Allocation-table reconciliation field — not a column on
      // opportunities_and_pledges, so it goes through extraApply and
      // is excluded from the column SET.
      virtualFields: ["coveredFiscalYears", "coveredFiscalYearsMode"],
      // Donor xor is preserved (no donor fields in this patch), but the
      // closed_requires_completion_date CHECK can still trip if a row is
      // bulk-set to status='won'/'lost' without an existing or supplied
      // actualCompletionDate. Run the same invariant check the single
      // PATCH route uses, on the merged post-update state.
      validateRow: (existing, patch) => {
        const merged = { ...existing, ...patch } as Record<string, unknown>;
        const issues = validateOppInvariants({
          funderId: merged.funderId as string | null | undefined,
          individualGiverPersonId: merged.individualGiverPersonId as string | null | undefined,
          householdId: merged.householdId as string | null | undefined,
          status: merged.status as string | null | undefined,
          actualCompletionDate: merged.actualCompletionDate as string | Date | null | undefined,
        });
        return issues.length ? issues.map((i) => i.message).join("; ") : null;
      },
      // Reconcile pledge_allocations rows so the opportunity's
      // covered FYs match the requested set. Replace = wipe existing
      // allocations and recreate one minimal row per FY (DESTRUCTIVE
      // — loses subAmount/intendedUsage/etc on those rows). Append =
      // insert allocations only for FYs not already represented.
      extraApply: async (tx, id, vp) => {
        const fys = (vp as { coveredFiscalYears?: string[] }).coveredFiscalYears;
        if (!fys) return;
        const mode =
          (vp as { coveredFiscalYearsMode?: string }).coveredFiscalYearsMode ===
          "append"
            ? "append"
            : "replace";
        if (mode === "replace") {
          await tx
            .delete(pledgeAllocations)
            .where(eq(pledgeAllocations.pledgeOrOpportunityId, id));
        }
        const existingFys =
          mode === "append"
            ? (
                await tx
                  .select({ y: pledgeAllocations.grantYear })
                  .from(pledgeAllocations)
                  .where(eq(pledgeAllocations.pledgeOrOpportunityId, id))
              )
                .map((r: { y: string | null }) => r.y)
                .filter((y: string | null): y is string => !!y)
            : [];
        const toInsert = fys.filter((fy) => !existingFys.includes(fy));
        for (const fy of toInsert) {
          await tx.insert(pledgeAllocations).values({
            id: newId(),
            pledgeOrOpportunityId: id,
            grantYear: fy,
          });
        }
      },
    });
  }),
);

router.post(
  "/opportunities-and-pledges",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateOpportunityOrPledgeBodyRefined, req.body, res);
    if (!body) return;
    const [row] = await db.insert(opportunitiesAndPledges).values({ id: newId(), ...body }).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/opportunities-and-pledges/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateOpportunityOrPledgeBody, req.body, res);
    if (!body) return;
    const id = paramId(req);
    const existing = await db
      .select()
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "opportunity");

    // Validate merged post-update state against DB invariants so we return
    // 400 instead of letting a partial PATCH trip the CHECK constraint as a 500.
    const merged = { ...existing, ...body };
    const issues = validateOppInvariants({
      funderId: merged.funderId,
      individualGiverPersonId: merged.individualGiverPersonId,
      householdId: merged.householdId,
      status: merged.status,
      actualCompletionDate: merged.actualCompletionDate,
    });
    if (issues.length) return respondInvariantFailure(res, issues);

    const [row] = await db
      .update(opportunitiesAndPledges)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(opportunitiesAndPledges.id, id))
      .returning();
    if (!row) return notFound(res, "opportunity");
    res.json(row);
  }),
);

router.delete(
  "/opportunities-and-pledges/:id",
  asyncHandler(async (req, res) => {
    await db.delete(opportunitiesAndPledges).where(eq(opportunitiesAndPledges.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
