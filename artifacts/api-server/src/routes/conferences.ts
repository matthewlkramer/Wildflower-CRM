import { createHash } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  conferenceAttendance,
  conferenceAttendanceSuggestions,
  conferenceEvents,
  conferenceImportBatches,
  conferenceImportRows,
  conferenceTypes,
  emailMessages,
  emails,
  people,
} from "@workspace/db/schema";
import {
  ConfirmConferenceImportBody,
  CreateConferenceAttendanceBody,
  CreateConferenceTypeBody,
  GenerateConferenceEmailSuggestionsParams,
  GetConferenceEventParams,
  GetConferenceImportParams,
  ListConferenceAttendanceParams,
  ListConferenceAttendanceQueryParams,
  ListConferenceEmailSuggestionsParams,
  ListConferenceEventsQueryParams,
  ListConferenceTypesQueryParams,
  ListPersonConferenceAttendanceParams,
  ReviewConferenceAttendanceSuggestionBody,
  StageConferenceImportBody,
  UpdateConferenceTypeBody,
} from "@workspace/api-zod";
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { requireAdmin } from "../lib/archive";
import { recordAudit } from "../lib/audit";
import { asyncHandler, newId, notFound, paramId, parseOrBadRequest, parsePagination } from "../lib/helpers";
import {
  ConferenceMergeConflict,
  ConferenceMergeValidationError,
  mergeConferenceTypeEvents,
} from "../lib/conferenceTypeMerge";
import { enqueueConferenceResearch } from "../lib/conferenceResearchWorker";
import { classifyImportRow, mapDocument, readImportDocument } from "../lib/conferenceImportDocument";
import { importDirectory, reviewConferenceImport } from "../lib/conferenceImportReview";

const router: IRouter = Router();
router.use(requireAuth);

const conferenceTypeMergeBody = z.object({
  targetTypeId: z.string().min(1),
  eventResolutions: z.array(z.object({
    sourceEventId: z.string().min(1),
    targetEventId: z.string().min(1),
    strategy: z.enum(["preserve_all_history"]).optional(),
  })).optional(),
});

const conferenceEventCreateBody = z.object({
  conferenceTypeId: z.string().min(1),
  year: z.number().int().min(2000).max(2200),
  nameOverride: z.string().nullable().optional(),
  startDate: z.string().date().nullable().optional(),
  endDate: z.string().date().nullable().optional(),
  datesUnknown: z.boolean().optional(),
  location: z.string().nullable().optional(),
  attendeeSiteUrl: z.string().url().nullable().optional(),
  source: z.string().nullable().optional(),
  status: z.enum(["planned", "completed", "cancelled"]).optional(),
  notes: z.string().nullable().optional(),
});

const conferenceEventPatchBody = conferenceEventCreateBody.partial();

function eventResponse<T extends { startDate: string | null }>(event: T) {
  return { ...event, datesUnknown: event.startDate === null };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === "23505" || candidate.cause !== undefined && isUniqueViolation(candidate.cause);
}

