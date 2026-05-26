import { db } from "@workspace/db";
import {
  emailProposals,
  emails as emailsTable,
  funders,
  organizations,
  people,
  peopleEntityRoles,
  type EmailProposal,
} from "@workspace/db/schema";
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";

/**
 * AI-proposed structured actions for email-intelligence proposals.
 *
 * Detectors in `intelDetectors.ts` produce raw signals (a LinkedIn
 * digest line, a parsed signature, an auto-responder body, a grant
 * digest). This module asks Claude — given that signal plus the CRM
 * context for the person/funder it points at — what concrete CRM
 * mutations a reviewer should consider applying.
 *
 * The action vocabulary is closed: every action object maps to a
 * specific handler in `applyProposalActions.ts`. Claude is given the
 * vocabulary as a tool input_schema; non-conforming output is rejected
 * by the SDK before it reaches us. This keeps the surface narrow even
 * as the LLM phrasing varies.
 *
 * Run path:
 *   - On every new proposal upsert in `emailIntelligence.upsertProposal`
 *     we fire-and-forget `proposeActionsForProposal(id)` so the actions
 *     are populated by the time a human opens the review queue. Errors
 *     are caught and recorded on the row in `actionsError`; they never
 *     break the sync loop.
 *   - Backfill phase D (`gmailBackfill.ts`) sweeps rows where
 *     `actions_analyzed_at IS NULL` so existing pending proposals from
 *     before the AI step shipped get retrofitted.
 *
 * The dispatcher in `applyProposalActions.ts` re-validates IDs at apply
 * time (e.g. a funderId Claude returned might have been deleted between
 * proposal time and accept time) so a stale action set fails loudly
 * instead of corrupting data.
 */

// ──────────────────────────────────────────────────────────────────
// Action schema — Claude tool input_schema + matching TS types
// ──────────────────────────────────────────────────────────────────

export type ProposedAction =
  | {
      type: "deactivate_per";
      perId: string;
      reason: string;
    }
  | {
      type: "create_per";
      personId: string;
      // Exactly one of these four must be set; matches the
      // per_entity_discriminator check on people_entity_roles.
      funderId?: string;
      organizationId?: string;
      paymentIntermediaryId?: string;
      householdId?: string;
      connection?:
        | "employee"
        | "principal"
        | "board_member"
        | "partner"
        | "professor"
        | "donor_advisor"
        | "elected_official";
      externalTitleOrRole?: string;
      reason: string;
    }
  | {
      type: "create_person_with_per";
      firstName: string;
      lastName: string;
      emailAddress?: string;
      funderId?: string;
      organizationId?: string;
      connection?:
        | "employee"
        | "principal"
        | "board_member"
        | "partner"
        | "professor"
        | "donor_advisor"
        | "elected_official";
      externalTitleOrRole?: string;
      reason: string;
    }
  | {
      type: "add_email";
      personId: string;
      emailAddress: string;
      emailType?: "work" | "personal" | "other";
      setPrimary?: boolean;
      reason: string;
    }
  | {
      type: "set_primary_email";
      // Either an existing emails.id or a (personId + address) tuple.
      // We accept both because Claude can name the address it sees in
      // the message text, but doesn't always have the row id.
      emailId?: string;
      personId?: string;
      emailAddress?: string;
      reason: string;
    }
  | {
      type: "mark_email_invalid";
      emailAddress: string;
      reason: string;
    }
  | {
      type: "create_grant_opportunity";
      funderId?: string;
      funderName?: string;
      title: string;
      askAmount?: number;
      deadline?: string; // ISO yyyy-mm-dd
      stage?: "cold_lead" | "warm_lead";
      reason: string;
    };

