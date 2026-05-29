import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import { opportunitiesAndPledges, pledgeAllocations, giftsAndPayments, funders, households, people, tasks, type NewPledgeAllocation } from "@workspace/db/schema";
import { alias } from "drizzle-orm/pg-core";
import { and, count, desc, eq, exists, getTableColumns, ilike, inArray, isNull, notExists, or, sql, type SQL } from "drizzle-orm";

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
  // Denormalized priority tier so the donor cell can render a star
  // (when priority === 'top') without an extra fetch. NULL when the
  // corresponding ID isn't set (xor — only one of funder / household /
  // person is non-null per row).
  funderPriority: funders.priority,
  individualGiverPersonPriority: people.priority,
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
  // Distinct entity slugs from pledge_allocations. Mirrors the gifts
  // route so the opps list/detail can render an Entities column
  // without firing one fetch per row.
  entityIds: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT pa.entity_id ORDER BY pa.entity_id)
    FROM pledge_allocations pa
    WHERE pa.pledge_or_opportunity_id = ${opportunitiesAndPledges.id}
      AND pa.entity_id IS NOT NULL
  )`.as("entity_ids"),
  // Total received against this pledge — SUM(amount) of every
  // gifts_and_payments row whose payment_on_pledge_id points at this
  // opp. Returned as a numeric string ("0" when no payments). Lets the
  // pledges UI render a Paid column without one fetch per row.
  paidAmount: sql<string>`(
    SELECT COALESCE(SUM(gp.amount), 0)::text
    FROM gifts_and_payments gp
    WHERE gp.payment_on_pledge_id = ${opportunitiesAndPledges.id}
  )`.as("paid_amount"),
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
import { asyncHandler, newId, normalizeArrayQuery, notFound, parseOrBadRequest, parsePagination, paramId, splitBlank } from "../lib/helpers";
import { executeBulkUpdate } from "../lib/bulkUpdate";
import { applyDerivedOppFields, canonicalWinProbability } from "../lib/pledgeStage";

const router: IRouter = Router();
router.use(requireAuth);

const OPP_ARRAY_PARAMS = ["fiscalYear", "status", "stage", "type", "ownerUserId", "entityId"] as const;

// Stages that put a row on the Pledges page even without was_pledge=true.
// Mirrors `PLEDGE_STAGES` in lib/pledgeStage.ts.
const PLEDGE_STAGE_VALUES = [
  "conditional_commitment",
  "verbal_commitment",
  "written_commitment",
] as const;

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
    // Fiscal-year slugs are stored lowercase (`fy2026`). Preserve
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
    {
      const f = splitBlank(q.status as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(opportunitiesAndPledges.status), inArray(opportunitiesAndPledges.status, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(opportunitiesAndPledges.status));
      else if (f.values.length > 0) filters.push(inArray(opportunitiesAndPledges.status, f.values as never[]));
    }
    {
      const f = splitBlank(q.stage as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(opportunitiesAndPledges.stage), inArray(opportunitiesAndPledges.stage, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(opportunitiesAndPledges.stage));
      else if (f.values.length > 0) filters.push(inArray(opportunitiesAndPledges.stage, f.values as never[]));
    }
    {
      const f = splitBlank(q.type as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(opportunitiesAndPledges.type), inArray(opportunitiesAndPledges.type, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(opportunitiesAndPledges.type));
      else if (f.values.length > 0) filters.push(inArray(opportunitiesAndPledges.type, f.values as never[]));
    }
    if (q.funderId) filters.push(eq(opportunitiesAndPledges.funderId, q.funderId));
    if (q.householdId) filters.push(eq(opportunitiesAndPledges.householdId, q.householdId));
    if (q.individualGiverPersonId) filters.push(eq(opportunitiesAndPledges.individualGiverPersonId, q.individualGiverPersonId));
    {
      const f = splitBlank(q.ownerUserId as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(opportunitiesAndPledges.ownerUserId), inArray(opportunitiesAndPledges.ownerUserId, f.values))!);
      else if (f.wantsBlank) filters.push(isNull(opportunitiesAndPledges.ownerUserId));
      else if (f.values.length > 0) filters.push(inArray(opportunitiesAndPledges.ownerUserId, f.values));
    }
    if (typeof q.wasPledge === "boolean") filters.push(eq(opportunitiesAndPledges.wasPledge, q.wasPledge));
    // Convenience filter that encodes the page split. Translates to a
    // boolean OR on (was_pledge, stage ∈ pledge stages). See the
    // OpportunityOrPledge schema comments for the rationale.
    if (q.pledgeView === "pledges") {
      filters.push(
        sql`(${opportunitiesAndPledges.wasPledge} = true OR ${opportunitiesAndPledges.stage} = ANY(ARRAY[${sql.join(
          PLEDGE_STAGE_VALUES.map((v) => sql`${v}`),
          sql`, `,
        )}]::opportunity_stage[]))`,
      );
    } else if (q.pledgeView === "opportunities") {
      filters.push(
        sql`(${opportunitiesAndPledges.wasPledge} = false AND (${opportunitiesAndPledges.stage} IS NULL OR ${opportunitiesAndPledges.stage} <> ALL(ARRAY[${sql.join(
          PLEDGE_STAGE_VALUES.map((v) => sql`${v}`),
          sql`, `,
        )}]::opportunity_stage[])))`,
      );
    }
    // Multi-value fiscal-year filter — matches opps that have at least
    // one pledge_allocation row whose grant_year is in the selected set.
    // Use EXISTS rather than a JOIN so we don't fan rows out (one opp
    // with three allocations should still count once).
    // Fiscal-year filter — supports the "(Blank)" sentinel which matches
    // opportunities with no pledge_allocation rows at all. Real fiscal years
    // continue to use the EXISTS pattern so multi-allocation opps don't fan
    // out into duplicate rows.
    {
      const fyRaw = (q.fiscalYear as string[] | undefined) ?? [];
      const { wantsBlank, values: fyValues } = splitBlank(fyRaw);
      const existsClause =
        fyValues.length > 0
          ? exists(
              db
                .select({ one: sql`1` })
                .from(pledgeAllocations)
                .where(
                  and(
                    eq(pledgeAllocations.pledgeOrOpportunityId, opportunitiesAndPledges.id),
                    inArray(pledgeAllocations.grantYear, fyValues),
                  ),
                ),
            )
          : undefined;
      const noAllocClause = wantsBlank
        ? notExists(
            db
              .select({ one: sql`1` })
              .from(pledgeAllocations)
              .where(eq(pledgeAllocations.pledgeOrOpportunityId, opportunitiesAndPledges.id)),
          )
        : undefined;
      if (existsClause && noAllocClause) filters.push(or(existsClause, noAllocClause)!);
      else if (existsClause) filters.push(existsClause);
      else if (noAllocClause) filters.push(noAllocClause);
    }
    // Entity filter — same EXISTS pattern as fiscalYear. Matches opps
    // that have at least one pledge_allocation row pinned to one of
    // the requested entity slugs. Driven by the global entity filter
    // in the header (and the opps page's own entity multi-select).
    const entitySelected = q.entityId ?? [];
    if (entitySelected.length > 0) {
      filters.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(pledgeAllocations)
            .where(
              and(
                eq(pledgeAllocations.pledgeOrOpportunityId, opportunitiesAndPledges.id),
                inArray(pledgeAllocations.entityId, entitySelected),
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
      allowedFields: ["ownerUserId", "status", "stage", "type", "wasPledge", "isConditional", "actualCompletionDate"],
      // Allocation-table reconciliation fields — not columns on
      // opportunities_and_pledges, so they go through extraApply and
      // are excluded from the column SET.
      virtualFields: ["coveredFiscalYears", "coveredFiscalYearsMode", "intendedUsage", "fundableProjectId"],
      // Donor xor is preserved (no donor fields in this patch). The
      // closed_requires_completion_date CHECK was dropped from the DB
      // schema (see opportunitiesAndPledges.ts) so won/lost no longer
      // requires actualCompletionDate. We still run the donor-xor
      // invariant against the merged post-update state.
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
      // After a successful bulk write, recompute derived fields per row
      // — bulk patches commonly flip stage or status, which can change
      // was_pledge (sticky-true) or trigger the written_commitment→cash_in
      // auto-advance once payments are in.
      afterApply: async (id) => {
        await applyDerivedOppFields(id);
      },
      // Reconcile pledge_allocations rows so the opportunity's
      // covered FYs match the requested set. Replace = wipe existing
      // allocations and recreate one minimal row per FY (DESTRUCTIVE
      // — loses subAmount/intendedUsage/etc on those rows). Append =
      // insert allocations only for FYs not already represented.
      extraApply: async (tx, id, vp) => {
        const v = vp as {
          coveredFiscalYears?: string[];
          coveredFiscalYearsMode?: string;
          intendedUsage?: NewPledgeAllocation["intendedUsage"];
          fundableProjectId?: string | null;
        };
        const fys = v.coveredFiscalYears;
        if (fys) {
          const mode = v.coveredFiscalYearsMode === "append" ? "append" : "replace";
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
        }
        // Intended usage applies to ALL of the opportunity's allocation
        // rows. Update every existing row to the chosen value; if the opp
        // has no allocation rows at all, create a single one carrying it
        // so the value is recorded. Mirrors the gifts route. The fundable
        // project link is only meaningful for usage = 'project': set it on
        // every row in that case, and clear it (null) for any other usage
        // so stale links don't linger.
        if (v.intendedUsage) {
          const fundableProjectId =
            v.intendedUsage === "project" ? (v.fundableProjectId ?? null) : null;
          const existing = await tx
            .select({ id: pledgeAllocations.id })
            .from(pledgeAllocations)
            .where(eq(pledgeAllocations.pledgeOrOpportunityId, id));
          if (existing.length > 0) {
            await tx
              .update(pledgeAllocations)
              .set({
                intendedUsage: v.intendedUsage,
                fundableProjectId,
                updatedAt: new Date(),
              })
              .where(eq(pledgeAllocations.pledgeOrOpportunityId, id));
          } else {
            await tx.insert(pledgeAllocations).values({
              id: newId(),
              pledgeOrOpportunityId: id,
              intendedUsage: v.intendedUsage,
              fundableProjectId,
            });
          }
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
    // Stamp canonical win_probability on insert when caller provided a
    // stage/status but no explicit win_probability — same rule as the
    // PATCH path. Explicit winProbability in the body always wins.
    const writeValues: typeof body & { winProbability?: string | null } = { ...body };
    if (
      (body.stage !== undefined || body.status !== undefined) &&
      body.winProbability === undefined
    ) {
      const wp = canonicalWinProbability(body.status ?? null, body.stage ?? null);
      if (wp !== null) writeValues.winProbability = wp;
    }
    const [row] = await db
      .insert(opportunitiesAndPledges)
      .values({ id: newId(), ...writeValues })
      .returning();
    if (row) await applyDerivedOppFields(row.id);
    const final = row
      ? (await db.select().from(opportunitiesAndPledges).where(eq(opportunitiesAndPledges.id, row.id)).then((r) => r[0])) ?? row
      : row;
    res.status(201).json(final);
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

    // Canonical-win-probability rule: whenever the PATCH touches stage
    // or status, re-derive win_probability from the new (status, stage)
    // pair — overwriting any past user override. If the same PATCH
    // also explicitly sets winProbability, let the explicit value win
    // (atomic override + stage change on the same edit).
    const stageOrStatusInBody =
      body.stage !== undefined || body.status !== undefined;
    const writeData: typeof body & { winProbability?: string | null } = {
      ...body,
    };
    if (stageOrStatusInBody && body.winProbability === undefined) {
      const wp = canonicalWinProbability(merged.status, merged.stage);
      if (wp !== null) writeData.winProbability = wp;
    }

    const [row] = await db
      .update(opportunitiesAndPledges)
      .set({ ...writeData, updatedAt: new Date() })
      .where(eq(opportunitiesAndPledges.id, id))
      .returning();
    if (!row) return notFound(res, "opportunity");
    // The patch may have changed stage, awardedAmount, or status — any
    // of which can flip was_pledge sticky-true, change the derived
    // status, or trigger the written_commitment→cash_in auto-advance
    // (which itself re-canonicalises win_probability inside the helper).
    await applyDerivedOppFields(id);
    const final = await db
      .select()
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, id))
      .then((r) => r[0]);

    // Reporting-deadline prompt side-channel: when this PATCH flips
    // status into a state with grant-reporting obligations (pledge or
    // cash_in) AND no reporting_deadline tasks exist yet for this
    // opp, surface a flag so the frontend can open the "set deadlines"
    // dialog. Idempotent — once the user creates the first
    // reporting_deadline task the flag goes away on subsequent
    // PATCHes.
    let promptForReportingDeadlines = false;
    const newStatus = (final ?? row).status;
    const becameReportable =
      (newStatus === "pledge" || newStatus === "cash_in") &&
      existing.status !== newStatus;
    if (becameReportable) {
      const [{ value: existingCount } = { value: 0 }] = await db
        .select({ value: count() })
        .from(tasks)
        .where(and(
          eq(tasks.kind, "reporting_deadline"),
          sql`${tasks.opportunityIds} @> ARRAY[${id}]::text[]`,
        ));
      if (Number(existingCount) === 0) promptForReportingDeadlines = true;
    }

    res.json({ ...(final ?? row), promptForReportingDeadlines });
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