function requireWrite(req: Request, res: Response): string | null {
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

function requireAdminActor(req: Request, res: Response): string | null {
  if (!requireAdmin(req, res)) return null;
  return getAppUser(req)?.id ?? null;
}

function eventDisplay(event: { year: number; nameOverride: string | null }, typeName: string) {
  return event.nameOverride?.trim() || `${typeName} ${event.year}`;
}

function attendanceSelect() {
  return {
    id: conferenceAttendance.id,
    conferenceEventId: conferenceAttendance.conferenceEventId,
    personId: conferenceAttendance.personId,
    personName: sql<string>`COALESCE(${people.fullName}, trim(concat_ws(' ', ${people.firstName}, ${people.lastName})))`,
    organizationId: sql<string | null>`NULL`,
    organizationName: sql<string | null>`NULL`,
    status: conferenceAttendance.status,
    registrationListed: conferenceAttendance.registrationListed,
    role: conferenceAttendance.role,
    sourceType: conferenceAttendance.sourceType,
    sourceReference: conferenceAttendance.sourceReference,
    evidenceNote: conferenceAttendance.evidenceNote,
    createdAt: conferenceAttendance.createdAt,
  };
}

async function batchResponse(id: string) {
  const [batch] = await db.select().from(conferenceImportBatches).where(eq(conferenceImportBatches.id, id));
  if (!batch) return null;
  const rows = await db
    .select({
      id: conferenceImportRows.id,
      rowNumber: conferenceImportRows.rowNumber,
      rawName: conferenceImportRows.rawName,
      rawEmail: conferenceImportRows.rawEmail,
      rawOrganization: conferenceImportRows.rawOrganization,
      rawTitle: conferenceImportRows.rawTitle,
      rawCells: conferenceImportRows.rawCells,
      category: conferenceImportRows.category,
      matchConfidence: conferenceImportRows.matchConfidence,
      matchedOrganizationId: conferenceImportRows.matchedOrganizationId,
      candidatePersonIds: conferenceImportRows.candidatePersonIds,
      reviewError: conferenceImportRows.reviewError,
      foundationEvidence: conferenceImportRows.foundationEvidence,
      matchStatus: conferenceImportRows.matchStatus,
      matchedPersonId: conferenceImportRows.matchedPersonId,
      matchedPersonName: people.fullName,
      reviewedPersonId: conferenceImportRows.reviewedPersonId,
      matchEvidence: conferenceImportRows.matchEvidence,
      disposition: conferenceImportRows.disposition,
    })
    .from(conferenceImportRows)
    .leftJoin(people, eq(people.id, conferenceImportRows.matchedPersonId))
    .where(eq(conferenceImportRows.conferenceImportBatchId, id))
    .orderBy(asc(conferenceImportRows.rowNumber));
  return { ...batch, rows };
}

router.get("/conference-types", asyncHandler(async (req, res) => {
  const rawSearch = req.query.search;
  if (rawSearch !== undefined && typeof rawSearch !== "string") {
    res.status(400).json({ error: "validation_error", message: "search must be a string" }); return;
  }
  const q = parseOrBadRequest(ListConferenceTypesQueryParams, req.query, res); if (!q) return;
  const filters: SQL[] = [];
  if (q.active !== undefined) {
    const rawActive = req.query.active;
    if (rawActive !== "true" && rawActive !== "false") {
      res.status(400).json({ error: "validation_error", message: "active must be true or false" }); return;
    }
    filters.push(eq(conferenceTypes.active, rawActive === "true"));
  }
  if (rawSearch?.trim()) {
    const search = `%${rawSearch.trim()}%`;
    filters.push(or(
      ilike(conferenceTypes.displayName, search),
      ilike(conferenceTypes.organizer, search),
      sql`EXISTS (SELECT 1 FROM unnest(${conferenceTypes.aliases}) AS alias WHERE alias ILIKE ${search})`,
    )!);
  }
  const rows = await db.select().from(conferenceTypes)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(conferenceTypes.displayName));
  res.json(rows);
}));

router.post("/conference-types", asyncHandler(async (req, res) => {
  const userId = requireAdminActor(req, res); if (!userId) return;
  const body = parseOrBadRequest(CreateConferenceTypeBody, req.body, res); if (!body) return;
  const displayName = body.displayName.trim();
  if (!displayName) { res.status(400).json({ error: "validation_error", message: "displayName cannot be blank" }); return; }
  let created;
  try {
    [created] = await db.insert(conferenceTypes).values({
      id: newId(), displayName, aliases: [...new Set((body.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))],
      organizer: body.organizer?.trim() || null, websiteUrl: body.websiteUrl ?? null,
      active: body.active ?? true, notes: body.notes ?? null,
    }).returning();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    res.status(409).json({ error: "conference_type_name_conflict", message: "A conference type with this display name already exists." }); return;
  }
  await recordAudit(db, req, { action: "create", entityType: "conference_type", entityId: created.id, summary: `Created conference type ${created.displayName}` });
  res.status(201).json(created);
}));

router.patch("/conference-types/:id", asyncHandler(async (req, res) => {
  const userId = requireAdminActor(req, res); if (!userId) return;
  const body = parseOrBadRequest(UpdateConferenceTypeBody, req.body, res); if (!body) return;
  if (Object.keys(body).length === 0) { res.status(400).json({ error: "validation_error", message: "At least one conference type field is required." }); return; }
  if (body.displayName !== undefined && !body.displayName.trim()) {
    res.status(400).json({ error: "validation_error", message: "displayName cannot be blank" }); return;
  }
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (body.displayName !== undefined) set.displayName = body.displayName.trim();
  if (body.aliases !== undefined) set.aliases = [...new Set(body.aliases.map((alias) => alias.trim()).filter(Boolean))];
  if (body.organizer !== undefined) set.organizer = body.organizer?.trim() || null;
  if (body.websiteUrl !== undefined) set.websiteUrl = body.websiteUrl;
  if (body.active !== undefined) set.active = body.active;
  if (body.notes !== undefined) set.notes = body.notes;
  let updated;
  try {
    [updated] = await db.update(conferenceTypes).set(set).where(eq(conferenceTypes.id, paramId(req))).returning();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    res.status(409).json({ error: "conference_type_name_conflict", message: "A conference type with this display name already exists." }); return;
  }
  if (!updated) { notFound(res, "conference type"); return; }
  await recordAudit(db, req, { action: "update", entityType: "conference_type", entityId: updated.id, summary: `Updated conference type ${updated.displayName}` });
  res.json(updated);
}));

