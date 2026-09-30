import { afterEach, describe, expect, it, vi } from "vitest";
import { listEvents } from "../lib/gcal";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google Calendar address search", () => {
  it("passes an exact contact address through the Calendar q parameter", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listEvents("token", "primary", {
      timeMin: "1970-01-01T00:00:00Z",
      query: "melissa@example.com",
    });

    const requestedUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestedUrl).toContain("q=melissa%40example.com");
    expect(requestedUrl).toContain("timeMin=1970-01-01T00%3A00%3A00Z");
  });
});