// JSON schema mirror for Claude's input_schema. Keep tightly aligned
// with the TS union above — adding a new action type means editing
// both. The discriminator on "type" is what makes the union parseable.
const ACTION_TOOL_SCHEMA = {
  name: "propose_actions",
  description:
    "Return the structured CRM mutations the reviewer should consider for this email-intelligence proposal. Return an empty array if no actions are warranted — that's a valid response.",
  input_schema: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        items: {
          oneOf: [
            {
              type: "object",
              required: ["type", "perId", "reason"],
              properties: {
                type: { const: "deactivate_per" },
                perId: { type: "string", description: "ID of the existing people_entity_roles row to mark current='past'." },
                reason: { type: "string" },
              },
            },
            {
              type: "object",
              required: ["type", "personId", "reason"],
              properties: {
                type: { const: "create_per" },
                personId: { type: "string", description: "Existing person ID this new role attaches to." },
                funderId: { type: "string" },
                organizationId: { type: "string" },
                paymentIntermediaryId: { type: "string" },
                householdId: { type: "string" },
                connection: { type: "string", enum: ["employee", "principal", "board_member", "partner", "professor", "donor_advisor", "elected_official"] },
                externalTitleOrRole: { type: "string" },
                reason: { type: "string" },
              },
            },
            {
              type: "object",
              required: ["type", "firstName", "lastName", "reason"],
              properties: {
                type: { const: "create_person_with_per" },
                firstName: { type: "string" },
                lastName: { type: "string" },
                emailAddress: { type: "string" },
                funderId: { type: "string" },
                organizationId: { type: "string" },
                connection: { type: "string", enum: ["employee", "principal", "board_member", "partner", "professor", "donor_advisor", "elected_official"] },
                externalTitleOrRole: { type: "string" },
                reason: { type: "string" },
              },
            },
            {
              type: "object",
              required: ["type", "personId", "emailAddress", "reason"],
              properties: {
                type: { const: "add_email" },
                personId: { type: "string" },
                emailAddress: { type: "string" },
                emailType: { type: "string", enum: ["work", "personal", "other"] },
                setPrimary: { type: "boolean" },
                reason: { type: "string" },
              },
            },
            {
              type: "object",
              required: ["type", "reason"],
              properties: {
                type: { const: "set_primary_email" },
                emailId: { type: "string" },
                personId: { type: "string" },
                emailAddress: { type: "string" },
                reason: { type: "string" },
              },
            },
            {
              type: "object",
              required: ["type", "emailAddress", "reason"],
              properties: {
                type: { const: "mark_email_invalid" },
                emailAddress: { type: "string" },
                reason: { type: "string" },
              },
            },
            {
              type: "object",
              required: ["type", "title", "reason"],
              properties: {
                type: { const: "create_grant_opportunity" },
                funderId: { type: "string" },
                funderName: { type: "string" },
                title: { type: "string" },
                askAmount: { type: "number" },
                deadline: { type: "string", description: "ISO yyyy-mm-dd if known." },
                stage: { type: "string", enum: ["cold_lead", "warm_lead"] },
                reason: { type: "string" },
              },
            },
          ],
        },
      },
    },
    required: ["actions"],
  },
} as const;

const MODEL = "claude-sonnet-4-6";

// ──────────────────────────────────────────────────────────────────
// Context loaders
// ──────────────────────────────────────────────────────────────────

interface PersonContext {
  id: string;
  fullName: string | null;
  emails: { id: string; email: string; type: string | null; isPreferred: boolean; validity: string }[];
  roles: {
    id: string;
    entityType: string;
    entityName: string | null;
    funderId: string | null;
    organizationId: string | null;
    connection: string | null;
    externalTitleOrRole: string | null;
    current: string;
  }[];
}

