import { createHash } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  conferenceAttendance,
  conferenceAttendanceSuggestions,
  conferenceEvents,
  conferenceImportBatches,
  conferenceImportRows,
  conferenceResearchRequests,
  conferenceTypes,
  emailMessages,
  emails,
  people,
} from "@workspace/db/schema";
import {
  ConfirmConferenceImportBody,
  CreateConferenceAttendanceBody,
  CreateConferenceEventBody,
  CreateConferenceResearchRequestBody,
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
  UpdateConferenceEventBody,
  UpdateConferenceTypeBody,
} from "@workspace/api-zod";
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { recordAudit } from "../lib/audit";
import { asyncHandler, newId, notFound, paramId, parseOrBadRequest, parsePagination } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

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

function csvParse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted && char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === ",") { row.push(cell.trim()); cell = ""; continue; }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; cell = ""; continue;
    }
    cell += char;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function parseCsv(text: string) {
  const rows = csvParse(text);
  const headers = rows.shift()?.map((v) => v.toLowerCase().replace(/[\s_-]/g, "")) ?? [];
  const emailIndex = headers.indexOf("email");
  const nameIndex = headers.findIndex((h) => h === "name" || h === "fullname");
  const organizationIndex = headers.findIndex((h) => h === "organization" || h === "org" || h === "company");
  if (emailIndex < 0 && nameIndex < 0) throw new Error("CSV must include an Email or Name column.");
  return rows.map((cells, index) => ({
    rowNumber: index + 2,
    rawEmail: emailIndex >= 0 ? cells[emailIndex] || null : null,
    rawName: nameIndex >= 0 ? cells[nameIndex] || null : null,
    rawOrganization: organizationIndex >= 0 ? cells[organizationIndex] || null : null,
  }));
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
      matchStatus: conferenceImportRows.matchStatus,
      matchedPersonId: conferenceImportRows.matchedPersonId,
      matchedPersonName: people.fullName,
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
  const q = parseOrBadRequest(ListConferenceTypesQueryParams, req.query, res); if (!q) return;
  const rows = await db.select().from(conferenceTypes)
    .where(q.active === undefined ? undefined : eq(conferenceTypes.active, q.active))
    .orderBy(asc(conferenceTypes.displayName));
  res.json(rows);
}));

router.post("/conference-types", asyncHandler(async (req, res) => {
  const userId = requireWrite(req, res); if (!userId) return;
  const body = parseOrBadRequest(CreateConferenceTypeBody, req.body, res); if (!body) return;
  const [created] = await db.insert(conferenceTypes).values({
    id: newId(), displayName: body.displayName.trim(), aliases: body.aliases ?? [],
    organizer: body.organizer ?? null, websiteUrl: body.websiteUrl ?? null, active: body.active ?? true, notes: body.notes ?? null,
  }).returning();
  await recordAudit(db, req, { action: "create", entityType: "conference_type", entityId: created.id, summary: `Created conference type ${created.displayName}` });
  res.status(201).json(created);
}));

router.patch("/conference-types/:id", asyncHandler(async (req, res) => {
  if (!requireWrite(req, res)) return;
  const body = parseOrBadRequest(UpdateConferenceTypeBody, req.body, res); if (!body) return;
  const [updated] = await db.update(conferenceTypes).set({ ...body, displayName: body.displayName.trim(), updatedAt: new Date() }).where(eq(conferenceTypes.id, paramId(req))).returning();
  if (!updated) return notFound(res, "conference type");
  await recordAudit(db, req, { action: "update", entityType: "conference_type", entityId: updated.id, summary: `Updated conference type ${updated.displayName}` });
  res.json(updated);
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
  if (!requireWrite(req, res)) return;
  const body = parseOrBadRequest(CreateConferenceEventBody, req.body, res); if (!body) return;
  const [type] = await db.select().from(conferenceTypes).where(eq(conferenceTypes.id, body.conferenceTypeId));
  if (!type) return notFound(res, "conference type");
  const [created] = await db.insert(conferenceEvents).values({ id: newId(), ...body, status: body.status ?? "planned" }).returning();
  await recordAudit(db, req, { action: "create", entityType: "conference_event", entityId: created.id, summary: `Created ${eventDisplay(created, type.displayName)}` });
  res.status(201).json(created);
}));

