import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
const RUN = `calendar_bootstrap_${Date.now()}`;
const list = vi.hoisted(() => vi.fn());
vi.mock("../lib/gcal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/gcal")>()),
  listEvents: list,
}));
vi.mock("../lib/googleTokenStore", () => ({
  getValidGoogleAccessTokenForUser: async (userId: string) => ({
    userId,
    accessToken: "test",
    email: "calendar@example.test",
  }),
}));
vi.mock("../lib/calendarMeetingFilter", () => ({
  loadMeetingFilterConfig: async () => ({
    titlePatterns: [],
    attendeeCountCutoff: 20,
  }),
  shouldSuppressMeeting: () => false,
}));
let schema: typeof import("@workspace/db");
beforeAll(async () => {
  schema = await import("@workspace/db");
  await schema.db
    .insert(schema.users)
    .values({ id: RUN, clerkId: RUN, email: `${RUN}@example.test` });
});
afterEach(() => list.mockReset());
afterAll(async () => {
  if (schema)
    await schema.db.delete(schema.users).where(eq(schema.users.id, RUN));
});
describe("calendar bootstrap progress", () => {
  it("restarts a legacy infinite cursor then resumes a fixed window and marks completion", async () => {
    await schema.db
      .insert(schema.calendarSyncState)
      .values({ calendarUserId: RUN, bootstrapPageToken: "legacy-unbounded" });
    list.mockImplementation(async (_token, _calendar, opts) => ({
      items: [],
      nextPageToken:
        opts.pageToken === "page-6"
          ? undefined
          : `page-${Number((opts.pageToken ?? "page-0").split("-")[1]) + 1}`,
      nextSyncToken: opts.pageToken === "page-6" ? "complete-sync" : undefined,
    }));
    const { syncUserCalendar } = await import("../lib/calendarSync");
    const first = await syncUserCalendar(RUN);
    expect(first.ok).toBe(true);
    expect(first.report?.bootstrapCompleted).toBe(false);
    expect(list.mock.calls[0][2].pageToken).toBeNull();
    const bounds = list.mock.calls.map((call) => call[2].timeMax);
    expect(bounds[0]).toMatch(/^\d{4}-/);
    const second = await syncUserCalendar(RUN);
    expect(second.report?.bootstrapCompleted).toBe(true);
    expect(new Set(list.mock.calls.map((call) => call[2].timeMax)).size).toBe(
      1,
    );
    const [state] = await schema.db
      .select()
      .from(schema.calendarSyncState)
      .where(eq(schema.calendarSyncState.calendarUserId, RUN));
    expect(state.bootstrapCompletedAt).toBeInstanceOf(Date);
    expect(state.bootstrapPageToken).toBeNull();
    expect(state.syncToken).toBe("complete-sync");
  });
});