router.delete("/conference-types/:id", asyncHandler(async (req, res) => {
  const userId = requireAdminActor(req, res); if (!userId) return;
  const id = paramId(req);
  const result = await db.transaction(async (tx) => {
    const [type] = await tx.select().from(conferenceTypes).where(eq(conferenceTypes.id, id)).for("update");
    if (!type) return { kind: "missing" as const };
    const [eventRef] = await tx.select({ id: conferenceEvents.id }).from(conferenceEvents)
      .where(eq(conferenceEvents.conferenceTypeId, id)).limit(1);
    if (eventRef) return { kind: "referenced" as const, displayName: type.displayName };
    await tx.delete(conferenceTypes).where(eq(conferenceTypes.id, id));
    await recordAudit(tx, req, {
      action: "delete", entityType: "conference_type", entityId: id,
      summary: `Deleted unused conference type ${type.displayName}`, metadata: { actorUserId: userId },
    });
    return { kind: "deleted" as const };
  });
  if (result.kind === "missing") { notFound(res, "conference type"); return; }
  if (result.kind === "referenced") {
    res.status(409).json({ error: "conference_type_in_use", message: "This conference type is referenced by events. Archive it or merge it instead." });
    return;
  }
  res.status(204).end();
}));

router.post("/conference-types/:id/merge", asyncHandler(async (req, res) => {
  const userId = requireAdminActor(req, res); if (!userId) return;
  const body = parseOrBadRequest(conferenceTypeMergeBody, req.body, res); if (!body) return;
  const sourceTypeId = paramId(req);
  if (sourceTypeId === body.targetTypeId) {
    res.status(400).json({ error: "validation_error", message: "A conference type cannot be merged into itself." }); return;
  }
  try {
    const merged = await db.transaction(async (tx) => {
      const locked = await tx.select().from(conferenceTypes)
        .where(inArray(conferenceTypes.id, [sourceTypeId, body.targetTypeId]))
        .orderBy(asc(conferenceTypes.id)).for("update");
      const source = locked.find((row) => row.id === sourceTypeId);
      const target = locked.find((row) => row.id === body.targetTypeId);
      if (!source || !target) return { kind: "missing" as const };
      const eventMerge = await mergeConferenceTypeEvents(
        tx, sourceTypeId, body.targetTypeId, body.eventResolutions ?? [],
      );
      const { importBatchHistory, ...mergeResult } = eventMerge;
      const aliases = [...new Set([...target.aliases, source.displayName, ...source.aliases])];
      const [updatedTarget] = await tx.update(conferenceTypes).set({
        aliases,
        organizer: target.organizer ?? source.organizer,
        websiteUrl: target.websiteUrl ?? source.websiteUrl,
        notes: [target.notes, source.notes ? `Merged type ${source.displayName}: ${source.notes}` : null].filter(Boolean).join("\n\n") || null,
        updatedAt: new Date(),
      }).where(eq(conferenceTypes.id, target.id)).returning();
      await tx.delete(conferenceTypes).where(eq(conferenceTypes.id, source.id));
      await recordAudit(tx, req, {
        action: "merge", entityType: "conference_type", entityId: target.id,
        summary: `Merged conference type ${source.displayName} into ${target.displayName}`,
        metadata: {
          sourceTypeId, targetTypeId: target.id, actorUserId: userId,
          sourceType: { displayName: source.displayName, aliases: source.aliases, organizer: source.organizer, websiteUrl: source.websiteUrl, notes: source.notes },
          ...mergeResult,
          importBatchHistory,
        },
      });
      return {
        kind: "merged" as const,
        result: { sourceTypeId, targetType: updatedTarget, ...mergeResult },
      };
    });
    if (merged.kind === "missing") { notFound(res, "conference type"); return; }
    res.json(merged.result);
  } catch (error) {
    if (error instanceof ConferenceMergeConflict) {
      res.status(409).json({ error: "conference_type_merge_conflict", message: error.message }); return;
    }
    if (error instanceof ConferenceMergeValidationError) {
      res.status(400).json({ error: "validation_error", message: error.message }); return;
    }
    throw error;
  }
}));