router.get("/conference-events/:id", asyncHandler(async (req, res) => {
  const params = parseOrBadRequest(GetConferenceEventParams, req.params, res); if (!params) return;
  const [event] = await db.select().from(conferenceEvents).where(eq(conferenceEvents.id, params.id));
  if (!event) return notFound(res, "conference event");
  res.json(event);
}));

router.patch("/conference-events/:id", asyncHandler(async (req, res) => {
  if (!requireWrite(req, res)) return;
  const body = parseOrBadRequest(UpdateConferenceEventBody, req.body, res); if (!body) return;
  const [updated] = await db.update(conferenceEvents).set({ ...body, status: body.status ?? "planned", updatedAt: new Date() }).where(eq(conferenceEvents.id, paramId(req))).returning();
  if (!updated) return notFound(res, "conference event");
  await recordAudit(db, req, { action: "update", entityType: "conference_event", entityId: updated.id, summary: "Updated conference event" });
  res.json(updated);
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
      sourceType: body.sourceType ?? "manual", sourceReference: body.sourceReference ?? null, evidenceNote: body.evidenceNote ?? null,
      matchedByUserId: userId, reviewedByUserId: userId, reviewedAt: new Date(),
    }).onConflictDoUpdate({ target: [conferenceAttendance.conferenceEventId, conferenceAttendance.personId], set: {
      status: body.status ?? "confirmed", sourceType: body.sourceType ?? "manual", sourceReference: body.sourceReference ?? null,
      evidenceNote: body.evidenceNote ?? null, reviewedByUserId: userId, reviewedAt: new Date(), updatedAt: new Date(),
    } });
    await recordAudit(tx, req, { action: "conference_attendance_reviewed", entityType: "conference_attendance", entityId: `${eventId}:${body.personId}`, summary: `Recorded conference attendance for ${person.fullName ?? body.personId}` });
  });
  const [result] = await db.select(attendanceSelect()).from(conferenceAttendance).innerJoin(people, eq(people.id, conferenceAttendance.personId)).where(and(eq(conferenceAttendance.conferenceEventId, eventId), eq(conferenceAttendance.personId, body.personId)));
  res.status(201).json(result);
}));

