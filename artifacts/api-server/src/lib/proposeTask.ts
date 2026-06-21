import { db } from "@workspace/db";
import { taskProposals, type TaskProposal } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { anthropic, withRateLimitRetry } from "@workspace/integrations-anthropic-ai";
import { aiProposalLimit } from "./aiConcurrency";
import { logger } from "./logger";
import { gatherTaskSignals, type TaskSignals } from "./gatherTaskSignals";

/**
 * Task intelligence: AI-suggested next-step cultivation task.
 *
 * Mirrors the email-intelligence AI path (`proposeActions.ts`) but for a
 * different signal source: instead of a single inbound email, the model
 * reasons over a relationship snapshot (recent gifts, open opportunities,
 * last-contact dates, capacity / priority, media mentions) for one CRM
 * entity and proposes the single most useful next step the fundraiser
 * should take.
 *
 * Resilience rules (see `.agents/memory/wildflower-ai-proposal-resilience.md`):
 *   - route the call through `aiProposalLimit` (global concurrency cap)
 *   - wrap it in `withRateLimitRetry` and set the SDK's `maxRetries: 0`
 *   - record errors on the row in `error`; never throw out of generation
 */

const MODEL = "claude-sonnet-4-6";

interface SuggestionResult {
  title: string;
  description: string;
  suggestedDueDate: string | null;
  rationale: string;
  /** True when the model judges no next step is warranted right now. */
  noSuggestion: boolean;
}

// Closed tool vocabulary — the model must return exactly one structured
// suggestion (or flag that none is warranted).
const SUGGEST_TASK_TOOL = {
  name: "suggest_next_step",
  description:
    "Return the single most useful next-step cultivation task for this entity, or flag that no task is warranted.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "description", "rationale", "noSuggestion"],
    properties: {
      noSuggestion: {
        type: "boolean",
        description:
          "true when no next step is warranted right now (e.g. nothing actionable in the signals). When true, still provide short title/description/rationale explaining why.",
      },
      title: {
        type: "string",
        description:
          "Imperative, specific task title (e.g. 'Send Q3 impact update to Jane Doe'). Under 100 chars.",
      },
      description: {
        type: "string",
        description:
          "1-3 sentences of concrete guidance on how to carry out the step.",
      },
      suggestedDueDate: {
        type: "string",
        description:
          "Recommended date to act by, as YYYY-MM-DD. Omit if no specific timing is warranted.",
      },
      rationale: {
        type: "string",
        description:
          "1-2 sentences citing the specific signal(s) that justify this step. Under 240 chars.",
      },
    },
  },
} as const;

function buildSystemPrompt(): string {
  return [
    "You are a fundraising-CRM cultivation strategist for Wildflower Schools.",
    "Given a relationship snapshot for ONE donor/prospect (a person or an organization), call the `suggest_next_step` tool exactly once with the single most useful next step the fundraiser should take to move the relationship forward.",
    "",
    "Rules:",
    "• Propose ONE concrete, specific, actionable step — not a vague 'follow up'. Reference the actual signals (a recent gift, an open opportunity nearing its close date, a long gap since last contact, a recent media mention worth congratulating on).",
    "• Tailor to the relationship stage: a brand-new prospect needs intro/discovery; a recent donor needs a thank-you / stewardship touch; an open opportunity nearing close needs a push; a lapsed donor needs re-engagement.",
    "• Set suggestedDueDate when timing matters (e.g. before an application deadline, or a near-term stewardship window). Use YYYY-MM-DD. Today's date is provided in the context.",
    "• Be specific in the title and grounded in the rationale — quote or paraphrase the signal that justifies the step.",
    "• If the signals genuinely warrant no action right now, set noSuggestion=true and briefly explain why; still fill title/description/rationale.",
    "• Never invent facts not present in the snapshot. Do not reference donations, meetings, or amounts that aren't in the data.",
  ].join("\n");
}