router.get("/conference-events", asyncHandler(async (req, res) => {
  const q = parseOrBadRequest(ListConferenceEventsQueryParams, req.query, res); if (!q) return;
  const filters: SQL[] = [];
  if (q.conferenceTypeId) filters.push(eq(conferenceEvents.conferenceTypeId, q.conferenceTypeId));
  if (q.year) filters.push(eq(conferenceEvents.year, q.year));
  if (q.search) filters.push(or(ilike(conferenceTypes.displayName, `%${q.search}%`), ilike(conferenceEvents.nameOverride, `%${q.search}%`))!);
  const rows = await db.select({
    id: conferenceEvents.id,
    conferenceTypeId: conferenceEvents.conferenceTypeId,
    year: conferenceEvents.year,
    nameOverride: conferenceEvents.nameOverride,
    startDate: conferenceEvents.startDate,
    endDate: conferenceEvents.endDate,
    datesUnknown: sql<boolean>`${conferenceEvents.startDate} IS NULL`,
    dateSourceUrl: conferenceEvents.dateSourceUrl,
    dateEvidence: conferenceEvents.dateEvidence,
    dateConfidence: conferenceEvents.dateConfidence,
    dateResearchedAt: conferenceEvents.dateResearchedAt,
    dateReviewedByUserId: conferenceEvents.dateReviewedByUserId,
    dateReviewedAt: conferenceEvents.dateReviewedAt,
    location: conferenceEvents.location,
    attendeeSiteUrl: conferenceEvents.attendeeSiteUrl,
    source: conferenceEvents.source,
    status: conferenceEvents.status,
    notes: conferenceEvents.notes,
    createdAt: conferenceEvents.createdAt,
    updatedAt: conferenceEvents.updatedAt,
    conferenceTypeName: conferenceTypes.displayName,
    attendanceCount: sql<number>`count(${conferenceAttendance.id})::int`,
  }).from(conferenceEvents).innerJoin(conferenceTypes, eq(conferenceTypes.id, conferenceEvents.conferenceTypeId))
    .leftJoin(conferenceAttendance, eq(conferenceAttendance.conferenceEventId, conferenceEvents.id))
    .where(filters.length ? and(...filters) : undefined)
    .groupBy(conferenceEvents.id, conferenceTypes.displayName).orderBy(desc(conferenceEvents.year), asc(conferenceTypes.displayName));
  res.json(rows);
}));

router.post("/conference-events", asyncHandler(async (req, res) => {
  const userId = requireWrite(req, res); if (!userId) return;
  const body = parseOrBadRequest(conferenceEventCreateBody, req.body, res); if (!body) return;
  const hasDates = typeof body.startDate === "string";
  if ((body.datesUnknown === true && (body.startDate != null || body.endDate != null)) ||
    (body.datesUnknown !== true && !hasDates) ||
    (body.endDate && (!body.startDate || body.endDate < body.startDate))) {
    res.status(400).json({ error: "validation_error", message: "Enter a start date or explicitly mark dates unknown; the end date cannot precede the start date." }); return;
  }
  const [type] = await db.select().from(conferenceTypes).where(eq(conferenceTypes.id, body.conferenceTypeId));
  if (!type) { notFound(res, "conference type"); return; }
  const now = new Date();
  let created;
  try {
    [created] = await db.insert(conferenceEvents).values({
      id: newId(), conferenceTypeId: body.conferenceTypeId, year: body.year,
      nameOverride: body.nameOverride ?? null, startDate: hasDates ? body.startDate! : null,
      endDate: hasDates ? body.endDate ?? null : null,
      dateSourceUrl: null, dateEvidence: null, dateConfidence: null, dateResearchedAt: null,
      dateReviewedByUserId: userId, dateReviewedAt: now,
      location: body.location ?? null, attendeeSiteUrl: body.attendeeSiteUrl ?? null,
      source: body.source ?? null, status: body.status ?? "planned", notes: body.notes ?? null,
    }).returning();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    res.status(409).json({ error: "conference_event_exists", message: "An event already exists for this conference type and year." }); return;
  }
  await recordAudit(db, req, { action: "create", entityType: "conference_event", entityId: created.id, summary: `Created ${eventDisplay(created, type.displayName)}` });
  await enqueueConferenceResearch(
    created.id,
    created.startDate ? "agenda_speakers" : "dates",
    created.startDate ? "created" : "dates_missing",
    userId,
  );
  res.status(201).json(eventResponse(created));
}));

