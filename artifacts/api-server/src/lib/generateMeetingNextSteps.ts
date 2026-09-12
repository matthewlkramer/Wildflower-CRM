import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";

const SYSTEM = `You turn a saved fundraising CRM meeting note into concrete, actionable task proposals.
Return strict JSON only: {"proposals":[{"title":"imperative task, max 160 chars","dueDate":"YYYY-MM-DD or null","description":"brief useful context"}]}.
Only propose work explicitly supported by the note. Do not invent commitments. Return at most 12 proposals.`;

export interface MeetingNextStep {
  title: string;
  dueDate: string | null;
  description: string | null;
}

export async function generateMeetingNextSteps(
  noteText: string,
): Promise<MeetingNextStep[]> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM,
      messages: [{ role: "user", content: `Saved meeting note:\n\n${noteText.slice(0, 60000)}` }],
    });
    const raw = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    const parsed = JSON.parse(raw) as { proposals?: unknown };
    if (!Array.isArray(parsed.proposals)) return [];
    return parsed.proposals.slice(0, 12).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      const title = typeof value.title === "string" ? value.title.trim() : "";
      if (!title) return [];
      const dueDate =
        typeof value.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.dueDate)
          ? value.dueDate
          : null;
      return [{
        title: title.slice(0, 160),
        dueDate,
        description:
          typeof value.description === "string" ? value.description.trim().slice(0, 1000) : null,
      }];
    });
  } catch (error) {
    logger.warn({ errClass: error instanceof Error ? error.constructor.name : typeof error }, "meeting next-step generation failed");
    throw new Error("Unable to generate next steps from this saved meeting note.");
  }
}