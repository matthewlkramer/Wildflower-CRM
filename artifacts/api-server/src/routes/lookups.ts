import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  fundableProjects,
  fiscalYears,
  giftAllocations,
  giftsAndPayments,
  opportunitiesAndPledges,
  pledgeAllocations,
  fundraisingCampaigns,
} from "@workspace/db/schema";
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import {
  CreateFundableProjectBody,
  UpdateFundableProjectBody,
  UpdateFiscalYearBody,
  CloseFiscalYearAuditBody,
  CreateFundraisingCampaignBody,
  UpdateFundraisingCampaignBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, notFound, paramId, parseOrBadRequest } from "../lib/helpers";
import { activeOnlyUnlessAdmin, archiveOne, requireAdmin, unarchiveOne } from "../lib/archive";
import { safeRecordAudit } from "../lib/audit";
import { getAppUser } from "../lib/appRequest";
import { unresolvedGiftAmountCondition } from "../lib/giftAmountResolution";
import { giftHasNoActiveOverpayChild } from "../lib/auditCloseResolution";

// NOTE: /entities (GET/POST/PATCH) and /fiscal-year-entity-goals routes live
// in their own files (entities.ts, fiscalYearEntityGoals.ts). This file holds
// the read-only fiscal-years lookup plus full CRUD for fundable-projects and
// fundraising-campaigns.
const router: IRouter = Router();
router.use(requireAuth);

// ── Fundraising campaigns ──────────────────────────────────────────────────
// Slug used as the PK / path param throughout (not a numeric id).
const CAMPAIGN_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

router.get(
  "/fundraising-campaigns",
  asyncHandler(async (req, res) => {
    const archivedFilter = activeOnlyUnlessAdmin(req, fundraisingCampaigns.archivedAt);
    const rows = await db
      .select()
      .from(fundraisingCampaigns)
      .where(archivedFilter)
      .orderBy(asc(fundraisingCampaigns.name));
    res.json(rows);
  }),
);

router.get(
  "/fundraising-campaigns/:slug",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const row = await db
      .select()
      .from(fundraisingCampaigns)
      .where(eq(fundraisingCampaigns.slug, String(req.params.slug)))
      .then((r) => r[0]);
    if (!row) return notFound(res, "fundraising campaign");
    res.json(row);
  }),
);

router.post(
  "/fundraising-campaigns",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(CreateFundraisingCampaignBody, req.body, res);
    if (!body) return;
    if (!CAMPAIGN_SLUG_RE.test(body.slug)) {
      res.status(400).json({
        error: "validation_error",
        message: "Campaign slug must be lowercase letters, digits, and hyphens, starting with a letter or digit.",
      });
      return;
    }
    try {
      const [row] = await db
        .insert(fundraisingCampaigns)
        .values({ ...body, emailSentAt: body.emailSentAt ? new Date(body.emailSentAt) : null })
        .returning();
      res.status(201).json(row);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "conflict", message: `Campaign '${body.slug}' already exists.` });
        return;
      }
      throw err;
    }
  }),
);

router.put(
  "/fundraising-campaigns/:slug",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(UpdateFundraisingCampaignBody, req.body, res);
    if (!body) return;
    if (Object.keys(body).length === 0) {
      res.status(400).json({ error: "validation_error", message: "Empty update body." });
      return;
    }
    const { emailSentAt: rawEmailSentAt, ...restBody } = body;
    const emailSentAtUpdate = "emailSentAt" in body
      ? { emailSentAt: rawEmailSentAt ? new Date(rawEmailSentAt) : null }
      : {};
    const [row] = await db
      .update(fundraisingCampaigns)
      .set({ ...restBody, ...emailSentAtUpdate, updatedAt: new Date() })
      .where(eq(fundraisingCampaigns.slug, String(req.params.slug)))
      .returning();
    if (!row) return notFound(res, "fundraising campaign");
    res.json(row);
  }),
);

router.post(
  "/fundraising-campaigns/:slug/archive",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const [row] = await db
      .update(fundraisingCampaigns)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(fundraisingCampaigns.slug, String(req.params.slug)))
      .returning();
    if (!row) return notFound(res, "fundraising campaign");
    res.json(row);
  }),
);

router.post(
  "/fundraising-campaigns/:slug/unarchive",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const [row] = await db
      .update(fundraisingCampaigns)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(fundraisingCampaigns.slug, String(req.params.slug)))
      .returning();
    if (!row) return notFound(res, "fundraising campaign");
    res.json(row);
  }),
);