async function loadPersonContext(personId: string): Promise<PersonContext | null> {
  const [p] = await db
    .select({ id: people.id, fullName: people.fullName })
    .from(people)
    .where(eq(people.id, personId))
    .limit(1);
  if (!p) return null;
  const [emailRows, roleRows] = await Promise.all([
    db
      .select({
        id: emailsTable.id,
        email: emailsTable.email,
        type: emailsTable.type,
        isPreferred: emailsTable.isPreferred,
        validity: emailsTable.validity,
      })
      .from(emailsTable)
      .where(eq(emailsTable.personId, personId)),
    db
      .select({
        id: peopleEntityRoles.id,
        entityType: peopleEntityRoles.entityType,
        funderId: peopleEntityRoles.funderId,
        funderName: funders.name,
        organizationId: peopleEntityRoles.organizationId,
        organizationName: organizations.name,
        connection: peopleEntityRoles.connection,
        externalTitleOrRole: peopleEntityRoles.externalTitleOrRole,
        current: peopleEntityRoles.current,
      })
      .from(peopleEntityRoles)
      .leftJoin(funders, eq(funders.id, peopleEntityRoles.funderId))
      .leftJoin(organizations, eq(organizations.id, peopleEntityRoles.organizationId))
      .where(eq(peopleEntityRoles.personId, personId)),
  ]);
  return {
    id: p.id,
    fullName: p.fullName,
    emails: emailRows.map((e) => ({
      id: e.id,
      email: e.email,
      type: e.type,
      isPreferred: e.isPreferred,
      validity: e.validity,
    })),
    roles: roleRows.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      entityName: r.funderName ?? r.organizationName ?? null,
      funderId: r.funderId,
      organizationId: r.organizationId,
      connection: r.connection,
      externalTitleOrRole: r.externalTitleOrRole,
      current: r.current,
    })),
  };
}

interface FunderCandidate {
  id: string;
  name: string;
}

async function findFunderCandidates(name: string | null | undefined): Promise<FunderCandidate[]> {
  if (!name || name.trim().length < 3) return [];
  const term = name.trim().toLowerCase();
  // Two-pass: exact-ish first, then loose substring. Cap at 5 so the
  // prompt stays small.
  const rows = await db
    .select({ id: funders.id, name: funders.name })
    .from(funders)
    .where(
      or(
        ilike(funders.name, term),
        ilike(funders.name, `%${term}%`),
      ),
    )
    .limit(5);
  return rows
    .filter((r): r is { id: string; name: string } => r.name !== null)
    .map((r) => ({ id: r.id, name: r.name }));
}

// ──────────────────────────────────────────────────────────────────
// Prompt builder
// ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return [
    "You are a fundraising-CRM data steward. The user runs Wildflower Schools' fundraising operation.",
    "Each turn, you receive one email-intelligence proposal — a signal extracted from a synced Gmail message — along with whatever CRM context is relevant.",
    "Your job: call the `propose_actions` tool exactly once, returning the concrete CRM mutations the reviewer should consider applying.",
    "",
    "Rules:",
    "• Only use IDs that appear verbatim in the CRM CONTEXT block. Never invent IDs. If the right entity isn't in the context, omit the action.",
    "• Be conservative. If the signal is ambiguous or contradicts current CRM state without strong evidence, return fewer actions or an empty list. The reviewer prefers missing a change over a wrong one.",
    "• Use the email message body (quoted at the bottom) as the source of truth for what the sender actually said. Don't generalize beyond it.",
    "• `reason` on each action should quote or paraphrase the specific phrase in the message that justifies the change. Keep it under 140 chars.",
    "• For LinkedIn job changes: typical pattern is one `deactivate_per` for the role they're leaving + one `create_per` for the new role at the new company (only if the new company resolves to a funder/organization id in context). If the message names a replacement, add `create_person_with_per` for that successor.",
    "• For auto-responder 'I've moved' messages: deactivate the old role if a new company is named, create the new role if it resolves to a known entity, add the new email if one is given (with setPrimary=true if they say it's their new primary).",
    "• For signature updates: only emit actions for fields that genuinely differ from current CRM state. Don't restate the status quo.",
    "• For bounce messages: emit `mark_email_invalid` only for hard bounces. Soft bounces are review-only — return an empty actions array.",
    "• For grant opportunities: emit one `create_grant_opportunity` per distinct RFP / grant program named, with funderId only if the funder appears in context. Use cold_lead unless the message indicates an active invitation (then warm_lead). Don't invent ask amounts — only set askAmount if the message states one.",
    "",
    "Return an empty actions array when no automatic mutation is warranted — that is a valid and often correct answer.",
  ].join("\n");
}

