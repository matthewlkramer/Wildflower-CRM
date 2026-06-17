import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  grantLeads,
  grantLeadSightings,
  organizations,
  opportunitiesAndPledges,
  users,
} from "@workspace/db/schema";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  AssignGrantLeadBody,
  ConvertGrantLeadBody,
  ListGrantLeadsQueryParams,
  SplitGrantLeadBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parseOrBadRequest,
  parsePagination,
} from "../lib/helpers";
import { applyDerivedOppFields } from "../lib/pledgeStage";

const router: IRouter = Router();
router.use(requireAuth);

// ── Helpers ───────────────────────────────────────────────────────────────────

function grantLeadRow(row: typeof grantLeads.$inferSelect & {
  targetOrganizationName?: string | null;
  assigneeUserName?: string | null;
  sightingCount?: number;
  sightingUserIds?: string[];
}) {
  return {
    id: row.id,
    dedupeKey: row.dedupeKey,
    status: row.status,
    title: row.title,
    funderName: row.funderName ?? null,
    targetOrganizationId: row.targetOrganizationId ?? null,
    targetOrganizationName: row.targetOrganizationName ?? null,
    deadline: row.deadline ?? null,
    amount: row.amount ?? null,
    url: row.url ?? null,
    snippet: row.snippet ?? null,
    assigneeUserId: row.assigneeUserId ?? null,
    assigneeUserName: row.assigneeUserName ?? null,
    claimedAt: row.claimedAt?.toISOString() ?? null,
    convertedAt: row.convertedAt?.toISOString() ?? null,
    convertedByUserId: row.convertedByUserId ?? null,
    convertedOpportunityId: row.convertedOpportunityId ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    archivedByUserId: row.archivedByUserId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sightingCount: row.sightingCount ?? 0,
    sightingUserIds: row.sightingUserIds ?? [],
  };
}

async function enrichLeads(rows: (typeof grantLeads.$inferSelect)[]) {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const orgIds = [...new Set(rows.map((r) => r.targetOrganizationId).filter(Boolean) as string[])];
  const userIds = [...new Set([
    ...rows.map((r) => r.assigneeUserId).filter(Boolean) as string[],
  ])];

  const [orgRows, userRows, sightingAgg] = await Promise.all([
    orgIds.length > 0
      ? db.select({ id: organizations.id, name: organizations.name })
          .from(organizations)
          .where(inArray(organizations.id, orgIds))
      : [],
    userIds.length > 0
      ? db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(inArray(users.id, userIds))
      : [],
    db
      .select({
        grantLeadId: grantLeadSightings.grantLeadId,
        sightingCount: count(),
        sightingUserIds: sql<string[]>`array_agg(DISTINCT ${grantLeadSightings.mailboxUserId})`,
      })
      .from(grantLeadSightings)
      .where(inArray(grantLeadSightings.grantLeadId, ids))
      .groupBy(grantLeadSightings.grantLeadId),
  ]);

  const orgMap = new Map(orgRows.map((o) => [o.id, o.name]));
  const userMap = new Map(userRows.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(" ")]));
  const sightingMap = new Map(sightingAgg.map((s) => [s.grantLeadId, s]));

  return rows.map((row) => {
    const s = sightingMap.get(row.id);
    return grantLeadRow({
      ...row,
      targetOrganizationName: row.targetOrganizationId ? (orgMap.get(row.targetOrganizationId) ?? null) : null,
      assigneeUserName: row.assigneeUserId ? (userMap.get(row.assigneeUserId) ?? null) : null,
      sightingCount: s ? Number(s.sightingCount) : 0,
      sightingUserIds: s?.sightingUserIds ?? [],
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get(
  "/grant-leads",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListGrantLeadsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);

    const filters: SQL[] = [];

    if (q.status) {
      filters.push(eq(grantLeads.status, q.status as "new" | "claimed" | "converted" | "archived"));
    } else if (!q.includeArchived) {
      // Default: only show active leads
      filters.push(inArray(grantLeads.status, ["new", "claimed"]));
    }

    if (q.assigneeUserId) filters.push(eq(grantLeads.assigneeUserId, q.assigneeUserId));

    if (q.search) {
      const term = `%${q.search}%`;
      const clause = or(ilike(grantLeads.title, term), ilike(grantLeads.funderName, term));
      if (clause) filters.push(clause);
    }

    const where = filters.length ? and(...filters) : undefined;

    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(grantLeads).where(where).orderBy(desc(grantLeads.createdAt)).limit(limit).offset(offset),
      db.select({ value: count() }).from(grantLeads).where(where),
    ]);

    const enriched = await enrichLeads(rows);
    res.json({ data: enriched, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/grant-leads/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const row = await db.select().from(grantLeads).where(eq(grantLeads.id, id)).then((r) => r[0]);
    if (!row) return notFound(res, "grant lead");

    const [enriched] = await enrichLeads([row]);
    if (!enriched) return notFound(res, "grant lead");

    // Fetch full sightings with mailbox user names
    const sightings = await db
      .select({
        id: grantLeadSightings.id,
        grantLeadId: grantLeadSightings.grantLeadId,
        mailboxUserId: grantLeadSightings.mailboxUserId,
        gmailMessageId: grantLeadSightings.gmailMessageId,
        emailMessageId: grantLeadSightings.emailMessageId,
        emailSentAt: grantLeadSightings.emailSentAt,
        createdAt: grantLeadSightings.createdAt,
        mailboxUserName: sql<string | null>`(SELECT concat_ws(' ', first_name, last_name) FROM users WHERE id = ${grantLeadSightings.mailboxUserId})`,
      })
      .from(grantLeadSightings)
      .where(eq(grantLeadSightings.grantLeadId, id))
      .orderBy(desc(grantLeadSightings.createdAt));

    res.json({
      ...enriched,
      sightings: sightings.map((s) => ({
        id: s.id,
        grantLeadId: s.grantLeadId,
        mailboxUserId: s.mailboxUserId,
        mailboxUserName: s.mailboxUserName,
        gmailMessageId: s.gmailMessageId,
        emailMessageId: s.emailMessageId,
        emailSentAt: s.emailSentAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
      })),
    });
  }),
);

router.post(
  "/grant-leads/:id/claim",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const user = getAppUser(req);
    if (!user) { res.status(401).json({ error: "unauthorized" }); return; }

    const existing = await db.select().from(grantLeads).where(eq(grantLeads.id, id)).then((r) => r[0]);
    if (!existing) return notFound(res, "grant lead");
    if (existing.status === "archived" || existing.status === "converted") {
      res.status(409).json({ error: "Lead already converted or archived" });
      return;
    }

    const [updated] = await db
      .update(grantLeads)
      .set({
        status: "claimed",
        assigneeUserId: user.id,
        claimedAt: existing.claimedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(grantLeads.id, id))
      .returning();

    const [enriched] = await enrichLeads([updated!]);
    res.json(enriched);
  }),
);

