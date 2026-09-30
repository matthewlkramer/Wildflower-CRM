import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  conferenceAttendance,
  conferenceEvents,
  conferenceResearchRequests,
  conferenceSpeakerProposals,
  conferenceTypes,
  organizations,
  people,
  peopleEntityRoles,
} from "@workspace/db/schema";
import {
  BulkAddConferenceSpeakerProposalsBody,
  BulkAddConferenceSpeakerProposalsParams,
  BulkIgnoreConferenceSpeakerProposalsBody,
  BulkIgnoreConferenceSpeakerProposalsParams,
  ConfirmConferenceEventDatesBody,
  ConfirmConferenceEventDatesParams,
  CreateConferenceResearchRequestBody,
  CreateConferenceResearchRequestParams,
  EnqueueConferenceResearchBackfillBody,
  ListConferenceResearchRequestsParams,
  ListConferenceSpeakerProposalsParams,
  ListConferenceSpeakerProposalsQueryParams,
  ReopenConferenceSpeakerProposalParams,
  RetryConferenceResearchRequestParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { requireAdmin } from "../lib/archive";
import { recordAudit } from "../lib/audit";
import { asyncHandler, newId, notFound, parseOrBadRequest } from "../lib/helpers";
import { normalizeIdentity, findConferenceSpeakerMatch } from "../lib/conferenceSpeakerMatching";
import {
  enqueueConferenceResearch,
  enqueueConferenceResearchBackfill,
  retryConferenceResearchRequest,
} from "../lib/conferenceResearchWorker";

const router: IRouter = Router();
router.use(requireAuth);

function canWrite(req: Request, res: Response): string | null {
  const user = getAppUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (user.role === "read_only") {
    res.status(403).json({ error: "write_permission_required" });
    return null;
  }
  return user.id;
}

function hasUniqueSelection(ids: string[]): boolean {
  return ids.length > 0 && new Set(ids).size === ids.length;
}

async function proposalResponseRows(rows: (typeof conferenceSpeakerProposals.$inferSelect)[]) {
  const ids = [...new Set(rows.flatMap((row) => row.candidatePersonIds))];
  const candidates = ids.length
    ? await db.select({
        personId: people.id,
        name: sql<string>`coalesce(${people.fullName}, trim(concat_ws(' ', ${people.firstName}, ${people.lastName})))`,
        organizationId: organizations.id,
        organizationName: organizations.name,
      }).from(people)
        .leftJoin(peopleEntityRoles, and(
          eq(peopleEntityRoles.personId, people.id),
          eq(peopleEntityRoles.entityType, "organization"),
          eq(peopleEntityRoles.current, "current"),
        ))
        .leftJoin(organizations, eq(organizations.id, peopleEntityRoles.organizationId))
        .where(inArray(people.id, ids))
    : [];
  const byId = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const list = byId.get(candidate.personId) ?? [];
    list.push(candidate);
    byId.set(candidate.personId, list);
  }
  return rows.map((row) => ({
    ...row,
    matchCandidates: row.candidatePersonIds.flatMap((personId) => {
      const candidate = byId.get(personId)?.[0];
      return candidate ? [{ ...candidate, matchEvidence: null }] : [];
    }),
  }));
}

router.get("/conference-events/:id/research-requests", asyncHandler(async (req, res) => {
  const params = parseOrBadRequest(ListConferenceResearchRequestsParams, req.params, res);
  if (!params) return;
  const rows = await db.select().from(conferenceResearchRequests)
    .where(eq(conferenceResearchRequests.conferenceEventId, params.id))
    .orderBy(asc(conferenceResearchRequests.createdAt));
  res.json(rows);
}));