router.get("/conference-events/:id", asyncHandler(async (req, res) => {
  const params = parseOrBadRequest(GetConferenceEventParams, req.params, res); if (!params) return;
  const [event] = await db.select().from(conferenceEvents).where(eq(conferenceEvents.id, params.id));
  if (!event) { notFound(res, "conference event"); return; }
  res.json(eventResponse(event));
}));

router.patch("/conference-events/:id", asyncHandler(async (req, res) => {
  const userId = requireWrite(req, res); if (!userId) return;
  const body = parseOrBadRequest(conferenceEventPatchBody, req.body, res); if (!body) return;
  if (Object.keys(body).length === 0) { res.status(400).json({ error: "validation_error", message: "At least one event field is required." }); return; }
  const id = paramId(req);
  let outcome: { kind: "missing" } | { kind: "type_missing" } | { kind: "invalid"; message: string } |
    { kind: "updated"; event: typeof conferenceEvents.$inferSelect; research: { kind: "dates" | "agenda_speakers"; windowKey: string } | null };
  try {
    outcome = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(conferenceEvents).where(eq(conferenceEvents.id, id)).for("update");
      if (!existing) return { kind: "missing" as const };
      const conferenceTypeId = body.conferenceTypeId ?? existing.conferenceTypeId;
      const year = body.year ?? existing.year;
      if (body.conferenceTypeId) {
        const [type] = await tx.select({ id: conferenceTypes.id }).from(conferenceTypes).where(eq(conferenceTypes.id, conferenceTypeId));
        if (!type) return { kind: "type_missing" as const };
      }
      let startDate = existing.startDate;
      let endDate = existing.endDate;
      let datesWereWritten = false;
      if (body.datesUnknown === true) {
        if (body.startDate != null || body.endDate != null) {
          return { kind: "invalid" as const, message: "Dates cannot be entered when datesUnknown is true." };
        }
        startDate = null; endDate = null; datesWereWritten = true;
      } else {
        if (body.startDate !== undefined) {
          if (body.startDate === null) {
            return { kind: "invalid" as const, message: "Use datesUnknown=true to explicitly clear event dates." };
          }
          startDate = body.startDate;
          datesWereWritten = true;
        }
        if (body.endDate !== undefined) {
          endDate = body.endDate;
          datesWereWritten = true;
        }
        if (body.datesUnknown === false && !startDate) {
          return { kind: "invalid" as const, message: "A start date is required when datesUnknown is false." };
        }
      }
      if (endDate && (!startDate || endDate < startDate)) {
        return { kind: "invalid" as const, message: "The end date cannot precede the start date." };
      }
      const set: Record<string, unknown> = {
        conferenceTypeId, year, startDate, endDate, updatedAt: new Date(),
      };
      for (const key of ["nameOverride", "location", "attendeeSiteUrl", "source", "status", "notes"] as const) {
        if (body[key] !== undefined) set[key] = body[key];
      }
      if (datesWereWritten) {
        set.dateSourceUrl = null;
        set.dateEvidence = null;
        set.dateConfidence = null;
        set.dateResearchedAt = null;
        set.dateReviewedByUserId = userId;
        set.dateReviewedAt = new Date();
      }
      const [event] = await tx.update(conferenceEvents).set(set).where(eq(conferenceEvents.id, id)).returning();
      await recordAudit(tx, req, { action: "update", entityType: "conference_event", entityId: event.id, summary: "Updated conference event" });
      const siteUrlBecameAvailable = !!body.attendeeSiteUrl && body.attendeeSiteUrl !== existing.attendeeSiteUrl;
      const research = !startDate
        ? datesWereWritten || siteUrlBecameAvailable
          ? { kind: "dates" as const, windowKey: "dates_missing" }
          : null
        : datesWereWritten || siteUrlBecameAvailable
          ? { kind: "agenda_speakers" as const, windowKey: `before_21_days:${startDate}` }
          : null;
      return { kind: "updated" as const, event, research };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    res.status(409).json({ error: "conference_event_exists", message: "An event already exists for this conference type and year." }); return;
  }
  if (outcome.kind === "missing") { notFound(res, "conference event"); return; }
  if (outcome.kind === "type_missing") { notFound(res, "conference type"); return; }
  if (outcome.kind === "invalid") { res.status(400).json({ error: "validation_error", message: outcome.message }); return; }
  if (outcome.research) {
    await enqueueConferenceResearch(id, outcome.research.kind, outcome.research.windowKey, userId);
  }
  res.json(eventResponse(outcome.event));
}));

