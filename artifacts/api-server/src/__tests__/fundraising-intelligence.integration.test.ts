import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const databaseUrl = process.env.DATABASE_URL;
const hasDatabase =
  !!databaseUrl && !/test:test@localhost:5432\/test/.test(databaseUrl);
const run = "fundraising-intelligence-" + Date.now();
const ownerId = run + "-owner";
const readerId = run + "-reader";
const activeId = run + "-active";
const personId = run + "-person";
const recentId = run + "-recent";
const olderId = run + "-older";
const unmonitoredId = run + "-older-than-window";
const mediaUrl = "https://funder.example/announcements/" + run;
const grantId = run + "-email-lead";
const title = "Cedar" + Date.now() + " Community Learning Grant Program";
let server: Server | undefined;
let baseUrl = "";
let schema: typeof import("@workspace/db");
let eq: typeof import("drizzle-orm").eq;
let inArray: typeof import("drizzle-orm").inArray;
let organizationIds: string[] = [];
let dates: string[] = [];

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: object; headers: Record<string, string> },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = req.headers["x-read-only"]
      ? { id: readerId, role: "read_only", emailSyncMode: "summary_only" }
      : {
          id: ownerId,
          role: req.headers["x-admin"] ? "admin" : "team_member",
          emailSyncMode: "summary_only",
        };
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

vi.mock("../lib/funderCadence", async (original) => {
  const real = await original<typeof import("../lib/funderCadence")>();
  return {
    ...real,
    loadFunderTargets: async (
      ...args: Parameters<typeof real.loadFunderTargets>
    ) =>
      (await real.loadFunderTargets(...args)).filter((target) =>
        target.id.startsWith(run),
      ),
  };
});

vi.mock("../lib/summarizeMeeting", () => ({
  summarizeMeeting: async () => ({
    summary: "The group agreed to review the application.",
    actionItems: [{ title: "Check grant eligibility", dueDate: null }],
  }),
}));

