import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@workspace/db", () => ({ db: {} }));
vi.mock("../lib/taskSuggestionQueue", () => ({
  enqueueMatchedSignal: vi.fn(),
}));
import { calendarBootstrapEnd } from "../lib/calendarSync";
import { listEvents, CalendarPageTokenInvalidError } from "../lib/gcal";
afterEach(() => vi.unstubAllGlobals());
describe("finite calendar bootstrap", () => {
  it("keeps the same finite horizon across resumed pages", async () => {
    const anchor = new Date("2026-09-01T12:00:00Z");
    const end = calendarBootstrapEnd(anchor).toISOString();
    expect(end).toBe("2027-09-01T12:00:00.000Z");
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response('{"items":[],"nextPageToken":"next"}')),
      );
    vi.stubGlobal("fetch", fetch);
    await listEvents("test", "primary", {
      timeMin: "1970-01-01T00:00:00Z",
      timeMax: end,
    });
    await listEvents("test", "primary", {
      timeMin: "1970-01-01T00:00:00Z",
      timeMax: end,
      pageToken: "next",
    });
    for (const [url] of fetch.mock.calls)
      expect(new URL(url).searchParams.get("timeMax")).toBe(end);
  });
  it("identifies invalid legacy page tokens so they can safely restart", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"error":{"message":"Invalid page token value."}}', {
            status: 400,
          }),
        ),
    );
    await expect(
      listEvents("test", "primary", { pageToken: "old" }),
    ).rejects.toBeInstanceOf(CalendarPageTokenInvalidError);
  });
});