router.get(
  "/fundable-projects",
  asyncHandler(async (req, res) => {
    const archivedFilter = activeOnlyUnlessAdmin(req, fundableProjects.archivedAt);
    const rows = await db
      .select()
      .from(fundableProjects)
      .where(archivedFilter)
      .orderBy(asc(fundableProjects.name));
    res.json(rows);
  }),
);

// Amount raised so far per fundable project — sum of gift_allocations.sub_amount
// grouped by fundable_project_id (follows the analytics line-item summation
// pattern). Projects with no allocations simply don't appear; the page treats a
// missing entry as "0 raised".
router.get(
  "/fundable-projects-progress",
  asyncHandler(async (_req, res) => {
    const rows = await db
      .select({
        fundableProjectId: fundableProjects.id,
        raised: sql<string>`COALESCE(SUM(${giftAllocations.subAmount}), 0)::text`,
      })
      .from(fundableProjects)
      .leftJoin(
        giftAllocations,
        eq(giftAllocations.fundableProjectId, fundableProjects.id),
      )
      .groupBy(fundableProjects.id)
      .orderBy(asc(fundableProjects.id));
    res.json(rows);
  }),
);

router.get(
  "/fundable-projects/:id",
  asyncHandler(async (req, res) => {
    const row = await db
      .select()
      .from(fundableProjects)
      .where(eq(fundableProjects.id, paramId(req)))
      .then((r) => r[0]);
    if (!row) return notFound(res, "fundable project");
    res.json(row);
  }),
);

// Slug-style id is user-provided (not auto-generated) — fundable projects are a
// small curated set keyed by stable slugs referenced from allocation rows via
// fundable_project_id. Validate the shape and surface a 409 on PK collision so
// the admin UI can show a clear "already exists" message.
const SLUG_RE = /^[a-z0-9][a-z0-9_]*$/;

router.post(
  "/fundable-projects",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateFundableProjectBody, req.body, res);
    if (!body) return;
    if (!SLUG_RE.test(body.id)) {
      res.status(400).json({
        error: "validation_error",
        message:
          "Fundable project id must be lowercase alphanumeric + underscore, starting with a letter or digit.",
      });
      return;
    }
    // Race-safe: rely on the PK unique constraint and map the pg unique
    // violation (SQLSTATE 23505) to a 409 instead of a 500.
    try {
      const [row] = await db.insert(fundableProjects).values(body).returning();
      res.status(201).json(row);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "conflict", message: `Fundable project '${body.id}' already exists.` });
        return;
      }
      throw err;
    }
  }),
);

router.patch(
  "/fundable-projects/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateFundableProjectBody, req.body, res);
    if (!body) return;
    if (Object.keys(body).length === 0) {
      res.status(400).json({ error: "validation_error", message: "Empty update body." });
      return;
    }
    const [row] = await db
      .update(fundableProjects)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(fundableProjects.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "fundable project");
    res.json(row);
  }),
);

router.post(
  "/fundable-projects/:id/archive",
  asyncHandler(async (req, res) => {
    await archiveOne(req, res, { entity: "fundable project", table: fundableProjects });
  }),
);

router.post(
  "/fundable-projects/:id/unarchive",
  asyncHandler(async (req, res) => {
    await unarchiveOne(req, res, { entity: "fundable project", table: fundableProjects });
  }),
);

router.get(
  "/fiscal-years",
  asyncHandler(async (req, res) => {
    const archivedFilter = activeOnlyUnlessAdmin(req, fiscalYears.archivedAt);
    const rows = await db
      .select()
      .from(fiscalYears)
      .where(archivedFilter)
      .orderBy(asc(fiscalYears.id));
    res.json(rows);
  }),
);

router.get(
  "/fiscal-years/:id",
  asyncHandler(async (req, res) => {
    const row = await db
      .select()
      .from(fiscalYears)
      .where(eq(fiscalYears.id, paramId(req)))
      .then((r) => r[0]);
    if (!row) return notFound(res, "fiscal year");
    res.json(row);
  }),
);

// Minimal PATCH for inline editing of simple scalar fields only (e.g. goal).
router.patch(
  "/fiscal-years/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateFiscalYearBody, req.body, res);
    if (!body) return;
    if (Object.keys(body).length === 0) {
      res.status(400).json({ error: "validation_error", message: "Empty update body." });
      return;
    }
    const [row] = await db
      .update(fiscalYears)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(fiscalYears.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "fiscal year");
    res.json(row);
  }),
);

