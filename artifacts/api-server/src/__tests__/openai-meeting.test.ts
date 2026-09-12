import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { File } from "@google-cloud/storage";
import {
  draftMeetingFollowUp,
  ocrHandwrittenNotes,
  transcribeMeetingAudio,
} from "../lib/openaiMeeting";

function storedFile(contents: string): File {
  return {
    download: vi.fn().mockResolvedValue([Buffer.from(contents)]),
  } as unknown as File;
}

describe("OpenAI meeting helpers", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it("sends a private note image to the Responses API and returns its transcription", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ output_text: "- Call Jordan\n- Send budget" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const transcript = await ocrHandwrittenNotes({
      file: storedFile("image bytes"),
      mimeType: "image/jpeg",
      sizeBytes: 11,
    });

    expect(transcript).toBe("- Call Jordan\n- Send budget");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(request.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(String(request.body)).toContain("data:image/jpeg;base64,");
  });

  it("uploads the recording as multipart audio and returns its transcript", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "We agreed to reconnect in October." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const transcript = await transcribeMeetingAudio({
      file: storedFile("audio bytes"),
      fileName: "meeting.webm",
      mimeType: "audio/webm",
      sizeBytes: 11,
    });

    expect(transcript).toBe("We agreed to reconnect in October.");
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(request.body).toBeInstanceOf(FormData);
  });

  it("parses a structured follow-up draft without inventing transport behavior", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            output_text:
              '```json\n{"subject":"Thank you","body":"Thanks for the conversation."}\n```',
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(
      draftMeetingFollowUp({
        meetingTitle: "Conversation with Jordan",
        meetingDate: "2026-09-12",
        notes: "Discussed a possible introduction.",
      }),
    ).resolves.toEqual({
      subject: "Thank you",
      body: "Thanks for the conversation.",
    });
  });

  it("rejects unsupported files before calling OpenAI", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ocrHandwrittenNotes({
        file: storedFile("text"),
        mimeType: "text/plain",
        sizeBytes: 4,
      }),
    ).rejects.toThrow("must be an image");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
