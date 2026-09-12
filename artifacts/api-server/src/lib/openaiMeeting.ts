import type { File } from "@google-cloud/storage";
import { logger } from "./logger";

const DEFAULT_TEXT_MODEL = "gpt-5-mini";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function config() {
  const apiKey =
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim();
  const baseURL = (
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  if (!apiKey) throw new Error("OpenAI is not configured.");
  return { apiKey, baseURL };
}

async function openAIRequest(
  path: string,
  init: RequestInit,
): Promise<Response> {
  const { apiKey, baseURL } = config();
  const response = await fetch(`${baseURL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    logger.warn(
      { status: response.status, path },
      "OpenAI meeting request failed",
    );
    throw new Error("OpenAI could not process this meeting content.");
  }
  return response;
}

function outputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const value = payload as Record<string, unknown>;
  if (typeof value.output_text === "string") return value.output_text.trim();
  if (!Array.isArray(value.output)) return "";
  const chunks: string[] = [];
  for (const item of value.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string") chunks.push(text);
    }
  }
  return chunks.join("\n").trim();
}

export async function ocrHandwrittenNotes(args: {
  file: File;
  mimeType: string;
  sizeBytes: number;
}): Promise<string> {
  if (!args.mimeType.startsWith("image/")) {
    throw new Error("Handwritten notes must be an image.");
  }
  if (args.sizeBytes > MAX_IMAGE_BYTES) {
    throw new Error("Handwritten-note images must be 20 MB or smaller.");
  }
  const [bytes] = await args.file.download();
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("Handwritten-note images must be 20 MB or smaller.");
  }
  const dataUrl = `data:${args.mimeType};base64,${bytes.toString("base64")}`;
  const response = await openAIRequest("/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MEETING_TEXT_MODEL ?? DEFAULT_TEXT_MODEL,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Transcribe these handwritten meeting notes faithfully. Preserve headings, bullets, names, amounts, dates, uncertainties, and illegible portions. Mark uncertain text with [unclear]. Return only the transcription, without commentary.",
            },
            { type: "input_image", image_url: dataUrl, detail: "high" },
          ],
        },
      ],
    }),
  });
  const text = outputText(await response.json());
  if (!text) throw new Error("OpenAI returned an empty transcription.");
  return text.slice(0, 100_000);
}

export async function transcribeMeetingAudio(args: {
  file: File;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<string> {
  if (!args.mimeType.startsWith("audio/") && args.mimeType !== "video/webm") {
    throw new Error("Meeting recordings must be an audio or WebM file.");
  }
  if (args.sizeBytes > MAX_AUDIO_BYTES) {
    throw new Error("Meeting recordings must be 25 MB or smaller.");
  }
  const [bytes] = await args.file.download();
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new Error("Meeting recordings must be 25 MB or smaller.");
  }
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: args.mimeType }),
    args.fileName || "meeting.webm",
  );
  form.append(
    "model",
    process.env.OPENAI_TRANSCRIPTION_MODEL ?? DEFAULT_TRANSCRIPTION_MODEL,
  );
  form.append("response_format", "json");
  const response = await openAIRequest("/audio/transcriptions", {
    method: "POST",
    body: form,
  });
  const payload = (await response.json()) as { text?: unknown };
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) throw new Error("OpenAI returned an empty transcription.");
  return text.slice(0, 200_000);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) return {};
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function draftMeetingFollowUp(args: {
  meetingTitle: string;
  meetingDate: string;
  notes: string;
}): Promise<{ subject: string; body: string }> {
  const response = await openAIRequest("/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MEETING_TEXT_MODEL ?? DEFAULT_TEXT_MODEL,
      input: `Draft a warm, concise fundraising follow-up email from the Wildflower staff member who attended this meeting. Use only the facts below. Mention concrete commitments or next steps only when supported. Do not invent names, dates, promises, or amounts. Return strict JSON: {"subject":"...","body":"..."}. Do not include a greeting name if the recipient name is uncertain, and do not add a signature.\n\nMeeting: ${args.meetingTitle}\nDate: ${args.meetingDate}\n\nSaved meeting content:\n${args.notes.slice(0, 80_000)}`,
    }),
  });
  const parsed = parseJsonObject(outputText(await response.json()));
  const subject =
    typeof parsed.subject === "string" && parsed.subject.trim()
      ? parsed.subject.trim().slice(0, 180)
      : `Following up on ${args.meetingTitle}`;
  const body =
    typeof parsed.body === "string" && parsed.body.trim()
      ? parsed.body.trim().slice(0, 20_000)
      : "Thank you for meeting with us. I wanted to follow up on our conversation.";
  return { subject, body };
}
