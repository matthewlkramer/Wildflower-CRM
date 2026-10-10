import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, inArray } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL && !/test:test@localhost:5432\/test/.test(process.env.DATABASE_URL);
const run = `confrelease_${Date.now()}`;
const userId = `${run}_user`;
const personIds = [0, 1, 2, 3].map((n) => `${run}_p${n}`);
const typeId = `${run}_type`;
const events = [`${run}_import`, `${run}_merge`, `${run}_other`];
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

async function post(path: string, body: unknown, method = "POST") {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  db = schema.db;
  await db.insert(schema.users).values({
    id: userId, clerkId: `clerk_${userId}`, email: `${userId}@example.org`, role: "admin",
  });
  await db.insert(schema.people).values(personIds.map((id, n) => ({
    id, fullName: `Conference Person ${n}`,
  })));
  await db.insert(schema.emails).values([
    { id: `${run}_exact`, personId: personIds[0], email: `${run}.exact@example.org` },
  ]);
  await db.insert(schema.conferenceTypes).values({ id: typeId, displayName: `Conference ${run}` });
  await db.insert(schema.conferenceEvents).values(events.map((id, n) => ({
    id, conferenceTypeId: typeId, year: 2040 + n,
  })));
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
  await db.delete(schema.conferenceEvents).where(inArray(schema.conferenceEvents.id, events));
  await db.delete(schema.conferenceTypes).where(eq(schema.conferenceTypes.id, typeId));
  await db.delete(schema.emails).where(inArray(schema.emails.personId, personIds));
  await db.delete(schema.auditLog).where(eq(schema.auditLog.actorUserId, userId));
  await db.delete(schema.bulkOperations).where(eq(schema.bulkOperations.actorUserId, userId));
  await db.delete(schema.people).where(inArray(schema.people.id, personIds));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
}, 60_000);

