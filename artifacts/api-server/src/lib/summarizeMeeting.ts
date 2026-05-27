import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";

const MODEL = "claude-sonnet-4-6";
const MAX_TRANSCRIPT_CHARS = 60_000;

const SYSTEM = `You are an assistant that summarizes meeting transcripts for a fundraising CRM.

Output STRICT JSON with this exact shape and nothing else (no markdown, no code fences, no commentary):
{
  "summary": "string — 2 to 5 sentences. Focus on what the meeting was about, what was decided, and any commitments. No greetings or pleasantries.",
  "actionItems": [
    {
      "title": "string — short imperative phrasing (max ~120 chars). Start with a verb.",
      "assigneeName": "string or null — the person responsible, if explicitly named in the transcript. Use the name as it appears. null if not assigned.",
      "dueDate": "YYYY-MM-DD or null — only if an explicit calendar date is mentioned. null otherwise."
    }
  ]
}

Rules:
- Return at most 12 action items.
- If the transcript is empty or unintelligible, return {"summary": "(no summary available)", "actionItems": []}.
- Do NOT invent action items that weren't discussed.
- Do NOT include action items already framed as completed.`;

export interface MeetingSummaryActionItem {
  title: string;
  assigneeName: string | null;
  dueDate: string | null;
}

export interface MeetingSummaryResult {
  summary: string;
  actionItems: MeetingSummaryActionItem[];
}

/**
 * Summarize a pasted meeting transcript and extract structured action
 * items. Always returns SOMETHING — on model error or invalid JSON we
 * return a placeholder summary + empty action items so the meeting note
 * is still saved (the raw transcript may still be there in `full` mode).
 */
export async function summarizeMeeting(
  transcript: string,
): Promise<MeetingSummaryResult> {
  const trimmed = transcript.trim();
  if (!trimmed) {
    return { summary: "(no summary available)", actionItems: [] };
  }
  // Cap input. Anthropic context is much larger but cost/latency scale
  // with tokens, and transcripts past ~60k chars almost always have a
  // tight conclusion section at the end we don't want to truncate — so
  // take the FIRST chunk; the model has more than enough signal.
  const truncated = trimmed.slice(0, MAX_TRANSCRIPT_CHARS);
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Transcript:\n\n${truncated}`,
        },
      ],
    });
    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }
    return parseModelOutput(text);
  } catch (err) {
    // Privacy: never log the err payload directly — Anthropic SDK errors
    // can echo the prompt back, and the prompt contains the transcript.
    // Capture only the error class + message.
    logger.warn(
      { errClass: errClass(err), errMessage: errMessage(err) },
      "summarizeMeeting failed; returning placeholder",
    );
    return { summary: "(summary unavailable)", actionItems: [] };
  }
}

function errClass(err: unknown): string {
  return err && typeof err === "object" && err.constructor
    ? err.constructor.name
    : typeof err;
}
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseModelOutput(raw: string): MeetingSummaryResult {
  const text = raw.trim();
  // Strip ``` fences in case the model ignored the no-markdown instruction.
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  // Find the first balanced JSON object — defensive against the model
  // emitting a leading sentence before the JSON.
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    // Privacy: do NOT log `raw` — the model can echo transcript content
    // verbatim on a confused refusal, and transcripts may be private.
    // Log only the length so we can spot systemic parse failures.
    logger.warn(
      { rawLen: raw.length },
      "summarizeMeeting: no JSON object found in output",
    );
    return { summary: "(summary unavailable)", actionItems: [] };
  }
  const jsonSlice = stripped.slice(firstBrace, lastBrace + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (err) {
    logger.warn(
      { errClass: errClass(err), rawLen: raw.length },
      "summarizeMeeting: JSON parse failed",
    );
    return { summary: "(summary unavailable)", actionItems: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { summary: "(summary unavailable)", actionItems: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const summary = typeof obj.summary === "string" && obj.summary.trim()
    ? obj.summary.trim()
    : "(no summary available)";
  const items = Array.isArray(obj.actionItems) ? obj.actionItems : [];
  const actionItems: MeetingSummaryActionItem[] = [];
  for (const it of items.slice(0, 12)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) continue;
    const assigneeName =
      typeof o.assigneeName === "string" && o.assigneeName.trim()
        ? o.assigneeName.trim()
        : null;
    const dueDate = isISODate(o.dueDate) ? (o.dueDate as string) : null;
    actionItems.push({ title: title.slice(0, 240), assigneeName, dueDate });
  }
  return { summary: summary.slice(0, 4000), actionItems };
}

function isISODate(v: unknown): boolean {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