function buildUserPrompt(args: {
  proposal: EmailProposal;
  personContext: PersonContext | null;
  funderCandidates: FunderCandidate[];
  funderTargetId: string | null;
  funderTargetName: string | null;
  messageBody: string | null;
}): string {
  const { proposal, personContext, funderCandidates, funderTargetId, funderTargetName, messageBody } = args;
  const lines: string[] = [];
  lines.push(`PROPOSAL KIND: ${proposal.kind}`);
  lines.push(`PROPOSAL SUBJECT: ${proposal.subjectName ?? proposal.subjectEmail ?? "(none)"}`);
  lines.push("");
  lines.push("PROPOSAL PAYLOAD (what the detector parsed):");
  lines.push(JSON.stringify(proposal.payload, null, 2));
  lines.push("");
  lines.push("CRM CONTEXT:");
  if (personContext) {
    lines.push(`Matched person: id=${personContext.id} name=${personContext.fullName ?? "(unnamed)"}`);
    lines.push(`  Emails on file:`);
    if (personContext.emails.length === 0) lines.push("    (none)");
    for (const e of personContext.emails) {
      lines.push(
        `    - id=${e.id} ${e.email}${e.isPreferred ? " [PRIMARY]" : ""} type=${e.type ?? "?"} validity=${e.validity}`,
      );
    }
    lines.push(`  Entity roles:`);
    if (personContext.roles.length === 0) lines.push("    (none)");
    for (const r of personContext.roles) {
      lines.push(
        `    - id=${r.id} ${r.current.toUpperCase()} at ${r.entityName ?? "?"} (${r.entityType}, ${r.connection ?? "?"})${r.externalTitleOrRole ? ` title="${r.externalTitleOrRole}"` : ""}${r.funderId ? ` funderId=${r.funderId}` : ""}${r.organizationId ? ` organizationId=${r.organizationId}` : ""}`,
      );
    }
  } else {
    lines.push("No matched person on file.");
  }
  if (funderTargetId) {
    lines.push(`Matched funder: id=${funderTargetId} name=${funderTargetName ?? "?"}`);
  }
  if (funderCandidates.length > 0) {
    lines.push(`Funder candidates by name lookup:`);
    for (const f of funderCandidates) {
      lines.push(`  - id=${f.id} ${f.name}`);
    }
  }
  if (messageBody) {
    lines.push("");
    lines.push("EMAIL MESSAGE (truncated to 4000 chars):");
    lines.push(messageBody.slice(0, 4000));
  }
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────

/**
 * Run AI action-proposal for a single email_proposals row. Idempotent
 * via the `actions_analyzed_at IS NULL` guard — callers can fire this
 * for a row multiple times without re-spending tokens. Errors are
 * caught and recorded on the row in `actions_error`; the calling
 * sync/backfill loop is unaffected.
 */
export async function proposeActionsForProposal(proposalId: string): Promise<{
  ranAI: boolean;
  actions?: ProposedAction[];
  error?: string;
}> {
  // Atomic claim: only one caller can flip actions_analyzed_at from
  // null → sentinel. Without this, two concurrent invocations (e.g.
  // a fire-and-forget from sync racing a phaseD pass) would both
  // burn tokens and race on the final UPDATE. We use a sentinel
  // timestamp (epoch) so the row is visibly "in flight" — the final
  // UPDATE below overwrites it with the real completion time.
  const claimedRows = await db
    .update(emailProposals)
    .set({ actionsAnalyzedAt: new Date(0), updatedAt: new Date() })
    .where(
      and(
        eq(emailProposals.id, proposalId),
        sql`${emailProposals.actionsAnalyzedAt} is null`,
      ),
    )
    .returning();
  if (claimedRows.length === 0) {
    // Either the row doesn't exist or another worker claimed it.
    // Return the current state (if any) so the caller isn't blocked.
    const [existing] = await db
      .select()
      .from(emailProposals)
      .where(eq(emailProposals.id, proposalId))
      .limit(1);
    if (!existing) return { ranAI: false, error: "proposal_not_found" };
    return { ranAI: false, actions: (existing.proposedActions as ProposedAction[]) ?? [] };
  }
  const proposal = claimedRows[0];

  try {
    // Gather CRM context for whatever the proposal references.
    const personContext = proposal.targetPersonId
      ? await loadPersonContext(proposal.targetPersonId)
      : null;

    // For the funder side: prefer the detector-emitted hint
    // (targetFunderId), else attempt a name lookup against payload
    // hints (newCompany / funderName / sender name).
    let funderTargetId = proposal.targetFunderId;
    let funderTargetName: string | null = null;
    if (funderTargetId) {
      const [f] = await db
        .select({ name: funders.name })
        .from(funders)
        .where(eq(funders.id, funderTargetId))
        .limit(1);
      funderTargetName = f?.name ?? null;
    }
    const payload = (proposal.payload ?? {}) as Record<string, unknown>;
    const candidateNames = [
      payload.newCompany,
      payload.funderName,
      proposal.subjectName,
    ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    const funderCandidatesNested = await Promise.all(
      candidateNames.slice(0, 2).map((n) => findFunderCandidates(n)),
    );
    const dedupedById = new Map<string, FunderCandidate>();
    for (const list of funderCandidatesNested) {
      for (const c of list) dedupedById.set(c.id, c);
    }
    if (funderTargetId) dedupedById.delete(funderTargetId);
    const funderCandidates = Array.from(dedupedById.values()).slice(0, 8);

    // Pull the source message body for prompt context. Some payloads
    // already include a snippet (grant_opportunity, signature) so we
    // fall back to that when the source message id isn't set.
    const messageBody = await loadMessageBody(proposal);

    const userPrompt = buildUserPrompt({
      proposal,
      personContext,
      funderCandidates,
      funderTargetId,
      funderTargetName,
      messageBody,
    });

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: buildSystemPrompt(),
      tools: [ACTION_TOOL_SCHEMA as unknown as Parameters<typeof anthropic.messages.create>[0]["tools"] extends (infer U)[] | undefined ? U : never],
      tool_choice: { type: "tool", name: "propose_actions" },
      messages: [{ role: "user", content: userPrompt }],
    });

    let actions: ProposedAction[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "propose_actions") {
        const raw = (block.input as { actions?: unknown }).actions;
        if (Array.isArray(raw)) {
          actions = raw as ProposedAction[];
        }
        break;
      }
    }

    await db
      .update(emailProposals)
      .set({
        proposedActions: actions,
        actionsAnalyzedAt: new Date(),
        actionsModel: MODEL,
        actionsError: null,
        updatedAt: new Date(),
      })
      .where(eq(emailProposals.id, proposalId));

    return { ranAI: true, actions };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, proposalId },
      "proposeActionsForProposal failed",
    );
    await db
      .update(emailProposals)
      .set({
        actionsAnalyzedAt: new Date(),
        actionsModel: MODEL,
        actionsError: msg.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(emailProposals.id, proposalId));
    return { ranAI: true, error: msg };
  }
}

async function loadMessageBody(proposal: EmailProposal): Promise<string | null> {
  const payload = (proposal.payload ?? {}) as Record<string, unknown>;
  // For grant digests + LinkedIn we already saved a snippet in the
  // payload so we don't need to round-trip Gmail. The signature path
  // doesn't carry the body itself, but the parsed signature is
  // usually enough signal for the AI to reason over.
  const snippet =
    (typeof payload.snippet === "string" && payload.snippet) ||
    (typeof payload.sourceLine === "string" && payload.sourceLine) ||
    (typeof payload.quotedSnippet === "string" && payload.quotedSnippet) ||
    null;
  if (snippet) return snippet;

  // Fall back to the email_messages row if we have a source_message_id.
  if (proposal.sourceMessageId) {
    const rows = await db.execute<{ body_text: string | null; body_html: string | null }>(
      sql`select body_text, body_html from email_messages where id = ${proposal.sourceMessageId} limit 1`,
    );
    const row = rows.rows[0];
    if (row?.body_text) return row.body_text;
    if (row?.body_html) return stripHtml(row.body_html);
  }
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Avoid unused-import warning if we never reach the and() guard
// downstream (kept here for future filtered loads).
void and;