router.post(
  "/fiscal-years/:id/archive",
  asyncHandler(async (req, res) => {
    await archiveOne(req, res, { entity: "fiscal year", table: fiscalYears });
  }),
);

router.post(
  "/fiscal-years/:id/unarchive",
  asyncHandler(async (req, res) => {
    await unarchiveOne(req, res, { entity: "fiscal year", table: fiscalYears });
  }),
);

// ─── Fiscal-year audit close / reopen ──────────────────────────────────────
// Closing a FY's external audit is the "freeze" trigger: once `auditClosedAt`
// is set, every gift/pledge governed by this FY becomes immutable and later
// corrections must be booked as NEW records in the current open FY. Admin-only;
// reopen is a safety valve. See lib/governingFiscalYear.ts for the governing-FY
// rule and the pre-close checklist below for what freezes.
router.post(
  "/fiscal-years/:id/close",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(CloseFiscalYearAuditBody, req.body ?? {}, res);
    if (!body) return;
    const closedAt = body.auditClosedAt ? new Date(body.auditClosedAt) : new Date();
    const [row] = await db
      .update(fiscalYears)
      .set({
        auditClosedAt: closedAt,
        auditClosedByUserId: getAppUser(req)?.id ?? null,
        updatedAt: new Date(),
      })
      .where(eq(fiscalYears.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "fiscal year");
    await safeRecordAudit(req, {
      action: "update",
      entityType: "fiscal_year",
      entityId: row.id,
      summary: `Closed audit for fiscal year ${row.label}`,
      metadata: { auditClosed: true, auditClosedAt: closedAt.toISOString() },
    });
    res.json(row);
  }),
);

router.post(
  "/fiscal-years/:id/reopen",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const [row] = await db
      .update(fiscalYears)
      .set({ auditClosedAt: null, auditClosedByUserId: null, updatedAt: new Date() })
      .where(eq(fiscalYears.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "fiscal year");
    await safeRecordAudit(req, {
      action: "update",
      entityType: "fiscal_year",
      entityId: row.id,
      summary: `Reopened audit for fiscal year ${row.label}`,
      metadata: { auditClosed: false },
    });
    res.json(row);
  }),
);