// Mounted before conferencesRouter to replace its former draft-only endpoint.
router.post("/conference-events/:id/research-requests", asyncHandler(async (req, res) => {
  const userId = canWrite(req, res);
  if (!userId) return;
  const params = parseOrBadRequest(CreateConferenceResearchRequestParams, req.params, res);
  const body = parseOrBadRequest(CreateConferenceResearchRequestBody, req.body, res);
  if (!params || !body) return;
  const [event] = await db.select({
    event: conferenceEvents,
    officialUrl: conferenceTypes.websiteUrl,
  }).from(conferenceEvents)
    .innerJoin(conferenceTypes, eq(conferenceTypes.id, conferenceEvents.conferenceTypeId))
    .where(eq(conferenceEvents.id, params.id));
  if (!event) return notFound(res, "conference event");
  if (body.kind === "agenda_speakers" && !event.event.startDate) {
    res.status(409).json({
      error: "dates_not_confirmed",
      message: "Confirm conference dates before researching its agenda and speakers.",
    });
    return;
  }
  const [type] = await db.select({ displayName: conferenceTypes.displayName }).from(conferenceTypes)
    .where(eq(conferenceTypes.id, event.event.conferenceTypeId));
  const windowKey = body.windowKey?.trim() || `manual:${new Date().toISOString().slice(0, 10)}`;
  const request = await enqueueConferenceResearch(
    params.id,
    body.kind,
    windowKey,
    userId,
    {
      attendeeSiteUrl: body.attendeeSiteUrl ?? event.event.attendeeSiteUrl ?? event.officialUrl,
      instructions: body.instructions ?? null,
    },
  );
  await recordAudit(db, req, {
    action: "create",
    entityType: "conference_research_request",
    entityId: request.id,
    summary: `Queued ${body.kind === "dates" ? "date" : "agenda and speaker"} research for ${type?.displayName ?? "conference"}`,
    metadata: { conferenceEventId: params.id, kind: body.kind, windowKey },
  });
  res.status(201).json(request);
}));

router.post("/conference-research-requests/:id/retry", asyncHandler(async (req, res) => {
  const params = parseOrBadRequest(RetryConferenceResearchRequestParams, req.params, res);
  if (!params) return;
  const request = await retryConferenceResearchRequest(params.id);
  if (!request) {
    const [existing] = await db.select().from(conferenceResearchRequests)
      .where(eq(conferenceResearchRequests.id, params.id));
    if (!existing) return notFound(res, "conference research request");
    res.status(409).json({
      error: "not_retryable",
      message: "Only a failed conference research request can be retried.",
    });
    return;
  }
  await recordAudit(db, req, {
    action: "update",
    entityType: "conference_research_request",
    entityId: request.id,
    summary: "Re-queued failed conference research",
  });
  res.status(202).json(request);
}));

