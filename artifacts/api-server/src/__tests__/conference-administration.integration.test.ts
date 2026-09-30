import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, inArray } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL && !/test:test@localhost:5432\/test/.test(process.env.DATABASE_URL);
const run = `confadmin_${Date.now()}`;
const userId = `${run}_user`;
const personId = `${run}_person`;
const typeIds = [`${run}_source_type`, `${run}_target_type`];
const eventIds = [`${run}_source_event`, `${run}_target_event`];
const auth = vi.hoisted(() => ({ current: { id: "", role: "admin" } }));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { appUser?: { id: string; role: string } }, _res: unknown, next: () => void) => {
    req.appUser = auth.current;
    next();
  },
}));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

type DbModule = typeof import("@workspace/db");
let schema: DbModule;
let db: DbModule["db"];
let server: Server;
let baseUrl: string;

async function request(path: string, body?: unknown, method = "POST") {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json() as any,
  };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  db = schema.db;
  await db.insert(schema.users).values({
    id: userId, clerkId: `clerk_${userId}`, email: `${userId}@example.org`, role: "admin",
  });
  await db.insert(schema.people).values({ id: personId, fullName: "Conference Merge Person" });
  await db.insert(schema.conferenceTypes).values([
    { id: typeIds[0], displayName: `Conference Source ${run}`, aliases: ["Source alias"] },
    { id: typeIds[1], displayName: `Conference Target ${run}`, aliases: ["Target alias"] },
  ]);
  await db.insert(schema.conferenceEvents).values([
    { id: eventIds[0], conferenceTypeId: typeIds[0], year: 2093 },
    { id: eventIds[1], conferenceTypeId: typeIds[1], year: 2093 },
  ]);
  auth.current = { id: userId, role: "admin" };
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(schema.conferenceEvents).where(inArray(schema.conferenceEvents.id, eventIds));
  await db.delete(schema.conferenceTypes).where(inArray(schema.conferenceTypes.id, typeIds));
  await db.delete(schema.auditLog).where(eq(schema.auditLog.actorUserId, userId));
  await db.delete(schema.people).where(eq(schema.people.id, personId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
}, 60_000);