router.post("/conference-events/:id/imports", asyncHandler(async (req, res) => {
  const userId = requireWrite(req, res); if (!userId) return;
  const body = parseOrBadRequest(StageConferenceImportBody, req.body, res); if (!body) return;
  const eventId = paramId(req);
  const [event] = await db.select({ id: conferenceEvents.id }).from(conferenceEvents).where(eq(conferenceEvents.id, eventId));
  if (!event) return notFound(res, "conference event");
  let parsed: ReturnType<typeof parseCsv>;
  try { parsed = parseCsv(body.csvText); } catch (error) { res.status(400).json({ error: "validation_error", message: error instanceof Error ? error.message : "Invalid CSV" }); return; }
  const hash = createHash("sha256").update(body.csvText).digest("hex");
  const [existing] = await db.select().from(conferenceImportBatches).where(and(eq(conferenceImportBatches.conferenceEventId, eventId), eq(conferenceImportBatches.sourceHash, hash)));
  if (existing) { res.json(await batchResponse(existing.id)); return; }
  const batchId = newId();
  await db.transaction(async (tx) => {
    await tx.insert(conferenceImportBatches).values({ id: batchId, conferenceEventId: eventId, sourceHash: hash, sourceFilename: body.filename ?? null, createdByUserId: userId });
    for (const candidate of parsed) {
      const normalized = candidate.rawEmail?.trim().toLowerCase();
      const matches = normalized ? await tx.select({ id: people.id }).from(emails).innerJoin(people, eq(people.id, emails.personId)).where(and(sql`lower(${emails.email}) = ${normalized}`, sql`${people.archivedAt} IS NULL`)) : [];
      const exact = matches.length === 1;
      await tx.insert(conferenceImportRows).values({
        id: newId(), conferenceImportBatchId: batchId, ...candidate,
        rawEmail: normalized ?? null, matchStatus: exact ? "exact" : matches.length > 1 ? "ambiguous" : "unmatched",
        matchedPersonId: exact ? matches[0].id : null, matchEvidence: exact ? "Exact CRM email match" : normalized ? "No unique CRM email match" : "No email supplied",
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
  const accepted = new Set(body.acceptedRowIds ?? batch.rows.filter((r) => r.matchStatus === "exact").map((r) => r.id));
  await db.transaction(async (tx) => {
    for (const row of batch.rows) {
      const personId = body.personOverrides?.[row.id] ?? row.matchedPersonId;
      if (!accepted.has(row.id) || !personId) {
        await tx.update(conferenceImportRows).set({ disposition: "skip", updatedAt: new Date() }).where(eq(conferenceImportRows.id, row.id));
        continue;
      }
      await tx.insert(conferenceAttendance).values({
        id: newId(), conferenceEventId: batch.conferenceEventId, personId, status: "confirmed", sourceType: "uploaded_list",
        sourceReference: batch.sourceFilename, evidenceNote: row.matchEvidence, importedByUserId: userId, reviewedByUserId: userId, reviewedAt: new Date(),
      }).onConflictDoNothing({ target: [conferenceAttendance.conferenceEventId, conferenceAttendance.personId] });
      await tx.update(conferenceImportRows).set({ reviewedPersonId: personId, disposition: "accept", updatedAt: new Date() }).where(eq(conferenceImportRows.id, row.id));
    }
    await tx.update(conferenceImportBatches).set({ status: "confirmed", confirmedByUserId: userId, confirmedAt: new Date(), updatedAt: new Date() }).where(eq(conferenceImportBatches.id, batchId));
    await recordAudit(tx, req, { action: "conference_attendance_reviewed", entityType: "conference_import", entityId: batchId, summary: `Confirmed staged conference attendance`, metadata: { acceptedRows: accepted.size } });
  });
  res.json(await batchResponse(batchId));
}));

router.post("/conference-events/:id/research-requests", asyncHandler(async (req, res) => {
  const userId = requireWrite(req, res); if (!userId) return;
  const body = parseOrBadRequest(CreateConferenceResearchRequestBody, req.body, res); if (!body) return;
  const eventId = paramId(req);
  const [event] = await db.select({ event: conferenceEvents, typeName: conferenceTypes.displayName }).from(conferenceEvents).innerJoin(conferenceTypes, eq(conferenceTypes.id, conferenceEvents.conferenceTypeId)).where(eq(conferenceEvents.id, eventId));
  if (!event) return notFound(res, "conference event");
  const url = body.attendeeSiteUrl ?? event.event.attendeeSiteUrl;
  const prompt = `Research the public attendee information for ${eventDisplay(event.event, event.typeName)}${url ? ` at ${url}` : ""}. Return a table with attendee name, organization, role, public source URL, and confidence. Do not sign in, bypass a paywall, use passwords, or infer private data. I will review every match in our CRM before importing. ${body.instructions ?? ""}`.trim();
  const [created] = await db.insert(conferenceResearchRequests).values({ id: newId(), conferenceEventId: eventId, attendeeSiteUrl: url ?? null, instructions: body.instructions ?? null, prompt, createdByUserId: userId }).returning();
  res.status(201).json(created);
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
  const [suggestion] = await db.select().from(conferenceAttendanceSuggestions).where(eq(conferenceAttendanceSuggestions.id, id));
  if (!suggestion) return notFound(res, "conference attendance suggestion");
  await db.transaction(async (tx) => {
    if (body.status === "accepted") await tx.insert(conferenceAttendance).values({
      id: newId(), conferenceEventId: suggestion.conferenceEventId, personId: suggestion.personId, status: "likely", sourceType: "wildflower_email",
      sourceReference: suggestion.emailMessageId, evidenceNote: suggestion.evidenceNote, reviewedByUserId: userId, reviewedAt: new Date(),
    }).onConflictDoNothing({ target: [conferenceAttendance.conferenceEventId, conferenceAttendance.personId] });
    await tx.update(conferenceAttendanceSuggestions).set({ status: body.status, reviewedByUserId: userId, reviewedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(conferenceAttendanceSuggestions.id, id), eq(conferenceAttendanceSuggestions.status, "pending")));
    await recordAudit(tx, req, { action: "conference_attendance_reviewed", entityType: "conference_attendance_suggestion", entityId: id, summary: `${body.status === "accepted" ? "Accepted" : "Dismissed"} email attendance suggestion` });
  });
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