router.post("/conference-events/:id/confirm-dates", asyncHandler(async (req, res) => {
  const userId = canWrite(req, res);
  if (!userId) return;
  const params = parseOrBadRequest(ConfirmConferenceEventDatesParams, req.params, res);
  const body = parseOrBadRequest(ConfirmConferenceEventDatesBody, req.body, res);
  if (!params || !body) return;
   if (body.confirmed !== true || !body.researchRequestId || (body.endDate && body.endDate < body.startDate)) {
    res.status(400).json({ error: "invalid_dates", message: "Confirm a valid date range before saving." });
    return;
  }
  const outcome = await db.transaction(async (tx) => {
    const [event] = await tx.select().from(conferenceEvents)
      .where(eq(conferenceEvents.id, params.id)).for("update");
    if (!event) return { kind: "missing" as const };
    if (body.expectedUpdatedAt && event.updatedAt.toISOString() !== new Date(body.expectedUpdatedAt).toISOString()) {
      return { kind: "stale" as const };
    }
    let researchedAt: Date | null = null;
     if (body.researchRequestId) {
      const [research] = await tx.select().from(conferenceResearchRequests).where(and(
        eq(conferenceResearchRequests.id, body.researchRequestId),
        eq(conferenceResearchRequests.conferenceEventId, params.id),
        eq(conferenceResearchRequests.kind, "dates"),
        eq(conferenceResearchRequests.status, "completed"),
      ));
      const evidenceHasSource = research?.sources.some((source) =>
        !!source && typeof source === "object" && "url" in source && source.url === body.dateSourceUrl,
      );
      const evidenceSupportsDates = research?.evidence.some((evidence) => {
        if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
        const record = evidence as Record<string, unknown>;
        return (record.kind === undefined || record.kind === "dates") &&
          record.sourceUrl === body.dateSourceUrl &&
          (record.startDate === undefined || record.startDate === body.startDate) &&
          (record.endDate === undefined || (record.endDate ?? null) === (body.endDate ?? null));
      });
      if (
        !research ||
        research.proposedStartDate !== body.startDate ||
        (research.proposedEndDate ?? null) !== (body.endDate ?? null) ||
         research.proposedDateConfidence !== body.dateConfidence ||
        !evidenceHasSource ||
        !evidenceSupportsDates
      ) {
        return { kind: "invalid_research" as const };
      }
      researchedAt = research.completedAt;
    }
    const [updated] = await tx.update(conferenceEvents).set({
      startDate: body.startDate,
      endDate: body.endDate ?? null,
      dateSourceUrl: body.dateSourceUrl,
      dateEvidence: body.dateEvidence,
      dateConfidence: body.dateConfidence,
      dateResearchedAt: researchedAt,
      dateReviewedByUserId: userId,
      dateReviewedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(conferenceEvents.id, params.id)).returning();
    await recordAudit(tx, req, {
      action: "conference_attendance_reviewed",
      entityType: "conference_event",
      entityId: params.id,
      summary: "Confirmed conference event dates",
      metadata: { startDate: body.startDate, endDate: body.endDate ?? null, researchRequestId: body.researchRequestId ?? null },
    });
    return { kind: "saved" as const, event: updated };
  });
  if (outcome.kind === "missing") return notFound(res, "conference event");
  if (outcome.kind === "stale") {
    res.status(409).json({ error: "stale_event", message: "Conference event changed since these dates were reviewed." });
    return;
  }
  if (outcome.kind === "invalid_research") {
    res.status(400).json({ error: "invalid_research_proposal", message: "The selected completed date-research request does not support the dates and source URL." });
    return;
  }
   // Confirmed dates unlock the first agenda run, including historical backfills.
   await enqueueConferenceResearch(params.id, "agenda_speakers", `dates_confirmed:${body.startDate}`, userId);
   res.json({ ...outcome.event, datesUnknown: false });
}));

router.get("/conference-events/:id/speaker-proposals", asyncHandler(async (req, res) => {
  const params = parseOrBadRequest(ListConferenceSpeakerProposalsParams, req.params, res);
  const query = parseOrBadRequest(ListConferenceSpeakerProposalsQueryParams, req.query, res);
  if (!params || !query) return;
  const rows = await db.select().from(conferenceSpeakerProposals).where(and(
    eq(conferenceSpeakerProposals.conferenceEventId, params.id),
    query.status ? eq(conferenceSpeakerProposals.status, query.status) : undefined,
  )).orderBy(asc(conferenceSpeakerProposals.createdAt));
  res.json(await proposalResponseRows(rows));
}));

async function findOrganizationForSpeaker(name: string | null) {
  if (!name?.trim()) return null;
  const candidateName = normalizeIdentity(name);
  const rows = await db.select({ id: organizations.id, name: organizations.name })
    .from(organizations).where(isNull(organizations.archivedAt));
  const exact = rows.filter((row) => normalizeIdentity(row.name) === candidateName);
  return exact.length === 1 ? exact[0] : null;
}

router.post("/conference-events/:id/speaker-proposals/bulk-add", asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const userId = getAppUser(req)!.id;
  const params = parseOrBadRequest(BulkAddConferenceSpeakerProposalsParams, req.params, res);
  const body = parseOrBadRequest(BulkAddConferenceSpeakerProposalsBody, req.body, res);
  if (!params || !body) return;
  if (!hasUniqueSelection(body.proposalIds)) {
    res.status(400).json({ error: "invalid_selection", message: "Select one or more unique speaker proposals." });
    return;
  }
  const selections = new Map((body.personSelections ?? []).map((item) => [item.proposalId, item.personId]));
  if (selections.size !== (body.personSelections?.length ?? 0) ||
    [...selections.keys()].some((id) => !body.proposalIds.includes(id))) {
    res.status(400).json({ error: "invalid_selection", message: "Each person choice must belong to one selected proposal." });
    return;
  }
  const results: (typeof conferenceSpeakerProposals.$inferSelect)[] = [];
  let succeededCount = 0;
  let conflictCount = 0;
  for (const proposalId of body.proposalIds) {
    const result = await db.transaction(async (tx) => {
      const [proposal] = await tx.select().from(conferenceSpeakerProposals)
        .where(and(eq(conferenceSpeakerProposals.id, proposalId), eq(conferenceSpeakerProposals.conferenceEventId, params.id)))
        .for("update");
      if (!proposal) return { kind: "missing" as const };
      if (proposal.status === "added") return { kind: "success" as const, proposal };
      if (proposal.status !== "pending") return { kind: "conflict" as const };

       const reviewerChoice = selections.get(proposal.id);
       if (proposal.candidatePersonIds.length &&
         (!reviewerChoice || !proposal.candidatePersonIds.includes(reviewerChoice))) {
         return { kind: "conflict" as const };
       }
       if (reviewerChoice && !proposal.candidatePersonIds.includes(reviewerChoice)) {
         return { kind: "conflict" as const };
       }
       let personId = reviewerChoice ?? proposal.matchedPersonId;
      if (!personId) {
        const refreshedMatch = await findConferenceSpeakerMatch({
          name: proposal.name,
          organizationName: proposal.organizationName,
        });
        if (refreshedMatch.matchedPersonId || refreshedMatch.candidates.length) {
          return { kind: "conflict" as const };
        }
        const nameParts = proposal.name.trim().split(/\s+/);
        const firstName = nameParts.shift() ?? proposal.name;
        const lastName = nameParts.join(" ") || null;
        personId = newId();
        await tx.insert(people).values({
          id: personId,
          firstName,
          lastName,
          fullName: proposal.name,
          ownerUserId: userId,
          details: `Added from reviewed public conference speaker research. Source: ${proposal.sourceUrl ?? "not provided"}. Evidence: ${proposal.sessionEvidence ?? ""}`.slice(0, 4_000),
        });
      }

      const [person] = await tx.select().from(people).where(and(eq(people.id, personId), isNull(people.archivedAt)));
      if (!person) return { kind: "conflict" as const };
       const organization = await findOrganizationForSpeaker(proposal.organizationName);
       if (organization && !reviewerChoice && !proposal.matchedPersonId && proposal.candidatePersonIds.length === 0) {
        await tx.insert(peopleEntityRoles).values({
          id: newId(),
          personId,
          entityType: "organization",
          organizationId: organization.id,
          externalTitleOrRole: proposal.title,
          notes: "Conference speaker organization from reviewed public evidence.",
        }).onConflictDoNothing();
      }
      await tx.insert(conferenceAttendance).values({
        id: newId(),
        conferenceEventId: params.id,
        personId,
        status: "confirmed",
        role: "Speaker",
        sourceType: "agenda_speaker",
        sourceReference: proposal.sourceUrl,
        evidenceNote: proposal.sessionEvidence,
        organizationSnapshot: proposal.organizationName,
        reviewedByUserId: userId,
        reviewedAt: new Date(),
      }).onConflictDoUpdate({
        target: [conferenceAttendance.conferenceEventId, conferenceAttendance.personId],
        set: {
          status: "confirmed",
          role: "Speaker",
          evidenceNote: sql`concat_ws(E'\n\n', nullif(${conferenceAttendance.evidenceNote}, ''), ${proposal.sessionEvidence ?? ""})`,
          organizationSnapshot: sql`coalesce(${conferenceAttendance.organizationSnapshot}, ${proposal.organizationName})`,
          reviewedByUserId: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      const [updated] = await tx.update(conferenceSpeakerProposals).set({
        status: "added",
        addedPersonId: personId,
        matchedPersonId: proposal.matchedPersonId ?? personId,
        matchedOrganizationId: organization?.id ?? proposal.matchedOrganizationId,
        reviewedByUserId: userId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(conferenceSpeakerProposals.id, proposal.id)).returning();
      await recordAudit(tx, req, {
        action: "conference_attendance_reviewed",
        entityType: "conference_speaker_proposal",
        entityId: proposal.id,
        summary: `Added conference speaker ${proposal.name} to CRM`,
        metadata: { personId, conferenceEventId: params.id, organizationId: organization?.id ?? null },
      });
      return { kind: "success" as const, proposal: updated };
    });
    if (result.kind === "missing") {
      conflictCount += 1;
      continue;
    }
    if (result.kind === "conflict") {
      conflictCount += 1;
      continue;
    }
    succeededCount += 1;
    results.push(result.proposal);
  }
  res.json({
    results: await proposalResponseRows(results),
    succeededCount,
    conflictCount,
  });
}));

router.post("/conference-events/:id/speaker-proposals/bulk-ignore", asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const userId = getAppUser(req)!.id;
  const params = parseOrBadRequest(BulkIgnoreConferenceSpeakerProposalsParams, req.params, res);
  const body = parseOrBadRequest(BulkIgnoreConferenceSpeakerProposalsBody, req.body, res);
  if (!params || !body) return;
  if (!hasUniqueSelection(body.proposalIds)) {
    res.status(400).json({ error: "invalid_selection", message: "Select one or more unique speaker proposals." });
    return;
  }
  const results: (typeof conferenceSpeakerProposals.$inferSelect)[] = [];
  let succeededCount = 0;
  let conflictCount = 0;
  for (const proposalId of body.proposalIds) {
    const result = await db.transaction(async (tx) => {
      const [proposal] = await tx.select().from(conferenceSpeakerProposals)
        .where(and(eq(conferenceSpeakerProposals.id, proposalId), eq(conferenceSpeakerProposals.conferenceEventId, params.id)))
        .for("update");
      if (!proposal || proposal.status === "added") return null;
      if (proposal.status === "ignored") return proposal;
      const [updated] = await tx.update(conferenceSpeakerProposals).set({
        status: "ignored",
        reviewedByUserId: userId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(conferenceSpeakerProposals.id, proposal.id)).returning();
      await recordAudit(tx, req, {
        action: "conference_attendance_reviewed",
        entityType: "conference_speaker_proposal",
        entityId: proposal.id,
        summary: `Ignored conference speaker proposal ${proposal.name}`,
        metadata: { conferenceEventId: params.id },
      });
      return updated;
    });
    if (!result) {
      conflictCount += 1;
      continue;
    }
    succeededCount += 1;
    results.push(result);
  }
  res.json({
    results: await proposalResponseRows(results),
    succeededCount,
    conflictCount,
  });
}));

router.post("/conference-speaker-proposals/:id/reopen", asyncHandler(async (req, res) => {
  const userId = canWrite(req, res);
  if (!userId) return;
  const params = parseOrBadRequest(ReopenConferenceSpeakerProposalParams, req.params, res);
  if (!params) return;
  const result = await db.transaction(async (tx) => {
    const [proposal] = await tx.select().from(conferenceSpeakerProposals)
      .where(eq(conferenceSpeakerProposals.id, params.id)).for("update");
    if (!proposal) return { kind: "missing" as const };
    if (proposal.status === "pending") return { kind: "saved" as const, proposal };
    if (proposal.status !== "ignored") return { kind: "conflict" as const };
    const [updated] = await tx.update(conferenceSpeakerProposals).set({
      status: "pending",
      reviewedByUserId: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(conferenceSpeakerProposals.id, params.id)).returning();
    await recordAudit(tx, req, {
      action: "conference_attendance_reviewed",
      entityType: "conference_speaker_proposal",
      entityId: proposal.id,
      summary: `Reopened conference speaker proposal ${proposal.name}`,
      metadata: { conferenceEventId: proposal.conferenceEventId },
    });
    return { kind: "saved" as const, proposal: updated };
  });
  if (result.kind === "missing") return notFound(res, "conference speaker proposal");
  if (result.kind === "conflict") {
    res.status(409).json({ error: "not_ignored", message: "Only an ignored proposal can be reopened." });
    return;
  }
  res.json((await proposalResponseRows([result.proposal]))[0]);
}));

router.post("/admin/conference-research/backfill", asyncHandler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = parseOrBadRequest(EnqueueConferenceResearchBackfillBody, req.body, res);
  if (!body) return;
  if (body.eventIds && new Set(body.eventIds).size !== body.eventIds.length) {
    res.status(400).json({ error: "invalid_selection", message: "Event IDs must be unique." });
    return;
  }
  if (body.eventIds && body.eventIds.length === 0) {
    res.status(400).json({ error: "invalid_selection", message: "Omit eventIds to select all events, or provide at least one event ID." });
    return;
  }
  if (body.eventIds?.length) {
    const found = await db.select({ id: conferenceEvents.id }).from(conferenceEvents)
      .where(inArray(conferenceEvents.id, body.eventIds));
    if (found.length !== body.eventIds.length) {
      res.status(400).json({ error: "invalid_selection", message: "One or more selected conference events do not exist." });
      return;
    }
  }
  const result = await enqueueConferenceResearchBackfill(body);
  await recordAudit(db, req, {
    action: "create",
    entityType: "conference_research_backfill",
    entityId: newId(),
    summary: "Enqueued retroactive public conference research",
    metadata: result,
  });
  res.status(202).json(result);
}));

export default router;