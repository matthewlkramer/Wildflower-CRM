import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("ZOOM_FORWFCRM_TRANSCRIPTS_ENABLED", "true");
  vi.stubEnv("ZOOM_FORWFCRM_ACCOUNT_ID", "test-account");
  vi.stubEnv("ZOOM_FORWFCRM_CLIENT_ID", "test-client");
  vi.stubEnv("ZOOM_FORWFCRM_CLIENT_SECRET", "test-secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("starts Meeting Summary with text retention", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ access_token: "fake-token", expires_in: 3600 }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetch);
  const { startZoomTranscript } = await import("./zoomClient");
  await startZoomTranscript("12345678901");
  const [url, init] = fetch.mock.calls[1]!;
  expect(url).toBe("https://api.zoom.us/v2/live_meetings/12345678901/events");
  expect(JSON.parse(init.body)).toEqual({
    method: "ai_companion.start",
    params: { ai_companion_mode: "summary", retain_meeting_transcript: true },
  });
});

it("looks up the exact occurrence and keeps Zoom credentials off a signed storage redirect", async () => {
  const zoomUrl =
    "https://us02web.zoom.us/rec/meeting/transcript/download/test";
  const storageUrl =
    "https://bucket.s3.us-east-1.amazonaws.com/text.vtt?X-Amz-Signature=fake";
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ access_token: "fake-token", expires_in: 3600 }),
    )
    .mockResolvedValueOnce(
      Response.json({ can_download: true, download_url: zoomUrl }),
    )
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: storageUrl } }),
    )
    .mockResolvedValueOnce(
      new Response("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello"),
    );
  vi.stubGlobal("fetch", fetch);
  const { downloadZoomTranscript } = await import("./zoomClient");
  expect(await downloadZoomTranscript("/t//x=")).toBe(
    "00:00:00.000 --> 00:00:01.000\nHello",
  );
  expect(fetch.mock.calls[1]![0]).toBe(
    "https://api.zoom.us/v2/meetings/%252Ft%252F%252Fx%253D/transcript",
  );
  expect(fetch.mock.calls[2]![1].headers.Authorization).toBe(
    "Bearer fake-token",
  );
  expect(fetch.mock.calls[3]![0].href).toBe(storageUrl);
  expect(fetch.mock.calls[3]![1].headers).toBeUndefined();
});
