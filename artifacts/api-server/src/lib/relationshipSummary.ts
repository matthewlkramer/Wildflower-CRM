import { anthropic, withRateLimitRetry } from "@workspace/integrations-anthropic-ai";
import { aiProposalLimit } from "./aiConcurrency";
import { gatherTaskSignals, type TaskSignals } from "./gatherTaskSignals";
import { logger } from "./logger";

const MODEL = "claude-sonnet-4-6";

/**
 * On-demand "where this relationship stands" snapshot for a donor detail
 * page. Computed fresh from the same read-only signal bundle the task
 * intelligence uses (recent gifts, open opportunities, notes, meetings,
 * emails, media) and NEVER persisted — the page shows it, the user reads
 * it, done.
 *
 * Resilience rules (same as the other AI paths):
 *   - route the call through `aiProposalLimit` (global concurrency cap)
 *   - wrap it in `withRateLimitRetry` and set the SDK's `maxRetries: 0`
 *   - never throw: on any failure return the "(no summary available)"
 *     placeholder so the page renders unaffected
 *   - privacy: never log the prompt or the raw error payload (SDK errors
 *     can echo the prompt back); log only the error class + message.
 */

const SYSTEM = `You are a fundraising-CRM assistant for Wildflower Schools. Given a relationship snapshot for ONE donor or prospect (a person or an organization), write a short "where this relationship stands" briefing for the fundraiser opening the record.

Output STRICT JSON with this exact shape and nothing else (no markdown, no code fences, no commentary):
{
  "summary": "string — 2 to 4 plain sentences."
}

Rules:
- Lead with the current state: active pledge awaiting payment, open ask in progress, recently gave, long-lapsed, brand-new prospect, etc.
- Ground every claim in the snapshot (a dated gift, an open opportunity and its stage, the last-contacted date, a recent meeting or email). Never invent facts, amounts, or interactions not present in the data.
- Mention the single most pressing thing to know or do next if one clearly stands out (an application deadline, a payment that hasn't arrived, a long silence after a gift). Do not force a next step when nothing stands out.
- Plain prose, no bullet points, no greetings, no headers. Refer to the donor by name.
- If the snapshot shows essentially no activity (no gifts, no opportunities, no notes/meetings/emails), say plainly that the relationship is new/quiet with no recorded activity yet.`;

export interface RelationshipSummaryResult {
  summary: string;
  generatedAt: string;
}

const PLACEHOLDER = "(no summary available)";