describe.skipIf(!HAS_DB)("conference administration and event dates", () => {
  it("restricts conference-type administration to admins while allowing event writes and manual attendance roles", async () => {
    auth.current = { id: userId, role: "team_member" };
    try {
      expect((await request(`/conference-types?search=Source`, undefined, "GET")).status).toBe(200);
      expect((await request("/conference-types", { displayName: `Denied ${run}` })).status).toBe(403);
      expect((await request(`/conference-types/${typeIds[0]}`, { displayName: "Denied rename" }, "PATCH")).status).toBe(403);
      expect((await request(`/conference-types/${typeIds[0]}`, undefined, "DELETE")).status).toBe(403);
      expect((await request(`/conference-types/${typeIds[0]}/merge`, { targetTypeId: typeIds[1] })).status).toBe(403);

      const event = await request("/conference-events", {
        conferenceTypeId: typeIds[1], year: 2096, datesUnknown: true,
      });
      expect(event.status).toBe(201);
      eventIds.push(event.body.id);
      const edited = await request(`/conference-events/${event.body.id}`, { notes: "Edited by team member" }, "PATCH");
      expect(edited.status).toBe(200);
      const attendance = await request(`/conference-events/${event.body.id}/attendance`, {
        personId, role: "Speaker", sourceType: "manual",
      });
      expect(attendance.status).toBe(201);
      expect(attendance.body.role).toBe("Speaker");
    } finally {
      auth.current = { id: userId, role: "admin" };
    }
  });

  it("searches aliases, blocks deletion of referenced types, and requires explicit unknown dates", async () => {
    const listed = await request(`/conference-types?search=Source%20alias`, undefined, "GET");
    expect(listed.status).toBe(200);
    expect(listed.body.map((row: any) => row.id)).toContain(typeIds[0]);

    const deleted = await request(`/conference-types/${typeIds[0]}`, undefined, "DELETE");
    expect(deleted.status).toBe(409);
    const missingChoice = await request("/conference-events", {
      conferenceTypeId: typeIds[1], year: 2094,
    });
    expect(missingChoice.status).toBe(400);

    const unknown = await request("/conference-events", {
      conferenceTypeId: typeIds[1], year: 2094, datesUnknown: true,
    });
    expect(unknown.status).toBe(201);
    eventIds.push(unknown.body.id);
    expect(unknown.body).toMatchObject({ datesUnknown: true, startDate: null, endDate: null });

    const badPatch = await request(`/conference-events/${unknown.body.id}`, {
      startDate: null,
    }, "PATCH");
    expect(badPatch.status).toBe(400);
    const markUnknown = await request(`/conference-events/${unknown.body.id}`, {
      datesUnknown: true,
    }, "PATCH");
    expect(markUnknown.body).toMatchObject({ datesUnknown: true, startDate: null });
    expect(await db.select().from(schema.conferenceResearchRequests).where(and(
      eq(schema.conferenceResearchRequests.conferenceEventId, unknown.body.id),
      eq(schema.conferenceResearchRequests.kind, "dates"),
      eq(schema.conferenceResearchRequests.windowKey, "dates_missing"),
    ))).toHaveLength(1);
    const setDate = await request(`/conference-events/${unknown.body.id}`, {
      startDate: "2094-06-11",
    }, "PATCH");
    expect(setDate.status).toBe(200);
    expect(setDate.body.startDate).toBe("2094-06-11");
    expect(await db.select().from(schema.conferenceResearchRequests).where(and(
      eq(schema.conferenceResearchRequests.conferenceEventId, unknown.body.id),
      eq(schema.conferenceResearchRequests.kind, "agenda_speakers"),
      eq(schema.conferenceResearchRequests.windowKey, "before_21_days:2094-06-11"),
    ))).toHaveLength(1);
    await request(`/conference-events/${unknown.body.id}`, { datesUnknown: true }, "PATCH");

    const dated = await request("/conference-events", {
      conferenceTypeId: typeIds[1], year: 2095, startDate: "2095-05-10", endDate: null,
    });
    expect(dated.status).toBe(201);
    eventIds.push(dated.body.id);
    const researchedAt = new Date();
    await db.insert(schema.conferenceResearchRequests).values({
      id: `${run}_date_run`, conferenceEventId: dated.body.id, kind: "dates", windowKey: "manual-test",
      status: "completed", prompt: "Date research", completedAt: researchedAt,
      proposedStartDate: "2095-05-10", proposedEndDate: null, proposedDateConfidence: "high",
      sources: [{ url: "https://conference.example.org/dates", title: "Official dates" }],
      evidence: [{
        startDate: "2095-05-10", endDate: null, sourceUrl: "https://conference.example.org/dates",
        evidence: "The conference will be held on May 10, 2095.",
      }],
    });
    const confirmed = await request(`/conference-events/${dated.body.id}/confirm-dates`, {
      researchRequestId: `${run}_date_run`, startDate: "2095-05-10", endDate: null,
      dateSourceUrl: "https://conference.example.org/dates", dateEvidence: "The conference will be held on May 10, 2095.",
      dateConfidence: "high", expectedUpdatedAt: dated.body.updatedAt, confirmed: true,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      dateSourceUrl: "https://conference.example.org/dates",
      dateEvidence: "The conference will be held on May 10, 2095.", dateReviewedByUserId: userId,
    });
    const withUrl = await request(`/conference-events/${dated.body.id}`, {
      attendeeSiteUrl: "https://conference.example.org/attendees",
    }, "PATCH");
    expect(withUrl.status).toBe(200);
    expect(await db.select().from(schema.conferenceResearchRequests).where(and(
      eq(schema.conferenceResearchRequests.conferenceEventId, dated.body.id),
      eq(schema.conferenceResearchRequests.kind, "agenda_speakers"),
      eq(schema.conferenceResearchRequests.windowKey, "before_21_days:2095-05-10"),
    ))).toHaveLength(1);
  });

  it("collision-safely merges every event child and preserves date-run and review history", async () => {
    const emailMessageId = `${run}_email`;
    const batchIds = [`${run}_source_batch`, `${run}_target_batch`];
    const requestIds = [`${run}_source_run`, `${run}_target_run`];
    await db.insert(schema.conferenceAttendance).values([
      { id: `${run}_source_attendance`, conferenceEventId: eventIds[0], personId, status: "confirmed", sourceType: "conference_website", sourceReference: "official", evidenceNote: "Source attendance" },
      { id: `${run}_target_attendance`, conferenceEventId: eventIds[1], personId, status: "possible", evidenceNote: "Target attendance" },
    ]);
    await db.insert(schema.conferenceAttendanceSuggestions).values([
      { id: `${run}_source_suggestion`, conferenceEventId: eventIds[0], personId, emailMessageId, confidence: "high", evidenceNote: "Source suggestion", status: "accepted", reviewedByUserId: userId, reviewedAt: new Date() },
      { id: `${run}_target_suggestion`, conferenceEventId: eventIds[1], personId, emailMessageId, confidence: "low", evidenceNote: "Target suggestion" },
    ]);
    await db.insert(schema.conferenceImportBatches).values([
      { id: batchIds[0], conferenceEventId: eventIds[0], sourceHash: run, status: "confirmed", createdByUserId: userId, confirmedByUserId: userId, confirmedAt: new Date() },
      { id: batchIds[1], conferenceEventId: eventIds[1], sourceHash: run, createdByUserId: userId },
    ]);
    await db.insert(schema.conferenceImportRows).values([
      { id: `${run}_source_row`, conferenceImportBatchId: batchIds[0], rowNumber: 1, rawName: "Person", rawEmail: "person@example.org", matchStatus: "exact", matchedPersonId: personId, reviewedPersonId: personId, matchEvidence: "Source match", disposition: "accept" },
      { id: `${run}_target_row`, conferenceImportBatchId: batchIds[1], rowNumber: 1, rawName: "Person", rawEmail: "person@example.org", matchStatus: "unmatched", matchEvidence: "Target match" },
    ]);
    await db.insert(schema.conferenceResearchRequests).values([
      { id: requestIds[0], conferenceEventId: eventIds[0], kind: "dates", windowKey: "created", status: "completed", prompt: "Source prompt", completedAt: new Date(), sources: [{ url: "https://source.example.org" }], evidence: [{ evidence: "Source evidence" }] },
      { id: requestIds[1], conferenceEventId: eventIds[1], kind: "dates", windowKey: "created", status: "completed", prompt: "Target prompt", completedAt: new Date() },
    ]);
    await db.insert(schema.conferenceSpeakerProposals).values([
      { id: `${run}_source_speaker`, conferenceEventId: eventIds[0], conferenceResearchRequestId: requestIds[0], speakerFingerprint: "fingerprint", name: "A Speaker", confidence: "high", status: "ignored", reviewedByUserId: userId, reviewedAt: new Date(), sessionEvidence: "Source speaker evidence" },
      { id: `${run}_target_speaker`, conferenceEventId: eventIds[1], conferenceResearchRequestId: requestIds[1], speakerFingerprint: "fingerprint", name: "A Speaker", confidence: "medium", sessionEvidence: "Target speaker evidence" },
    ]);

    const missingResolution = await request(`/conference-types/${typeIds[0]}/merge`, { targetTypeId: typeIds[1] });
    expect(missingResolution.status).toBe(409);
    expect(await db.select().from(schema.conferenceEvents).where(inArray(schema.conferenceEvents.id, eventIds.slice(0, 2)))).toHaveLength(2);

    const unsafeBatchIds = [`${run}_unsafe_source`, `${run}_unsafe_target`];
    await db.insert(schema.conferenceImportBatches).values([
      { id: unsafeBatchIds[0], conferenceEventId: eventIds[0], sourceHash: `${run}_different_source` },
      { id: unsafeBatchIds[1], conferenceEventId: eventIds[1], sourceHash: `${run}_different_source` },
    ]);
    await db.insert(schema.conferenceImportRows).values([
      { id: `${run}_unsafe_source_row`, conferenceImportBatchId: unsafeBatchIds[0], rowNumber: 1, rawName: "Source name", matchStatus: "unmatched" },
      { id: `${run}_unsafe_target_row`, conferenceImportBatchId: unsafeBatchIds[1], rowNumber: 1, rawName: "Different target name", matchStatus: "unmatched" },
    ]);
    const unsafe = await request(`/conference-types/${typeIds[0]}/merge`, {
      targetTypeId: typeIds[1],
      eventResolutions: [{ sourceEventId: eventIds[0], targetEventId: eventIds[1], strategy: "preserve_all_history" }],
    });
    expect(unsafe.status).toBe(409);
    expect(await db.select().from(schema.conferenceEvents).where(inArray(schema.conferenceEvents.id, eventIds.slice(0, 2)))).toHaveLength(2);
    await db.delete(schema.conferenceImportBatches).where(inArray(schema.conferenceImportBatches.id, unsafeBatchIds));

    const response = await request(`/conference-types/${typeIds[0]}/merge`, {
      targetTypeId: typeIds[1],
      eventResolutions: [{ sourceEventId: eventIds[0], targetEventId: eventIds[1], strategy: "preserve_all_history" }],
    });
    expect(response.status).toBe(200);
    expect(response.body.consolidatedEventIds).toEqual([eventIds[0]]);
    expect(await db.select().from(schema.conferenceEvents).where(eq(schema.conferenceEvents.id, eventIds[0]))).toHaveLength(0);
    expect(await db.select().from(schema.conferenceAttendance).where(eq(schema.conferenceAttendance.conferenceEventId, eventIds[1]))).toHaveLength(1);
    const [attendance] = await db.select().from(schema.conferenceAttendance).where(eq(schema.conferenceAttendance.conferenceEventId, eventIds[1]));
    expect(attendance).toMatchObject({ status: "confirmed", sourceReference: "official" });
    expect(attendance.evidenceNote).toContain("Target attendance");
    expect(await db.select().from(schema.conferenceAttendanceSuggestions).where(eq(schema.conferenceAttendanceSuggestions.conferenceEventId, eventIds[1]))).toHaveLength(1);
    const [suggestion] = await db.select().from(schema.conferenceAttendanceSuggestions).where(eq(schema.conferenceAttendanceSuggestions.conferenceEventId, eventIds[1]));
    expect(suggestion).toMatchObject({ status: "accepted" });
    expect(suggestion.evidenceNote).toContain("Target suggestion");
    const [batch] = await db.select().from(schema.conferenceImportBatches).where(eq(schema.conferenceImportBatches.conferenceEventId, eventIds[1]));
    expect(batch.status).toBe("confirmed");
    const [row] = await db.select().from(schema.conferenceImportRows).where(eq(schema.conferenceImportRows.conferenceImportBatchId, batch.id));
    expect(row).toMatchObject({ disposition: "accept", reviewedPersonId: personId });
    expect(row.matchEvidence).toContain("Target match");
    const runs = await db.select().from(schema.conferenceResearchRequests).where(eq(schema.conferenceResearchRequests.conferenceEventId, eventIds[1]));
    expect(runs).toHaveLength(2);
    expect(runs.find((item) => item.id === requestIds[0])?.windowKey).toContain("merged-from");
    const [speaker] = await db.select().from(schema.conferenceSpeakerProposals)
      .where(and(eq(schema.conferenceSpeakerProposals.conferenceEventId, eventIds[1]), eq(schema.conferenceSpeakerProposals.speakerFingerprint, "fingerprint")));
    expect(speaker.status).toBe("ignored");
    expect(speaker.sessionEvidence).toContain("Source speaker evidence");

  });
});