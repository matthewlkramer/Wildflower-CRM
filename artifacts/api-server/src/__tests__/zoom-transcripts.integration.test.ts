import { db } from "@workspace/db";
import {
  calendarEvents,
  emails,
  meetingNotes,
  organizations,
  users,
  zoomTranscriptJobs,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  enqueueZoomMeetingEvent,
  runZoomTranscriptJobs,
} from "../lib/zoomTranscripts";
import { createDevelopmentMeeting } from "../lib/developmentMeetings";
import { chicagoToday } from "../lib/effectiveProjectedCloseDate";

const zoom = vi.hoisted(() => ({
  start: vi.fn(async (_id: string) => {}),
  download: vi.fn(
    async (_uuid: string) =>
      "00:00:00.000 --> 00:00:03.000\nSend the proposal Friday.",
  ),
}));
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));
vi.mock("../lib/zoomClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/zoomClient")>()),
  zoomCaptureAccount: () => ({ accountId: "test-account" }),
  startZoomTranscript: zoom.start,
  downloadZoomTranscript: zoom.download,
}));
vi.mock("../lib/summarizeMeeting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/summarizeMeeting")>()),
  summarizeMeeting: async () => ({
    summary: "The donor asked for a proposal.",
    actionItems: [
      { title: "Send the proposal", assigneeName: null, dueDate: null },
    ],
  }),
}));

const runId = "zoom-tests-" + process.pid;
const hostEmail = runId + "@wildflowers.example";
const donorEmail = runId + "@donors.example";
const meetingId = "12345678901";
const hostId = "test-host";

function deliver(event: string, object: Record<string, unknown>) {
  return enqueueZoomMeetingEvent(
    event,
    { account_id: "test-account", object },
    Date.now(),
  );
}
function started(uuid: string) {
  return deliver("meeting.started", {
    uuid,
    id: meetingId,
    type: 2,
    host_id: hostId,
    host_email: hostEmail,
  });
}
function ready(uuid: string) {
  return deliver("meeting.aic_transcript_completed", {
    meeting_uuid: uuid,
    meeting_id: Number(meetingId),
    host_id: hostId,
    attach_type: "durable_transcript",
  });
}
async function insertInvite(isPrivate: boolean) {
  await db.insert(calendarEvents).values({
    id: runId,
    calendarUserId: runId,
    gcalCalendarId: "primary",
    gcalEventId: runId,
    startAt: new Date(),
    status: "confirmed",
    isPrivate,
    attendeeEmails: [donorEmail],
    location: "https://zoom.us/j/" + meetingId,
    summary: "Donor conversation",
  });
}
const savedNotes = () =>
  db.select().from(meetingNotes).where(eq(meetingNotes.creatorUserId, runId));

beforeEach(async () => {
  vi.clearAllMocks();
  await db
    .insert(users)
    .values({ id: runId, email: hostEmail, clerkId: runId });
  await db
    .insert(organizations)
    .values({ id: runId, name: "Test funder", issuesGrants: true });
  await db
    .insert(emails)
    .values({ id: runId, email: donorEmail, organizationId: runId });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.delete(meetingNotes).where(eq(meetingNotes.creatorUserId, runId));
  await db.delete(users).where(eq(users.id, runId));
  await db.delete(organizations).where(eq(organizations.id, runId));
});

it("captures a matched donor call and imports one note despite a replayed event", async () => {
  await insertInvite(false);
  await started("test-donor");
  await runZoomTranscriptJobs();
  expect(zoom.start).toHaveBeenCalledExactlyOnceWith(meetingId);
  await ready("test-donor");
  await runZoomTranscriptJobs();
  await ready("test-donor");
  await runZoomTranscriptJobs();
  expect(zoom.download).toHaveBeenCalledExactlyOnceWith("test-donor");
  const notes = await savedNotes();
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    calendarEventId: runId,
    organizationIds: [runId],
    aiSummary: "The donor asked for a proposal.",
  });
  expect(notes[0]?.rawTranscript).toContain("Send the proposal Friday.");
});

it("leaves a private invitation and unrecognized transcript outside the workflow", async () => {
  await insertInvite(true);
  await started("test-private");
  await runZoomTranscriptJobs();
  await ready("test-private");
  await ready("test-unrecognized");
  await runZoomTranscriptJobs();
  expect(zoom.start).not.toHaveBeenCalled();
  expect(zoom.download).not.toHaveBeenCalled();
  expect(await savedNotes()).toHaveLength(0);
});

it("adds drafts to the existing weekly agenda, preserving staff notes and summary-only mode", async () => {
  vi.stubEnv(
    "ZOOM_FORWFCRM_DEVELOPMENT_MEETING_IDS",
    "12345678902, " + meetingId,
  );
  await db
    .update(users)
    .set({ emailSyncMode: "summary_only" })
    .where(eq(users.id, runId));
  const agendaId = await createDevelopmentMeeting(chicagoToday(), runId, true);
  await db
    .update(meetingNotes)
    .set({ manualNotes: "Staff notes" })
    .where(eq(meetingNotes.id, agendaId));
  await started("test-weekly");
  await runZoomTranscriptJobs();
  await ready("test-weekly");
  await runZoomTranscriptJobs();
  expect(await savedNotes()).toMatchObject([
    {
      id: agendaId,
      manualNotes: "Staff notes",
      rawTranscript: null,
      summaryOnly: true,
      actionItems: [{ title: "Send the proposal" }],
    },
  ]);
  const [job] = await db
    .select()
    .from(zoomTranscriptJobs)
    .where(eq(zoomTranscriptJobs.uuid, "test-weekly"));
  expect(job?.outcome).toBe("imported");
});