describe.skipIf(!HAS_DB)("conference release safeguards", () => {
  it("stages exact/unmatched CSV rows once and confirms only reviewed matches once", async () => {
    const csvText = `Name,Email\nConference Person 0,${run}.exact@example.org\nUnknown,unknown@example.org\nNo email,`;
    const path = `/conference-events/${events[0]}/imports`;
    const staged = await post(path, { csvText, filename: "attendees.csv" });
    expect(staged.status).toBe(200);
    expect(staged.body.rows.map((r: any) => r.matchStatus)).toEqual(["exact", "unmatched", "unmatched"]);
    expect(staged.body.rows.map((r: any) => r.disposition)).toEqual(["pending", "pending", "pending"]);
    expect((await post(path, { csvText })).body.id).toBe(staged.body.id);
    expect(await db.select().from(schema.conferenceAttendance).where(eq(schema.conferenceAttendance.conferenceEventId, events[0]))).toHaveLength(0);

    auth.current = { id: userId, role: "read_only" };
    expect((await post(`/conference-imports/${staged.body.id}/confirm`, {})).status).toBe(403);
    auth.current = { id: userId, role: "admin" };
    const confirmPath = `/conference-imports/${staged.body.id}/confirm`;
    const confirmed = await post(confirmPath, { acceptedRowIds: [staged.body.rows[0].id], rejectedRowIds: staged.body.rows.slice(1).map((row: any) => row.id) });
    expect(confirmed.body.rows.map((r: any) => r.disposition)).toEqual(["accept", "skip", "skip"]);
    expect((await post(confirmPath, {})).body.status).toBe("confirmed");
    const imported = await db.select().from(schema.conferenceAttendance).where(eq(schema.conferenceAttendance.conferenceEventId, events[0]));
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ personId: personIds[0], sourceType: "uploaded_list" });
  }, 30_000);

  it("requires one review of each email suggestion; dismissals never create attendance", async () => {
    const ids = [`${run}_dismiss`, `${run}_accept`];
    await db.insert(schema.conferenceAttendanceSuggestions).values(ids.map((id, n) => ({
      id, conferenceEventId: events[0], personId: personIds[n + 1],
      confidence: "medium" as const, evidenceNote: "CRM email mentioned the conference",
    })));
    expect((await post(`/conference-attendance-suggestions/${ids[0]}`, { status: "dismissed" }, "PATCH")).status).toBe(200);
    expect((await post(`/conference-attendance-suggestions/${ids[0]}`, { status: "accepted" }, "PATCH")).status).toBe(409);
    expect(await db.select().from(schema.conferenceAttendance).where(and(
      eq(schema.conferenceAttendance.conferenceEventId, events[0]),
      eq(schema.conferenceAttendance.personId, personIds[1]),
    ))).toHaveLength(0);
    expect((await post(`/conference-attendance-suggestions/${ids[1]}`, { status: "accepted" }, "PATCH")).status).toBe(200);
    expect((await post(`/conference-attendance-suggestions/${ids[1]}`, { status: "accepted" }, "PATCH")).status).toBe(409);
    const accepted = await db.select().from(schema.conferenceAttendance).where(and(
      eq(schema.conferenceAttendance.conferenceEventId, events[0]),
      eq(schema.conferenceAttendance.personId, personIds[2]),
    ));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ status: "likely", sourceType: "wildflower_email" });
  }, 30_000);

  it("repoints all four conference FKs and consolidates event/evidence collisions on person merge", async () => {
    await db.insert(schema.conferenceAttendance).values([
      { id: `${run}_att_primary`, conferenceEventId: events[1], personId: personIds[0], status: "possible", evidenceNote: "Primary evidence" },
      { id: `${run}_att_loser`, conferenceEventId: events[1], personId: personIds[2], status: "confirmed", sourceType: "conference_website", sourceReference: "public URL", evidenceNote: "Confirmed evidence" },
      { id: `${run}_att_other`, conferenceEventId: events[2], personId: personIds[3], status: "likely", evidenceNote: "Other event" },
    ]);
    await db.insert(schema.conferenceAttendanceSuggestions).values([
      { id: `${run}_suggest_primary`, conferenceEventId: events[1], personId: personIds[0], confidence: "low", evidenceNote: "Pending evidence" },
      { id: `${run}_suggest_loser`, conferenceEventId: events[1], personId: personIds[2], confidence: "medium", evidenceNote: "Reviewed evidence", status: "dismissed", reviewedByUserId: userId },
      { id: `${run}_suggest_other`, conferenceEventId: events[1], personId: personIds[3], emailMessageId: "other-email", confidence: "low", evidenceNote: "Other message" },
    ]);
    const batchId = `${run}_batch`;
    await db.insert(schema.conferenceImportBatches).values({ id: batchId, conferenceEventId: events[1], sourceHash: run, createdByUserId: userId });
    await db.insert(schema.conferenceImportRows).values({
      id: `${run}_row`, conferenceImportBatchId: batchId, rowNumber: 1, matchStatus: "exact",
      matchedPersonId: personIds[2], reviewedPersonId: personIds[3],
    });
    const merged = await post("/people/merge", { primaryId: personIds[0], mergeIds: [personIds[2], personIds[3]] });
    expect(merged.status).toBe(200);
    const attendance = await db.select().from(schema.conferenceAttendance).where(eq(schema.conferenceAttendance.personId, personIds[0]));
    // The earlier CSV import remains attached, plus the two merged events.
    expect(attendance).toHaveLength(3);
    expect(attendance.find((r) => r.conferenceEventId === events[1])).toMatchObject({
      status: "confirmed", sourceReference: "public URL",
    });
    expect(attendance.find((r) => r.conferenceEventId === events[1])?.evidenceNote).toContain("Primary evidence");
    const suggestions = await db.select().from(schema.conferenceAttendanceSuggestions).where(eq(schema.conferenceAttendanceSuggestions.personId, personIds[0]));
    expect(suggestions).toHaveLength(3);
    const mergedSuggestion = suggestions.find((r) => r.conferenceEventId === events[1] && r.emailMessageId === null);
    expect(mergedSuggestion).toMatchObject({ status: "dismissed" });
    expect(mergedSuggestion?.evidenceNote).toContain("Pending evidence");
    const [row] = await db.select().from(schema.conferenceImportRows).where(eq(schema.conferenceImportRows.conferenceImportBatchId, batchId));
    expect(row).toMatchObject({ matchedPersonId: personIds[0], reviewedPersonId: personIds[0] });
  }, 30_000);
});
