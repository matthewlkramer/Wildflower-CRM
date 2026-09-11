import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `calendar_no_notes_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const OTHER_USER_ID = `${RUN}_other`;
const EVENT_ID = `${RUN}_event`;
const EVENT_COPY_ID = `${RUN}_event_copy`;
const CONTROL_EVENT_ID = `${RUN}_control`;
const PRIVATE_EVENT_ID = `${RUN}_private`;
const PHYSICAL_EVENT_ID = `${RUN}_physical`;
const BLANK_EVENT_A_ID = `${RUN}_blank_a`;
const BLANK_EVENT_B_ID = `${RUN}_blank_b`;
const BLANK_NOTE_ID = `${RUN}_blank_note`;

const { currentUser } = vi.hoisted(() => ({
  currentUser: { id: "", role: "team_member" as string },
}));
currentUser.id = USER_ID;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { ...currentUser };
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

let db: (typeof import("@workspace/db"))["db"];
let schema: typeof import("@workspace/db");
let drizzle: typeof import("drizzle-orm");
let server: Server;
let baseUrl = "";

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  return {
    status: response.status,
    json: response.status === 204 ? null : await response.json(),
  };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  db = schema.db;
  drizzle = await import("drizzle-orm");
  await db.insert(schema.users).values([
    {
      id: USER_ID,
      clerkId: `clerk_${USER_ID}`,
      email: `${USER_ID}@wildflowerschools.org`,
      displayName: "Calendar User",
      role: "team_member",
    },
    {
      id: OTHER_USER_ID,
      clerkId: `clerk_${OTHER_USER_ID}`,
      email: `${OTHER_USER_ID}@wildflowerschools.org`,
      displayName: "Other Calendar User",
      role: "team_member",
    },
  ]);
  const startAt = new Date("2026-08-15T15:00:00.000Z");
  await db.insert(schema.calendarEvents).values([
    {
      id: EVENT_ID,
      calendarUserId: USER_ID,
      gcalCalendarId: "primary",
      gcalEventId: PHYSICAL_EVENT_ID,
      startAt,
      summary: `Dismiss me ${RUN}`,
      isPrivate: false,
    },
    {
      id: EVENT_COPY_ID,
      calendarUserId: OTHER_USER_ID,
      gcalCalendarId: "primary",
      gcalEventId: PHYSICAL_EVENT_ID,
      startAt,
      summary: `Dismiss me ${RUN}`,
      isPrivate: false,
    },
    {
      id: CONTROL_EVENT_ID,
      calendarUserId: USER_ID,
      gcalCalendarId: "primary",
      gcalEventId: `${RUN}_control_physical`,
      startAt,
      summary: `Keep me ${RUN}`,
      isPrivate: false,
    },
    {
      id: PRIVATE_EVENT_ID,
      calendarUserId: OTHER_USER_ID,
      gcalCalendarId: "primary",
      gcalEventId: `${RUN}_private_physical`,
      startAt,
      summary: `Private ${RUN}`,
      isPrivate: true,
    },
    {
      id: BLANK_EVENT_A_ID,
      calendarUserId: USER_ID,
      gcalCalendarId: "legacy-a",
      gcalEventId: "",
      startAt,
      summary: `Legacy A ${RUN}`,
      isPrivate: false,
    },
    {
      id: BLANK_EVENT_B_ID,
      calendarUserId: OTHER_USER_ID,
      gcalCalendarId: "legacy-b",
      gcalEventId: "",
      startAt,
      summary: `Legacy B ${RUN}`,
      isPrivate: false,
    },
  ]);
  await db.insert(schema.notes).values({
    id: BLANK_NOTE_ID,
    body: `Only legacy A has notes ${RUN}`,
    authorUserId: USER_ID,
    calendarEventId: BLANK_EVENT_A_ID,
  });
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const dismissals = await db
    .select({ id: schema.meetingNoteDismissals.id })
    .from(schema.meetingNoteDismissals)
    .where(
      drizzle.eq(schema.meetingNoteDismissals.gcalEventId, PHYSICAL_EVENT_ID),
    );
  if (dismissals.length > 0) {
    await db.delete(schema.auditLog).where(
      drizzle.inArray(
        schema.auditLog.entityId,
        dismissals.map((row) => row.id),
      ),
    );
  }
  await db
    .delete(schema.meetingNoteDismissals)
    .where(
      drizzle.eq(schema.meetingNoteDismissals.gcalEventId, PHYSICAL_EVENT_ID),
    );
  await db
    .delete(schema.notes)
    .where(drizzle.eq(schema.notes.id, BLANK_NOTE_ID));
  await db
    .delete(schema.calendarEvents)
    .where(
      drizzle.inArray(schema.calendarEvents.id, [
        EVENT_ID,
        EVENT_COPY_ID,
        CONTROL_EVENT_ID,
        PRIVATE_EVENT_ID,
        BLANK_EVENT_A_ID,
        BLANK_EVENT_B_ID,
      ]),
    );
  await db
    .delete(schema.users)
    .where(drizzle.inArray(schema.users.id, [USER_ID, OTHER_USER_ID]));
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60_000);

describe.skipIf(!HAS_DB)("calendar event No notes action", () => {
  it("keeps unrelated legacy events with blank Google ids separate", async () => {
    const events = await request(
      `/api/calendar-events?search=${encodeURIComponent(RUN)}&limit=20`,
    );
    expect(events.status).toBe(200);
    const legacyA = events.json.data.find(
      (event: { id: string }) => event.id === BLANK_EVENT_A_ID,
    );
    const legacyB = events.json.data.find(
      (event: { id: string }) => event.id === BLANK_EVENT_B_ID,
    );
    expect(legacyA).toMatchObject({
      hasMeetingNotes: true,
      hasNextSteps: false,
      linkedNoteCount: 1,
    });
    expect(legacyB).toMatchObject({
      hasMeetingNotes: false,
      hasNextSteps: false,
      linkedNoteCount: 0,
    });

    const notesForA = await request(
      `/api/notes?calendarEventId=${BLANK_EVENT_A_ID}&limit=20`,
    );
    const notesForB = await request(
      `/api/notes?calendarEventId=${BLANK_EVENT_B_ID}&limit=20`,
    );
    expect(notesForA.json.data.map((note: { id: string }) => note.id)).toContain(
      BLANK_NOTE_ID,
    );
    expect(notesForB.json.data.map((note: { id: string }) => note.id)).not.toContain(
      BLANK_NOTE_ID,
    );
  });

  it("durably hides every synced copy from the notes queue", async () => {
    const before = await request(
      `/api/calendar-events?search=${encodeURIComponent(RUN)}&excludeNotesNotNeeded=true&limit=20`,
    );
    expect(before.status).toBe(200);
    expect(
      before.json.data.map(
        (event: { gcalEventId: string }) => event.gcalEventId,
      ),
    ).toEqual(
      expect.arrayContaining([PHYSICAL_EVENT_ID, `${RUN}_control_physical`]),
    );

    expect(
      (
        await request(`/api/calendar-events/${EVENT_ID}/no-notes`, {
          method: "POST",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await request(`/api/calendar-events/${EVENT_COPY_ID}/no-notes`, {
          method: "POST",
        })
      ).status,
    ).toBe(204);

    const dismissalRows = await db
      .select()
      .from(schema.meetingNoteDismissals)
      .where(
        drizzle.eq(schema.meetingNoteDismissals.gcalEventId, PHYSICAL_EVENT_ID),
      );
    expect(dismissalRows).toHaveLength(1);
    expect(dismissalRows[0]?.dismissedByUserId).toBe(USER_ID);

    const queue = await request(
      `/api/calendar-events?search=${encodeURIComponent(RUN)}&excludeNotesNotNeeded=true&limit=20`,
    );
    expect(queue.status).toBe(200);
    expect(queue.json.data.map((event: { id: string }) => event.id)).toEqual([
      CONTROL_EVENT_ID,
    ]);

    const evidence = await request(
      `/api/calendar-events?search=${encodeURIComponent(RUN)}&limit=20`,
    );
    expect(evidence.status).toBe(200);
    expect(
      evidence.json.data.some(
        (event: { gcalEventId: string }) =>
          event.gcalEventId === PHYSICAL_EVENT_ID,
      ),
    ).toBe(true);
  });

  it("cannot dismiss a private event owned by another user", async () => {
    const response = await request(
      `/api/calendar-events/${PRIVATE_EVENT_ID}/no-notes`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });
});