router.get("/conference-events/:id/attendance", asyncHandler(async (req, res) => {
  const params = parseOrBadRequest(ListConferenceAttendanceParams, req.params, res); if (!params) return;
  const q = parseOrBadRequest(ListConferenceAttendanceQueryParams, req.query, res); if (!q) return;
  const { page, limit, offset } = parsePagination(q);
  const filters: SQL[] = [eq(conferenceAttendance.conferenceEventId, params.id)];
  if (q.search) filters.push(ilike(people.fullName, `%${q.search}%`));
  const where = and(...filters);
  const [total] = await db.select({ total: count() }).from(conferenceAttendance).innerJoin(people, eq(people.id, conferenceAttendance.personId)).where(where);
  const rows = await db.select(attendanceSelect()).from(conferenceAttendance).innerJoin(people, eq(people.id, conferenceAttendance.personId)).where(where).orderBy(asc(people.fullName)).limit(limit).offset(offset);
  res.json({ data: rows, pagination: { page, limit, total: total.total } });
}));

router.post("/conference-events/:id/attendance", asyncHandler(async (req, res) => {
  const userId = requireWrite(req, res); if (!userId) return;
  const body = parseOrBadRequest(CreateConferenceAttendanceBody, req.body, res); if (!body) return;
  const eventId = paramId(req);
  const [person] = await db.select().from(people).where(and(eq(people.id, body.personId), sql`${people.archivedAt} IS NULL`));
  if (!person) return notFound(res, "person");
  await db.transaction(async (tx) => {
    await tx.insert(conferenceAttendance).values({
      id: newId(), conferenceEventId: eventId, personId: body.personId, status: body.status ?? "confirmed",
      role: body.role ?? "Attendee",
      sourceType: body.sourceType ?? "manual", sourceReference: body.sourceReference ?? null, evidenceNote: body.evidenceNote ?? null,
      matchedByUserId: userId, reviewedByUserId: userId, reviewedAt: new Date(),
    }).onConflictDoUpdate({ target: [conferenceAttendance.conferenceEventId, conferenceAttendance.personId], set: {
      status: body.status ?? "confirmed", role: body.role ?? "Attendee", sourceType: body.sourceType ?? "manual", sourceReference: body.sourceReference ?? null,
      evidenceNote: body.evidenceNote ?? null, reviewedByUserId: userId, reviewedAt: new Date(), updatedAt: new Date(),
    } });
    await recordAudit(tx, req, { action: "conference_attendance_reviewed", entityType: "conference_attendance", entityId: `${eventId}:${body.personId}`, summary: `Recorded conference attendance for ${person.fullName ?? body.personId}` });
  });
  const [result] = await db.select(attendanceSelect()).from(conferenceAttendance).innerJoin(people, eq(people.id, conferenceAttendance.personId)).where(and(eq(conferenceAttendance.conferenceEventId, eventId), eq(conferenceAttendance.personId, body.personId)));
  res.status(201).json(result);
}));

router.post("/conference-import-preview", asyncHandler(async (req, res) => {
  if (!requireWrite(req, res)) return;
  const body = parseOrBadRequest(StageConferenceImportBody, req.body, res); if (!body) return;
  try {
    const document = readImportDocument(body);
    res.json({ headers: document.headers, sheets: document.sheets, rows: document.rows.slice(0, 20), rowCount: document.rows.length });
  } catch (error) { res.status(400).json({ error: "validation_error", message: error instanceof Error ? error.message : "Invalid document" }); }
}));