router.post(
  "/grant-leads/:id/assign",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const body = parseOrBadRequest(AssignGrantLeadBody, req.body, res);
    if (!body) return;

    const existing = await db.select().from(grantLeads).where(eq(grantLeads.id, id)).then((r) => r[0]);
    if (!existing) return notFound(res, "grant lead");
    if (existing.status === "archived" || existing.status === "converted") {
      res.status(409).json({ error: "Lead already converted or archived" });
      return;
    }

    const now = new Date();
    const newStatus = body.assigneeUserId && existing.status === "new" ? "claimed" : existing.status;
    const claimedAt = newStatus === "claimed" && !existing.claimedAt ? now : existing.claimedAt;

    const [updated] = await db
      .update(grantLeads)
      .set({
        assigneeUserId: body.assigneeUserId ?? null,
        status: newStatus,
        claimedAt,
        updatedAt: now,
      })
      .where(eq(grantLeads.id, id))
      .returning();

    const [enriched] = await enrichLeads([updated!]);
    res.json(enriched);
  }),
);

router.post(
  "/grant-leads/:id/archive",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const user = getAppUser(req);
    if (!user) { res.status(401).json({ error: "unauthorized" }); return; }

    const existing = await db.select().from(grantLeads).where(eq(grantLeads.id, id)).then((r) => r[0]);
    if (!existing) return notFound(res, "grant lead");
    if (existing.status === "archived" || existing.status === "converted") {
      res.status(409).json({ error: "Lead already converted or archived" });
      return;
    }

    const [updated] = await db
      .update(grantLeads)
      .set({
        status: "archived",
        archivedAt: new Date(),
        archivedByUserId: user.id,
        updatedAt: new Date(),
      })
      .where(eq(grantLeads.id, id))
      .returning();

    const [enriched] = await enrichLeads([updated!]);
    res.json(enriched);
  }),
);