function buildUserPrompt(
  signals: TaskSignals,
  reviewerGuidance?: string | null,
): string {
  const e = signals.entity;
  const lines: string[] = [];
  lines.push(`TODAY'S DATE: ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  if (reviewerGuidance && reviewerGuidance.trim()) {
    lines.push(
      "REVIEWER GUIDANCE (a human reviewer corrected the previous suggestion — treat this as authoritative and honor it when proposing the next step; where it conflicts with your own interpretation, follow the reviewer):",
    );
    lines.push(reviewerGuidance.trim().slice(0, 2000));
    lines.push("");
  }
  lines.push(`ENTITY: ${e.kind} — ${e.name ?? "(unnamed)"} (id=${e.id})`);
  if (e.kind === "organization") {
    lines.push(`  Grant-maker: ${e.issuesGrants ? "yes" : "no"}`);
  }
  lines.push(`  Priority: ${e.priority ?? "(unset)"}`);
  lines.push(`  Capacity rating: ${e.capacityRating ?? "(unset)"}`);
  lines.push(`  Connection status: ${e.connectionStatus ?? "(unset)"}`);
  lines.push(`  Enthusiasm: ${e.enthusiasm ?? "(unset)"}`);
  lines.push(`  Last contacted: ${e.lastContacted ?? "(unknown)"}`);
  lines.push(`  Interaction count: ${e.interactionCount ?? "(unknown)"}`);
  if (e.tags) lines.push(`  Tags: ${e.tags}`);
  lines.push("");

  lines.push("RECENT GIFTS / PAYMENTS:");
  if (signals.recentGifts.length === 0) lines.push("  (none)");
  for (const g of signals.recentGifts) {
    lines.push(
      `  - ${g.date ?? "?"}: ${g.amount ?? "?"} ${g.type ?? ""} ${g.name ? `(${g.name})` : ""}`.trimEnd(),
    );
  }
  lines.push("");

  lines.push("OPEN / RECENT OPPORTUNITIES & PLEDGES:");
  if (signals.openOpportunities.length === 0) lines.push("  (none)");
  for (const o of signals.openOpportunities) {
    lines.push(
      `  - ${o.name ?? "(unnamed)"} [status=${o.status ?? "?"}, stage=${o.stage ?? "?"}] ask=${o.askAmount ?? "?"} awarded=${o.awardedAmount ?? "?"} projectedClose=${o.projectedCloseDate ?? "?"} deadline=${o.applicationDeadline ?? "?"}`,
    );
  }
  lines.push("");

  lines.push("RECENT NOTES:");
  if (signals.recentNotes.length === 0) lines.push("  (none)");
  for (const n of signals.recentNotes) {
    lines.push(`  - ${n.date ?? "?"}: ${n.body}`);
  }
  lines.push("");

  lines.push("RECENT MEETINGS:");
  if (signals.recentMeetings.length === 0) lines.push("  (none)");
  for (const m of signals.recentMeetings) {
    lines.push(
      `  - ${m.date ?? "?"}: ${m.title ?? "(untitled)"}${m.summary ? ` — ${m.summary}` : ""}`,
    );
  }
  lines.push("");

  lines.push("RECENT CALENDAR EVENTS:");
  if (signals.recentCalendarEvents.length === 0) lines.push("  (none)");
  for (const c of signals.recentCalendarEvents) {
    lines.push(`  - ${c.date ?? "?"}: ${c.summary ?? "(no title)"}`);
  }
  lines.push("");

  lines.push("RECENT EMAILS:");
  if (signals.recentEmails.length === 0) lines.push("  (none)");
  for (const em of signals.recentEmails) {
    lines.push(`  - ${em.date ?? "?"}: ${em.subject ?? "(no subject)"}`);
  }
  lines.push("");

  lines.push("RECENT MEDIA MENTIONS:");
  if (signals.recentMediaMentions.length === 0) lines.push("  (none)");
  for (const md of signals.recentMediaMentions) {
    lines.push(
      `  - ${md.date ?? "?"}: ${md.title ?? "(untitled)"} — ${md.publication}`,
    );
  }

  return lines.join("\n");
}

function parseSuggestion(
  input: Record<string, unknown>,
): SuggestionResult {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description =
    typeof input.description === "string" ? input.description.trim() : "";
  const rationale =
    typeof input.rationale === "string" ? input.rationale.trim() : "";
  const noSuggestion = input.noSuggestion === true;
  let suggestedDueDate: string | null = null;
  if (typeof input.suggestedDueDate === "string") {
    const m = input.suggestedDueDate.match(/^\d{4}-\d{2}-\d{2}/);
    if (m) suggestedDueDate = m[0];
  }
  return { title, description, suggestedDueDate, rationale, noSuggestion };
}

/**
 * Run AI drafting for a single task_proposals row, in place. Gathers the
 * latest signals, calls Claude, and writes the suggestion (or an error)
 * back onto the row. Always clears `analyzed_at` to a real timestamp so
 * the row never stays stuck "generating". Never throws — failures are
 * recorded in `error`.
 */
export async function generateTaskProposal(
  proposalId: string,
  opts?: { reviewerGuidance?: string | null },
): Promise<{
  ok: boolean;
  error?: string;
}> {
  const [row] = await db
    .select()
    .from(taskProposals)
    .where(eq(taskProposals.id, proposalId))
    .limit(1);
  if (!row) return { ok: false, error: "proposal_not_found" };

  try {
    const signals = await gatherTaskSignals({
      personId: row.targetPersonId,
      organizationId: row.targetOrganizationId,
    });
    if (!signals) {
      await db
        .update(taskProposals)
        .set({
          analyzedAt: new Date(),
          model: MODEL,
          error: "entity_not_found",
          updatedAt: new Date(),
        })
        .where(eq(taskProposals.id, proposalId));
      return { ok: false, error: "entity_not_found" };
    }

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(signals, opts?.reviewerGuidance);

    const response = await aiProposalLimit(() =>
      withRateLimitRetry(
        () =>
          anthropic.messages.create(
            {
              model: MODEL,
              max_tokens: 1024,
              system: [
                {
                  type: "text",
                  text: systemPrompt,
                  cache_control: { type: "ephemeral" },
                },
              ],
              tools: [
                SUGGEST_TASK_TOOL as unknown as Parameters<
                  typeof anthropic.messages.create
                >[0]["tools"] extends (infer U)[] | undefined
                  ? U
                  : never,
              ],
              tool_choice: { type: "tool", name: "suggest_next_step" },
              messages: [{ role: "user", content: userPrompt }],
            },
            { timeout: 60000, maxRetries: 0 },
          ),
        {
          onRetry: ({ attempt, delayMs }) =>
            logger.info(
              { proposalId, attempt, delayMs },
              "generateTaskProposal: rate-limited, backing off",
            ),
        },
      ),
    );

    let suggestion: SuggestionResult | null = null;
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "suggest_next_step") {
        suggestion = parseSuggestion(block.input as Record<string, unknown>);
        break;
      }
    }

    if (!suggestion || !suggestion.title) {
      await db
        .update(taskProposals)
        .set({
          analyzedAt: new Date(),
          model: MODEL,
          error: "no_suggestion_returned",
          updatedAt: new Date(),
        })
        .where(eq(taskProposals.id, proposalId));
      return { ok: false, error: "no_suggestion_returned" };
    }

    await db
      .update(taskProposals)
      .set({
        payload: signals,
        title: suggestion.title.slice(0, 200),
        description: suggestion.description.slice(0, 2000) || null,
        suggestedDueDate: suggestion.suggestedDueDate,
        rationale: suggestion.rationale.slice(0, 500) || null,
        analyzedAt: new Date(),
        model: MODEL,
        error: suggestion.noSuggestion ? "no_action_warranted" : null,
        updatedAt: new Date(),
      })
      .where(eq(taskProposals.id, proposalId));

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, proposalId }, "generateTaskProposal failed");
    await db
      .update(taskProposals)
      .set({
        analyzedAt: new Date(),
        model: MODEL,
        error: msg.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(taskProposals.id, proposalId));
    return { ok: false, error: msg };
  }
}

export type { TaskProposal };