async function request(
  path: string,
  method = "GET",
  data?: object,
  readOnly = false,
) {
  return fetch(baseUrl + "/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(readOnly ? { "x-read-only": "1" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
}

async function json(path: string, method = "GET", data?: object) {
  const response = await request(path, method, data);
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
}

beforeAll(async () => {
  if (!hasDatabase) return;
  schema = await import("@workspace/db");
  ({ eq, inArray } = await import("drizzle-orm"));
  const {
    db,
    users,
    organizations,
    opportunitiesAndPledges,
    giftsAndPayments,
    giftAllocations,
    fiscalYears,
    people,
  } = schema;
  const { creditedFiscalYears, developmentWeek, shiftDate } =
    await import("../lib/funderCadence");
  const { chicagoToday } = await import("../lib/effectiveProjectedCloseDate");
  const today = chicagoToday();
  dates = [developmentWeek(today), shiftDate(developmentWeek(today), 7)];
  const years = creditedFiscalYears(today);
  const staleYear = "fy" + (Number(years[3]!.slice(2)) - 1);
  await db
    .insert(fiscalYears)
    .values(
      [...years, staleYear].map((id) => ({ id, label: id.toUpperCase() })),
    )
    .onConflictDoNothing();
  await db.insert(users).values([
    {
      id: ownerId,
      clerkId: ownerId,
      email: ownerId + "@example.org",
      role: "team_member",
      emailSyncMode: "summary_only",
    },
    {
      id: readerId,
      clerkId: readerId,
      email: readerId + "@example.org",
      role: "read_only",
    },
  ]);
  organizationIds = [activeId, recentId, olderId, unmonitoredId];
  await db.insert(organizations).values(
    organizationIds.map((id) => ({
      id,
      name: id,
      ownerUserId: ownerId,
      issuesGrants: true,
    })),
  );
  await db.insert(opportunitiesAndPledges).values({
    id: run + "-open",
    organizationId: activeId,
    name: "Open proposal",
    status: "open",
    applicationDeadline: shiftDate(today, 40),
  });
  await db.insert(people).values({
    id: personId,
    fullName: "Test Individual Donor",
    ownerUserId: ownerId,
  });
  await db.insert(opportunitiesAndPledges).values({
    id: run + "-individual-open",
    individualGiverPersonId: personId,
    name: "Individual donor proposal",
    status: "open",
  });
  for (const [id, year] of [
    [recentId, years[0]!],
    [olderId, years[3]!],
    [unmonitoredId, staleYear],
  ] as const) {
    // All receipts intentionally share the same date. Allocation credit is the
    // only difference between the biweekly, monthly and unscheduled donors.
    await db
      .insert(giftsAndPayments)
      .values({ id, organizationId: id, amount: "100", dateReceived: today });
    await db
      .insert(giftAllocations)
      .values({ id, giftId: id, subAmount: "100", grantYear: year });
  }
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  baseUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  if (!hasDatabase || !schema) return;
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  const {
    db,
    developmentAgenda,
    meetingNotes,
    fundraisingFindingReviews,
    grantLeads,
    mediaMentions,
    opportunitiesAndPledges,
    giftAllocations,
    giftsAndPayments,
    organizations,
    people,
    tasks,
    users,
  } = schema;
  const notes = await db
    .select({ id: meetingNotes.id })
    .from(meetingNotes)
    .where(eq(meetingNotes.creatorUserId, ownerId));
  if (notes.length) {
    await db.delete(developmentAgenda).where(
      inArray(
        developmentAgenda.meetingId,
        notes.map((note) => note.id),
      ),
    );
    await db
      .delete(meetingNotes)
      .where(eq(meetingNotes.creatorUserId, ownerId));
  }
  await db.delete(tasks).where(eq(tasks.createdByUserId, ownerId));
  await db
    .delete(fundraisingFindingReviews)
    .where(eq(fundraisingFindingReviews.reviewedByUserId, ownerId));
  await db.delete(mediaMentions).where(eq(mediaMentions.url, mediaUrl));
  await db.delete(grantLeads).where(eq(grantLeads.id, grantId));
  await db
    .delete(opportunitiesAndPledges)
    .where(
      inArray(opportunitiesAndPledges.id, [
        run + "-open",
        run + "-individual-open",
      ]),
    );
  await db.delete(people).where(eq(people.id, personId));
  await db
    .delete(giftAllocations)
    .where(inArray(giftAllocations.id, [recentId, olderId, unmonitoredId]));
  await db
    .delete(giftsAndPayments)
    .where(inArray(giftsAndPayments.id, [recentId, olderId, unmonitoredId]));
  await db
    .delete(organizations)
    .where(inArray(organizations.id, organizationIds));
  await db.delete(users).where(inArray(users.id, [ownerId, readerId]));
}, 60_000);

describe.skipIf(!hasDatabase)(
  "funder scans and weekly development meetings",
  () => {
    it("uses the credited years, merges public and email provenance, and carries agenda work forward", async () => {
      const { loadFunderTargets, shiftDate } =
        await import("../lib/funderCadence");
      const { runDueFunderScans } = await import("../lib/funderScan");
      const { chicagoToday } =
        await import("../lib/effectiveProjectedCloseDate");
      const { buildGrantLeadDedupeKey } =
        await import("../lib/grantLeadIdentity");
      const { db, grantLeads, grantLeadSightings } = schema;
      const now = new Date();
      const today = chicagoToday(now);
      const deadline = shiftDate(today, 7);
      const targets = new Map(
        (await loadFunderTargets(now)).map((item) => [item.id, item]),
      );
      expect(targets.get(activeId)?.cadence).toBe("weekly");
      expect(targets.get(recentId)?.cadence).toBe("biweekly");
      expect(targets.get(olderId)?.cadence).toBe("monthly");
      expect(targets.has(unmonitoredId)).toBe(false);

      const emailEvidence = {
        title,
        funderName: activeId,
        deadline,
        amount: null,
        url: null,
        snippet: title,
      };
      await db.insert(grantLeads).values({
        id: grantId,
        title,
        dedupeKey: buildGrantLeadDedupeKey(emailEvidence, null),
        funderName: activeId,
      });
      await db.insert(grantLeadSightings).values({
        id: run + "-sighting",
        grantLeadId: grantId,
        mailboxUserId: ownerId,
        gmailMessageId: "message-id",
      });
      await runDueFunderScans(now, 20, async (target) => ({
        findings:
          target.searchName === activeId
            ? [
                {
                  article: {
                    url: mediaUrl,
                    title,
                    domain: "funder.example",
                    publicationDate: today,
                    language: "English",
                  },
                  category: "funding_opportunity",
                  official: true,
                  deadline,
                  summary: "Applications are open.",
                },
              ]
            : [],
        complete: target.searchName !== olderId,
      }));

      const donorSuggestions = await json(
        "/development-meetings/suggested-donors",
      );
      expect(donorSuggestions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "person",
            id: personId,
            reason: "Open opportunity or outstanding pledge",
          }),
          expect.objectContaining({ kind: "organization", id: activeId }),
        ]),
      );
      const brief = await json("/fundraising/brief?all=true");
      expect(
        brief.findings.filter(
          (finding: { id: string }) => finding.id === grantId,
        ),
      ).toHaveLength(1);
      expect(
        brief.findings.find(
          (finding: { id: string }) => finding.id === grantId,
        ),
      ).toMatchObject({ url: mediaUrl, organizationId: activeId });
      expect(
        brief.coverage.find(
          (row: { organizationId: string }) => row.organizationId === activeId,
        ),
      ).toMatchObject({ status: "updates", findingCount: 1 });
      expect(
        brief.coverage.find(
          (row: { organizationId: string }) => row.organizationId === recentId,
        ),
      ).toMatchObject({ status: "no_updates", findingCount: 0 });
      expect(
        brief.coverage.find(
          (row: { organizationId: string }) => row.organizationId === olderId,
        ),
      ).toMatchObject({ status: "partial", lastCheckedAt: null });
      const lead = await json("/grant-leads/" + grantId);
      expect(lead.publicSources).toEqual([mediaUrl]);
      expect(lead.sightingCount).toBe(1);
      const media = await json("/media-mentions?organizationId=" + activeId);
      expect(media.data).toEqual(
        expect.arrayContaining([expect.objectContaining({ url: mediaUrl })]),
      );

      const oneTime = "/fundraising/funders/" + unmonitoredId + "/request-scan";
      expect((await request(oneTime, "POST", undefined, true)).status).toBe(
        403,
      );
      expect((await request(oneTime, "POST")).status).toBe(204);
      const queued = await json("/fundraising/brief?all=true");
      expect(
        queued.coverage.find(
          (row: { organizationId: string }) =>
            row.organizationId === unmonitoredId,
        ),
      ).toMatchObject({ cadence: "as_needed", status: "pending" });
      await runDueFunderScans(
        new Date(now.getTime() + 60_000),
        20,
        async () => ({ findings: [], complete: true }),
      );
      const checked = await json("/fundraising/brief?all=true");
      expect(
        checked.coverage.find(
          (row: { organizationId: string }) =>
            row.organizationId === unmonitoredId,
        ),
      ).toMatchObject({ cadence: "as_needed", status: "no_updates" });

      const reviewPath = "/fundraising/findings/" + grantId + "/review";
      const reviewBody = { kind: "grant_lead", review: "dismissed" };
      expect((await request(reviewPath, "PUT", reviewBody, true)).status).toBe(
        403,
      );
      expect((await request(reviewPath, "PUT", reviewBody)).status).toBe(204);
      expect((await json("/fundraising/brief")).findings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: grantId })]),
      );
      expect(
        (await request(reviewPath, "PUT", { ...reviewBody, review: "useful" }))
          .status,
      ).toBe(204);

      const [first, duplicate] = await Promise.all([
        json("/development-meetings", "POST", { date: dates[0] }),
        json("/development-meetings", "POST", {
          date: shiftDate(dates[0]!, 1),
        }),
      ]);
      expect(duplicate.note.id).toBe(first.note.id);
      expect(first.agenda).toHaveLength(3);
      const path = "/development-meetings/" + first.note.id;
      const withFinding = await json(path + "/agenda", "POST", {
        findingKind: "grant_lead",
        findingId: grantId,
      });
      const item = withFinding.agenda.find(
        (row: { findingId: string }) => row.findingId === grantId,
      );
      expect(item.organizationId).toBe(activeId);
      const deduped = await json(path + "/agenda", "POST", {
        findingKind: "grant_lead",
        findingId: grantId,
      });
      expect(deduped.agenda).toHaveLength(4);
      const itemPath = path + "/agenda/" + item.id;
      const notes = {
        revision: item.revision,
        status: "deferred",
        notes: "Application timing discussed.",
        decision: "Check eligibility.",
      };
      expect((await request(itemPath, "PATCH", notes, true)).status).toBe(403);
      await json(itemPath, "PATCH", notes);
      expect((await request(itemPath, "PATCH", notes)).status).toBe(409);
      const taskRequest = {
        requestId: run + "-request",
        title: "Check grant eligibility",
        assigneeUserId: ownerId,
        dueDate: deadline,
      };
      const [task, sameTask] = await Promise.all([
        json(itemPath + "/tasks", "POST", taskRequest),
        json(itemPath + "/tasks", "POST", taskRequest),
      ]);
      expect(sameTask.id).toBe(task.id);
      expect(task).toMatchObject({
        organizationIds: [activeId],
        grantLeadIds: [grantId],
      });
      expect((await request(itemPath, "DELETE")).status).toBe(409);

      const summarized = await json(path + "/transcript", "POST", {
        transcript: "Raw material with sensitive transcript text.",
      });
      expect(summarized).toMatchObject({
        rawTranscript: null,
        actionItems: [expect.objectContaining({ title: taskRequest.title })],
      });
      const [savedNote] = await db
        .select()
        .from(schema.meetingNotes)
        .where(eq(schema.meetingNotes.id, first.note.id));
      expect(savedNote?.rawTranscript).toBeNull();

      const templateItem = first.agenda.at(-1);
      const templateTask = await json(
        path + "/agenda/" + templateItem.id + "/tasks",
        "POST",
        {
          ...taskRequest,
          requestId: run + "-template-task",
          title: "Review meeting cadence",
        },
      );
      const next = await json("/development-meetings", "POST", {
        date: dates[1],
      });
      expect(next.agenda.at(-1).tasks).toEqual([
        expect.objectContaining({ id: templateTask.id }),
      ]);
      const carry = next.agenda.find(
        (row: { carriedFromId: string }) => row.carriedFromId === item.id,
      );
      expect(carry.tasks).toEqual([
        expect.objectContaining({ id: task.id, status: "open" }),
      ]);
      const history = await json(
        "/development-meetings?organizationId=" + activeId,
      );
      expect(
        history.map((row: { note: { id: string } }) => row.note.id),
      ).toEqual([next.note.id, first.note.id]);
      expect(
        history[1].agenda.find((row: { id: string }) => row.id === item.id)
          .decision,
      ).toBe("Check eligibility.");

      const mergeResponse = await fetch(baseUrl + "/api/organizations/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin": "1" },
        body: JSON.stringify({ primaryId: recentId, mergeIds: [activeId] }),
      });
      expect(mergeResponse.status, await mergeResponse.text()).toBe(200);
      const mergedHistory = await json(
        "/development-meetings?organizationId=" + recentId,
      );
      expect(mergedHistory).toHaveLength(2);
      expect(mergedHistory[1].note.organizationIds).toEqual([recentId]);
      expect((await json("/grant-leads/" + grantId)).targetOrganizationId).toBe(
        recentId,
      );
      const mergedBrief = await json("/fundraising/brief?all=true");
      expect(
        mergedBrief.coverage.filter((row: { organizationId: string }) =>
          [activeId, recentId].includes(row.organizationId),
        ),
      ).toHaveLength(1);
    });
  },
);