function fmtSignals(signals: TaskSignals): string {
  const e = signals.entity;
  const lines: string[] = [];
  lines.push(`TODAY'S DATE: ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push(`ENTITY: ${e.kind} — ${e.name ?? "(unnamed)"}`);
  if (e.kind === "organization")
    lines.push(`  Grant-maker: ${e.issuesGrants ? "yes" : "no"}`);
  lines.push(`  Priority: ${e.priority ?? "(unset)"}`);
  lines.push(`  Capacity rating: ${e.capacityRating ?? "(unset)"}`);
  lines.push(`  Connection status: ${e.connectionStatus ?? "(unset)"}`);
  lines.push(`  Enthusiasm: ${e.enthusiasm ?? "(unset)"}`);
  lines.push(`  Last contacted: ${e.lastContacted ?? "(unknown)"}`);
  lines.push(`  Interaction count: ${e.interactionCount ?? "(unknown)"}`);
  lines.push("");

  lines.push("RECENT GIFTS / PAYMENTS:");
  if (signals.recentGifts.length === 0) lines.push("  (none)");
  for (const g of signals.recentGifts)
    lines.push(
      `  - ${g.date ?? "?"}: ${g.amount ?? "?"} ${g.type ?? ""} ${g.name ? `(${g.name})` : ""}`.trimEnd(),
    );
  lines.push("");

  lines.push("OPEN / RECENT OPPORTUNITIES & PLEDGES:");
  if (signals.openOpportunities.length === 0) lines.push("  (none)");
  for (const o of signals.openOpportunities)
    lines.push(
      `  - ${o.name ?? "(unnamed)"} [status=${o.status ?? "?"}, stage=${o.stage ?? "?"}] ask=${o.askAmount ?? "?"} awarded=${o.awardedAmount ?? "?"} projectedClose=${o.projectedCloseDate ?? "?"} deadline=${o.applicationDeadline ?? "?"}`,
    );
  lines.push("");

  lines.push("RECENT NOTES:");
  if (signals.recentNotes.length === 0) lines.push("  (none)");
  for (const n of signals.recentNotes)
    lines.push(`  - ${n.date ?? "?"}: ${n.body}`);
  lines.push("");

  lines.push("RECENT MEETINGS:");
  if (signals.recentMeetings.length === 0) lines.push("  (none)");
  for (const m of signals.recentMeetings)
    lines.push(
      `  - ${m.date ?? "?"}: ${m.title ?? "(untitled)"}${m.summary ? ` — ${m.summary}` : ""}`,
    );
  lines.push("");

  lines.push("RECENT CALENDAR EVENTS:");
  if (signals.recentCalendarEvents.length === 0) lines.push("  (none)");
  for (const c of signals.recentCalendarEvents)
    lines.push(`  - ${c.date ?? "?"}: ${c.summary ?? "(no title)"}`);
  lines.push("");

  lines.push("RECENT EMAILS:");
  if (signals.recentEmails.length === 0) lines.push("  (none)");
  for (const em of signals.recentEmails)
    lines.push(`  - ${em.date ?? "?"}: ${em.subject ?? "(no subject)"}`);
  lines.push("");

  lines.push("RECENT MEDIA MENTIONS:");
  if (signals.recentMediaMentions.length === 0) lines.push("  (none)");
  for (const md of signals.recentMediaMentions)
    lines.push(
      `  - ${md.date ?? "?"}: ${md.title ?? "(untitled)"} — ${md.publication}`,
    );

  return lines.join("\n");
}

function parseModelOutput(text: string): string {
  // The model is instructed to return strict JSON, but be tolerant of
  // accidental code fences.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { summary?: unknown }).summary === "string"
    ) {
      const s = (parsed as { summary: string }).summary.trim();
      if (s) return s;
    }
  } catch {
    // fall through to placeholder
  }
  return PLACEHOLDER;
}

const errClass = (err: unknown): string =>
  err instanceof Error ? err.constructor.name : typeof err;
const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Generate the summary for exactly one of personId / organizationId.
 * Returns null when the entity doesn't exist (caller responds 404).
 * Never throws — model failures degrade to the placeholder summary.
 */
export async function generateRelationshipSummary(args: {
  personId?: string | null;
  organizationId?: string | null;
}): Promise<RelationshipSummaryResult | null> {
  const signals = await gatherTaskSignals(args);
  if (!signals) return null;

  const generatedAt = new Date().toISOString();
  try {
    const response = await aiProposalLimit(() =>
      withRateLimitRetry(
        () =>
          anthropic.messages.create(
            {
              model: MODEL,
              max_tokens: 1024,
              system: SYSTEM,
              messages: [{ role: "user", content: fmtSignals(signals) }],
            },
            { timeout: 60000, maxRetries: 0 },
          ),
        {
          onRetry: ({ attempt, delayMs }) =>
            logger.info(
              { entityId: signals.entity.id, attempt, delayMs },
              "generateRelationshipSummary: rate-limited, backing off",
            ),
        },
      ),
    );
    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }
    return { summary: parseModelOutput(text), generatedAt };
  } catch (err) {
    // Privacy: never log the err payload directly — Anthropic SDK errors
    // can echo the prompt back, and the prompt contains donor data.
    logger.warn(
      { errClass: errClass(err), errMessage: errMessage(err) },
      "generateRelationshipSummary failed; returning placeholder",
    );
    return { summary: PLACEHOLDER, generatedAt };
  }
}