router.post(
  "/grant-leads/:id/split",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const body = parseOrBadRequest(SplitGrantLeadBody, req.body, res);
    if (!body) return;

    const existing = await db.select().from(grantLeads).where(eq(grantLeads.id, id)).then((r) => r[0]);
    if (!existing) return notFound(res, "grant lead");
    if (existing.status === "archived" || existing.status === "converted") {
      res.status(409).json({ error: "Lead already converted or archived" });
      return;
    }

    const newLeadId = newId();
    const now = new Date();

    // Clone sightings to the new lead
    const sourceSightings = await db
      .select()
      .from(grantLeadSightings)
      .where(eq(grantLeadSightings.grantLeadId, id));

    const [splitOff] = await db
      .insert(grantLeads)
      .values({
        id: newLeadId,
        dedupeKey: `split:${newLeadId}`,
        status: "new",
        title: body.newTitle,
        funderName: body.newFunderName ?? existing.funderName,
        targetOrganizationId: existing.targetOrganizationId,
        deadline: existing.deadline,
        amount: existing.amount,
        url: existing.url,
        snippet: existing.snippet,
        payload: existing.payload,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (sourceSightings.length > 0) {
      await db.insert(grantLeadSightings).values(
        sourceSightings.map((s) => ({
          id: newId(),
          grantLeadId: newLeadId,
          mailboxUserId: s.mailboxUserId,
          gmailMessageId: s.gmailMessageId,
          emailMessageId: s.emailMessageId,
          emailSentAt: s.emailSentAt,
          createdAt: now,
        })),
      ).onConflictDoNothing();
    }

    // Reload original with enrichment
    const original = await db.select().from(grantLeads).where(eq(grantLeads.id, id)).then((r) => r[0]);
    const [enrichedOriginal] = await enrichLeads([original!]);

    // Build detail for split-off
    const [enrichedSplitOff] = await enrichLeads([splitOff!]);
    const clonedSightings = await db
      .select()
      .from(grantLeadSightings)
      .where(eq(grantLeadSightings.grantLeadId, newLeadId));

    res.json({
      original: enrichedOriginal,
      splitOff: {
        ...enrichedSplitOff,
        sightings: clonedSightings.map((s) => ({
          id: s.id,
          grantLeadId: s.grantLeadId,
          mailboxUserId: s.mailboxUserId,
          mailboxUserName: null,
          gmailMessageId: s.gmailMessageId,
          emailMessageId: s.emailMessageId,
          emailSentAt: s.emailSentAt?.toISOString() ?? null,
          createdAt: s.createdAt.toISOString(),
        })),
      },
    });
  }),
);

router.post(
  "/grant-leads/:id/convert",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const user = getAppUser(req);
    if (!user) { res.status(401).json({ error: "unauthorized" }); return; }
    const body = parseOrBadRequest(ConvertGrantLeadBody, req.body, res);
    if (!body) return;

    const existing = await db.select().from(grantLeads).where(eq(grantLeads.id, id)).then((r) => r[0]);
    if (!existing) return notFound(res, "grant lead");
    if (existing.status === "archived" || existing.status === "converted") {
      res.status(409).json({ error: "Lead already converted or archived" });
      return;
    }

    // Donor XOR validation
    const donorFields = [body.organizationId, body.individualGiverPersonId, body.householdId].filter(Boolean);
    if (donorFields.length !== 1) {
      res.status(400).json({ error: "Exactly one of organizationId, individualGiverPersonId, or householdId is required" });
      return;
    }

    const oppId = newId();
    const now = new Date();

    const [opp] = await db
      .insert(opportunitiesAndPledges)
      .values({
        id: oppId,
        name: body.name ?? existing.title,
        stage: "cold_lead",
        type: "open_application",
        organizationId: body.organizationId ?? null,
        individualGiverPersonId: body.individualGiverPersonId ?? null,
        householdId: body.householdId ?? null,
        ownerUserId: body.ownerUserId ?? user.id,
        askAmount: body.askAmount ?? null,
        applicationDeadline: body.applicationDeadline ?? null,
      })
      .returning();

    if (opp) {
      await applyDerivedOppFields(opp.id);
    }

    const [updatedLead] = await db
      .update(grantLeads)
      .set({
        status: "converted",
        convertedAt: now,
        convertedByUserId: user.id,
        convertedOpportunityId: oppId,
        updatedAt: now,
      })
      .where(eq(grantLeads.id, id))
      .returning();

    const [enrichedLead] = await enrichLeads([updatedLead!]);
    res.status(201).json({ grantLead: enrichedLead, opportunity: opp });
  }),
);

export default router;