router.post("/conference-events/:id/imports", asyncHandler(async (req, res) => {
  const userId = requireWrite(req, res); if (!userId) return;
  const body = parseOrBadRequest(StageConferenceImportBody, req.body, res); if (!body) return;
  const eventId = paramId(req);
  const [event] = await db.select({ id: conferenceEvents.id }).from(conferenceEvents).where(eq(conferenceEvents.id, eventId));
  if (!event) return notFound(res, "conference event");
  let parsed: ReturnType<typeof mapDocument>; let hash: string; let sourceDocumentHash: string;
  try {
    const document = readImportDocument(body); parsed = mapDocument(document, body.columns); sourceDocumentHash = document.hash;
    hash = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
  } catch (error) { res.status(400).json({ error: "validation_error", message: error instanceof Error ? error.message : "Invalid document" }); return; }
  let batchId = newId();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${eventId + hash}))`);
    const [existing] = await tx.select().from(conferenceImportBatches).where(and(eq(conferenceImportBatches.conferenceEventId, eventId), eq(conferenceImportBatches.sourceHash, hash)));
    if (existing) { batchId = existing.id; return; }
    await tx.insert(conferenceImportBatches).values({ id: batchId, conferenceEventId: eventId, sourceHash: hash, sourceFilename: body.filename ?? null, sourceDocumentHash, sourceMapping: { columns: body.columns ?? "auto", sheet: body.sheet ?? null, headerRow: body.headerRow ?? 1 }, createdByUserId: userId });
    const directory = await importDirectory(tx);
    for (const candidate of parsed) {
      const match = classifyImportRow(candidate, directory.people, directory.organizations);
      await tx.insert(conferenceImportRows).values({
        id: newId(), conferenceImportBatchId: batchId, ...candidate, ...match,
      });
    }
    await recordAudit(tx, req, { action: "create", entityType: "conference_import", entityId: batchId, summary: `Staged ${parsed.length} attendance rows`, metadata: { conferenceEventId: eventId } });
  });
  res.json(await batchResponse(batchId));
}));

router.get("/conference-imports/:id", asyncHandler(async (req, res) => {
  const params = parseOrBadRequest(GetConferenceImportParams, req.params, res); if (!params) return;
  const result = await batchResponse(params.id); if (!result) return notFound(res, "conference import");
  res.json(result);
}));

router.post("/conference-imports/:id/confirm", asyncHandler(async (req, res) => {
  const userId = requireWrite(req, res); if (!userId) return;
  const body = parseOrBadRequest(ConfirmConferenceImportBody, req.body, res); if (!body) return;
  const batchId = paramId(req);
  const batch = await batchResponse(batchId); if (!batch) return notFound(res, "conference import");
  if (batch.status === "confirmed") { res.json(batch); return; }
  try { await reviewConferenceImport(batchId, body, userId, req); }
  catch (error) { res.status(400).json({ error: "validation_error", message: error instanceof Error ? error.message : "Invalid review" }); return; }
  res.json(await batchResponse(batchId));
}));

router.get("/conference-events/:id/email-suggestions", asyncHandler(async (req, res) => {
  const params = parseOrBadRequest(ListConferenceEmailSuggestionsParams, req.params, res); if (!params) return;
  const rows = await db.select({
    id: conferenceAttendanceSuggestions.id, conferenceEventId: conferenceAttendanceSuggestions.conferenceEventId, personId: conferenceAttendanceSuggestions.personId,
    personName: people.fullName, emailMessageId: conferenceAttendanceSuggestions.emailMessageId, confidence: conferenceAttendanceSuggestions.confidence,
    evidenceNote: conferenceAttendanceSuggestions.evidenceNote, status: conferenceAttendanceSuggestions.status, createdAt: conferenceAttendanceSuggestions.createdAt,
  }).from(conferenceAttendanceSuggestions).innerJoin(people, eq(people.id, conferenceAttendanceSuggestions.personId))
    .where(eq(conferenceAttendanceSuggestions.conferenceEventId, params.id)).orderBy(desc(conferenceAttendanceSuggestions.createdAt));
  res.json(rows);
}));

router.post("/conference-events/:id/email-suggestions", asyncHandler(async (req, res) => {
  const userId = requireWrite(req, res); if (!userId) return;
  const params = parseOrBadRequest(GenerateConferenceEmailSuggestionsParams, req.params, res); if (!params) return;
  const [event] = await db.select({ event: conferenceEvents, type: conferenceTypes }).from(conferenceEvents).innerJoin(conferenceTypes, eq(conferenceTypes.id, conferenceEvents.conferenceTypeId)).where(eq(conferenceEvents.id, params.id));
  if (!event) return notFound(res, "conference event");
  const terms = [event.type.displayName, ...event.type.aliases].filter(Boolean).map((term) => term.toLowerCase());
  const messages = await db.select().from(emailMessages).where(sql`${emailMessages.matchedPersonIds} IS NOT NULL`).orderBy(desc(emailMessages.sentAt)).limit(500);
  await db.transaction(async (tx) => {
    for (const message of messages) {
      const evidence = `${message.subject ?? ""} ${message.snippet ?? ""} ${message.aiSummary ?? ""}`.toLowerCase();
      if (!terms.some((term) => evidence.includes(term))) continue;
      for (const personId of message.matchedPersonIds ?? []) {
        await tx.insert(conferenceAttendanceSuggestions).values({
          id: newId(), conferenceEventId: params.id, personId, emailMessageId: message.id, confidence: "medium",
          evidenceNote: `Existing CRM email mentions ${event.type.displayName}. Review before recording attendance.`,
        }).onConflictDoNothing({ target: [conferenceAttendanceSuggestions.conferenceEventId, conferenceAttendanceSuggestions.personId, conferenceAttendanceSuggestions.emailMessageId] });
      }
    }
    await recordAudit(tx, req, { action: "create", entityType: "conference_email_suggestions", entityId: params.id, summary: "Generated review-only email attendance suggestions", metadata: { actorUserId: userId } });
  });
  const rows = await db.select({
    id: conferenceAttendanceSuggestions.id, conferenceEventId: conferenceAttendanceSuggestions.conferenceEventId, personId: conferenceAttendanceSuggestions.personId,
    personName: people.fullName, emailMessageId: conferenceAttendanceSuggestions.emailMessageId, confidence: conferenceAttendanceSuggestions.confidence,
    evidenceNote: conferenceAttendanceSuggestions.evidenceNote, status: conferenceAttendanceSuggestions.status, createdAt: conferenceAttendanceSuggestions.createdAt,
  }).from(conferenceAttendanceSuggestions).innerJoin(people, eq(people.id, conferenceAttendanceSuggestions.personId)).where(eq(conferenceAttendanceSuggestions.conferenceEventId, params.id));
  res.json(rows);
}));

router.patch("/conference-attendance-suggestions/:id", asyncHandler(async (req, res) => {
  const userId = requireWrite(req, res); if (!userId) return;
  const body = parseOrBadRequest(ReviewConferenceAttendanceSuggestionBody, req.body, res); if (!body) return;
  const id = paramId(req);
  const outcome = await db.transaction(async (tx) => {
    const [suggestion] = await tx.select().from(conferenceAttendanceSuggestions)
      .where(eq(conferenceAttendanceSuggestions.id, id)).for("update");
    if (!suggestion) return "missing";
    if (suggestion.status !== "pending") return "reviewed";
    if (body.status === "accepted") await tx.insert(conferenceAttendance).values({
      id: newId(), conferenceEventId: suggestion.conferenceEventId, personId: suggestion.personId, status: "likely", sourceType: "wildflower_email",
      sourceReference: suggestion.emailMessageId, evidenceNote: suggestion.evidenceNote, reviewedByUserId: userId, reviewedAt: new Date(),
    }).onConflictDoNothing({ target: [conferenceAttendance.conferenceEventId, conferenceAttendance.personId] });
    await tx.update(conferenceAttendanceSuggestions).set({ status: body.status, reviewedByUserId: userId, reviewedAt: new Date(), updatedAt: new Date() })
      .where(eq(conferenceAttendanceSuggestions.id, id));
    await recordAudit(tx, req, { action: "conference_attendance_reviewed", entityType: "conference_attendance_suggestion", entityId: id, summary: `${body.status === "accepted" ? "Accepted" : "Dismissed"} email attendance suggestion` });
    return "ok";
  });
  if (outcome === "missing") return notFound(res, "conference attendance suggestion");
  if (outcome === "reviewed") { res.status(409).json({ error: "already_reviewed", message: "This suggestion has already been reviewed." }); return; }
  const [result] = await db.select({
    id: conferenceAttendanceSuggestions.id, conferenceEventId: conferenceAttendanceSuggestions.conferenceEventId, personId: conferenceAttendanceSuggestions.personId,
    personName: people.fullName, emailMessageId: conferenceAttendanceSuggestions.emailMessageId, confidence: conferenceAttendanceSuggestions.confidence,
    evidenceNote: conferenceAttendanceSuggestions.evidenceNote, status: conferenceAttendanceSuggestions.status, createdAt: conferenceAttendanceSuggestions.createdAt,
  }).from(conferenceAttendanceSuggestions).innerJoin(people, eq(people.id, conferenceAttendanceSuggestions.personId)).where(eq(conferenceAttendanceSuggestions.id, id));
  res.json(result);
}));

router.get("/people/:id/conference-attendance", asyncHandler(async (req, res) => {
  const params = parseOrBadRequest(ListPersonConferenceAttendanceParams, req.params, res); if (!params) return;
  const rows = await db.select(attendanceSelect()).from(conferenceAttendance).innerJoin(people, eq(people.id, conferenceAttendance.personId))
    .where(eq(conferenceAttendance.personId, params.id)).orderBy(desc(conferenceAttendance.createdAt));
  res.json(rows);
}));

export default router;
