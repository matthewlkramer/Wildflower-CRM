import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";

const MODEL = "claude-sonnet-4-6";

const SYSTEM = `You write one-sentence topic summaries of emails for a CRM.

Rules:
- Output EXACTLY one sentence, max 25 words.
- Say what the email is ABOUT (topic + intent), not what it literally says.
- Do NOT quote the body. Do NOT include names of attached files.
- Do NOT include amounts, dates, phone numbers, addresses, or other PII
  from the body — only the subject line itself may be referenced.
- No greetings, no sign-offs, no "this email" / "the sender".
- If the email is empty or unintelligible, output: "(no summary available)".`;

interface SummarizeInput {
  subject: string | null;
  fromEmail: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
}

/**
 * Produce a one-line topic summary of an email. Used only when the
 * mailbox owner has opted into `summary_only` mode — we summarize once
 * during sync and then drop the body forever. If summarization fails
 * we still drop the body (privacy wins over richness) and store a
 * placeholder so the UI shows something sensible.
 */
export async function summarizeEmail(input: SummarizeInput): Promise<string> {
  const body = (input.bodyText ?? stripHtml(input.bodyHtml) ?? "").trim();
  if (!body && !input.subject) return "(no summary available)";
  // Cap input to keep cost + latency bounded; one-line summary doesn't
  // need the whole thread.
  const truncated = body.slice(0, 8000);
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `Subject: ${input.subject ?? "(none)"}`,
            `From: ${input.fromEmail ?? "(unknown)"}`,
            "",
            "Body:",
            truncated || "(empty)",
          ].join("\n"),
        },
      ],
    });
    for (const block of response.content) {
      if (block.type === "text") {
        const text = block.text.trim();
        if (text) return clampSummary(text);
      }
    }
    return "(no summary available)";
  } catch (err) {
    logger.warn({ err }, "summarizeEmail failed; storing placeholder");
    return "(summary unavailable)";
  }
}

// Defense-in-depth guardrail on the model output. The prompt asks for
// one sentence with no PII; this trims to the first sentence and caps
// the total length so a prompt-deviating response can never spill more
// than ~250 chars of body-derived content into ai_summary.
function clampSummary(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const firstSentence = oneLine.match(/^[^.!?\n]{1,250}[.!?]?/);
  const chosen = (firstSentence?.[0] ?? oneLine).trim();
  return chosen.length > 250 ? chosen.slice(0, 247) + "..." : chosen;
}

function stripHtml(html: string | null): string | null {
  if (!html) return null;
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}