// Read-only advisory shown before an admin closes a FY: what freezes, and what
// is still unresolved. Any authenticated user may view it.
router.get(
  "/fiscal-years/:id/pre-close-checklist",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const [fy] = await db.select().from(fiscalYears).where(eq(fiscalYears.id, id));
    if (!fy) return notFound(res, "fiscal year");

    // A gift is governed by this FY when its date_received falls in the FY
    // window. Without a start/end date the window is undefined → govern nothing.
    const hasRange = !!fy.startDate && !!fy.endDate;
    const giftGoverned = hasRange
      ? and(
          isNull(giftsAndPayments.archivedAt),
          isNotNull(giftsAndPayments.dateReceived),
          gte(giftsAndPayments.dateReceived, fy.startDate as string),
          lte(giftsAndPayments.dateReceived, fy.endDate as string),
        )
      : sql`false`;
    // Unresolved = governed AND amount doesn't tie to accounting. The predicate
    // lives in one place (giftAmountResolution.ts) so P3/P6 can swap the
    // definition without touching this route. Off-books gifts are 'exempt' and
    // excluded naturally.
    // A gift already resolved via a post-close surplus gift (an active
    // overpay_of_gift_id child) is no longer unresolved — the audited original
    // stays amount_mismatch forever, so exclude it here or it flags on every
    // future re-close.
    // Symmetrically, the surplus child gift itself has no counted evidence, so
    // it is stamped quickbooks_tie_status='missing'. It is the RESOLUTION, not a
    // new problem: exclude overpay children (its own surplus is <=0 so it has no
    // resolution path and would flag forever in the FY it was booked into).
    const giftUnresolved = and(
      giftGoverned,
      unresolvedGiftAmountCondition(),
      giftHasNoActiveOverpayChild(),
      isNull(giftsAndPayments.overpayOfGiftId),
    );

    const [{ n: giftsGoverned }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(giftsAndPayments)
      .where(giftGoverned);
    const [{ n: giftsUnresolved }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(giftsAndPayments)
      .where(giftUnresolved);
    const sampleGifts = hasRange
      ? await db
          .select({
            id: giftsAndPayments.id,
            amount: giftsAndPayments.amount,
            dateReceived: giftsAndPayments.dateReceived,
            quickbooksTieStatus: giftsAndPayments.quickbooksTieStatus,
          })
          .from(giftsAndPayments)
          .where(giftUnresolved)
          .orderBy(desc(giftsAndPayments.dateReceived))
          .limit(25)
      : [];

    // Underpaid written pledges MADE in this FY (capacity > 0). A pledge is
    // governed by the year it was made — its actual_completion_date's FY — NOT by
    // its allocation grant years (confirmed with finance). Pledges with no
    // completion date are null-governed (never freeze) and excluded. Raw SQL keeps
    // the GROUP BY / HAVING explicit and avoids the drizzle bare-column footgun.
    // `paid` is the persisted linked-gift rollup.
    //
    // "Resolved" is CAPACITY-based, mirroring computePledgeUncollectedRemainder:
    // committed + active write-off children's (NEGATIVE) allocation totals must
    // exceed paid to flag. A partially written-off pledge with real remaining
    // uncollected money keeps flagging on a re-close; a fully written-off pledge
    // excludes itself naturally. The write-off child rows themselves are skipped
    // (is_write_off = false) — they are the resolution, not a new problem.
    const pledgeRows = hasRange
      ? ((
          await db.execute(sql`
            SELECT o.id AS id,
                   COALESCE(SUM(pa.sub_amount), 0)::text AS expected,
                   COALESCE(o.paid, 0)::text AS paid,
                   COALESCE((
                     SELECT SUM(cpa.sub_amount)
                     FROM ${pledgeAllocations} cpa
                     JOIN ${opportunitiesAndPledges} c
                       ON cpa.pledge_or_opportunity_id = c.id
                     WHERE c.write_off_of_pledge_id = o.id
                       AND c.archived_at IS NULL
                   ), 0)::text AS written_off
            FROM ${opportunitiesAndPledges} o
            JOIN ${pledgeAllocations} pa ON pa.pledge_or_opportunity_id = o.id
            WHERE o.written_pledge = true
              AND o.archived_at IS NULL
              AND o.actual_completion_date IS NOT NULL
              AND o.actual_completion_date >= ${fy.startDate}
              AND o.actual_completion_date <= ${fy.endDate}
              AND o.is_write_off = false
            GROUP BY o.id, o.paid
            HAVING COALESCE(SUM(pa.sub_amount), 0)
                 + COALESCE((
                     SELECT SUM(cpa.sub_amount)
                     FROM ${pledgeAllocations} cpa
                     JOIN ${opportunitiesAndPledges} c
                       ON cpa.pledge_or_opportunity_id = c.id
                     WHERE c.write_off_of_pledge_id = o.id
                       AND c.archived_at IS NULL
                   ), 0)
                 > COALESCE(o.paid, 0)
            ORDER BY (COALESCE(SUM(pa.sub_amount), 0)
                    + COALESCE((
                        SELECT SUM(cpa.sub_amount)
                        FROM ${pledgeAllocations} cpa
                        JOIN ${opportunitiesAndPledges} c
                          ON cpa.pledge_or_opportunity_id = c.id
                        WHERE c.write_off_of_pledge_id = o.id
                          AND c.archived_at IS NULL
                      ), 0)
                    - COALESCE(o.paid, 0)) DESC
          `)
        ).rows as unknown as {
          id: string;
          expected: string;
          paid: string;
          written_off: string;
        }[])
      : [];
    const pledges = pledgeRows.map((r) => ({
      id: r.id,
      expectedAmount: r.expected,
      paidAmount: r.paid,
      // NET remainder — the same figure the write-off dialog prefills and caps at.
      remainder: Math.max(
        0,
        Number(r.expected) + Number(r.written_off) - Number(r.paid),
      ).toFixed(2),
    }));

    res.json({
      fiscalYearId: fy.id,
      label: fy.label,
      startDate: fy.startDate,
      endDate: fy.endDate,
      auditClosedAt: fy.auditClosedAt,
      giftsGoverned,
      giftsUnresolved,
      pledgesUnderpaid: pledges.length,
      sampleGifts,
      samplePledges: pledges.slice(0, 25),
    });
  }),
);

export default router;
