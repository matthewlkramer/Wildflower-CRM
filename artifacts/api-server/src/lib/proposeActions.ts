import { db } from "@workspace/db";
import {
  emailProposals,
  emails as emailsTable,
  funders,
  organizations,
  people,
  peopleEntityRoles,
  phoneNumbers,
  type EmailProposal,
} from "@workspace/db/schema";
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { deadlineHasPassed } from "./intelDetectors";
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
      // Like create_person_with_per, but the missing entity is the
      // EMPLOYER, not the person. Use when an existing person works at a
      // NON-FUNDER organization (charter school, school network,
      // nonprofit, company, …) that isn't in the CRM yet. Creates the
      // org in the `organizations` table (never `funders`) and attaches
      // the role in one step.
      type: "create_org_with_per";
      personId: string;
      organizationName: string;
      organizationType?:
        | "advocacy_membership_lobbyist"
        | "authorizer"
        | "cmo"
        | "capital_provider"
        | "government"
        | "corporation"
        | "education_vendor"
        | "elected_official"
        | "higher_ed"
        | "investor"
        | "law_firm"
        | "media"
        | "nonprofit"
        | "philanthropic_advisor"
        | "real_estate"
        | "school"
        | "school_district"
        | "school_network"
        | "small_business_consulting"
        | "tribal";
      emailDomain?: string;
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
    }
  | {
      type: "set_phone";
      personId: string;
      phoneNumber: string;
      phoneType?: "work" | "mobile" | "home" | "other";
      setPrimary?: boolean;
      reason: string;
    }
  | {
      type: "update_per_title";
      // Existing people_entity_roles row to set externalTitleOrRole on.
      perId: string;
      externalTitleOrRole: string;
      reason: string;
    };

// JSON schema mirror for Claude's input_schema. Keep tightly aligned
// with the TS union above — adding a new action type means editing
// both. The discriminator on "type" is what makes the union parseable.
const ACTION_TOOL_SCHEMA = {
  name: "propose_actions",
  description:
    "Return the structured CRM mutations the reviewer should consider for this email-intelligence proposal. Return an empty array if no actions are warranted — that's a valid response. Separately, set `suppress` when the proposal is noise that the reviewer should never have to see at all.",
  input_schema: {
    type: "object",
    properties: {
      suppress: {
        type: "object",
        description:
          "Set shouldSuppress=true ONLY when this proposal is clearly noise the reviewer should not have to triage — e.g. a grant WINNER/recipient announcement (not a new opportunity), a promo/newsletter/event-registration/sponsorship blast, an RFP to hire a vendor/contractor (sender is buying, not funding), an opportunity whose application deadline has already passed, a plain out-of-office auto-reply (person still at the org), or a signature whose name clearly belongs to someone other than the highlighted CRM person. Be conservative: when in doubt, do NOT suppress.",
        required: ["shouldSuppress", "reason"],
        properties: {
          shouldSuppress: { type: "boolean" },
          reason: { type: "string", description: "Short justification, under 140 chars." },
        },
      },
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
              required: ["type", "personId", "organizationName", "reason"],
              properties: {
                type: { const: "create_org_with_per" },
                personId: { type: "string", description: "Existing person ID this new role attaches to." },
                organizationName: { type: "string", description: "Name of the NON-FUNDER organization to create (charter school, school network, nonprofit, company, etc.). Goes in the organizations table, never funders." },
                organizationType: {
                  type: "string",
                  enum: ["advocacy_membership_lobbyist", "authorizer", "cmo", "capital_provider", "government", "corporation", "education_vendor", "elected_official", "higher_ed", "investor", "law_firm", "media", "nonprofit", "philanthropic_advisor", "real_estate", "school", "school_district", "school_network", "small_business_consulting", "tribal"],
                  description: "Best-fit org type when clear. A single charter school → school; a charter school network / CMO → cmo or school_network; a school district → school_district.",
                },
                emailDomain: { type: "string", description: "The org's email domain if evident from the sender address (e.g. phoenixcharteracademy.org)." },
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
            {
              type: "object",
              required: ["type", "personId", "phoneNumber", "reason"],
              properties: {
                type: { const: "set_phone" },
                personId: { type: "string", description: "Existing person ID to attach the phone to." },
                phoneNumber: { type: "string", description: "The phone number as written in the signature." },
                phoneType: { type: "string", enum: ["work", "mobile", "home", "other"] },
                setPrimary: { type: "boolean" },
                reason: { type: "string" },
              },
            },
            {
              type: "object",
              required: ["type", "perId", "externalTitleOrRole", "reason"],
              properties: {
                type: { const: "update_per_title" },
                perId: { type: "string", description: "ID of the existing people_entity_roles row whose title/role to update." },
                externalTitleOrRole: { type: "string", description: "The new title/role text." },
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
  phones: { id: string; phoneNumber: string; type: string | null; isPreferred: boolean }[];
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
  const [emailRows, phoneRows, roleRows] = await Promise.all([
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
        id: phoneNumbers.id,
        phoneNumber: phoneNumbers.phoneNumber,
        type: phoneNumbers.type,
        isPreferred: phoneNumbers.isPreferred,
      })
      .from(phoneNumbers)
      .where(eq(phoneNumbers.personId, personId)),
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
    phones: phoneRows.map((ph) => ({
      id: ph.id,
      phoneNumber: ph.phoneNumber,
      type: ph.type,
      isPreferred: ph.isPreferred,
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

interface OrganizationCandidate {
  id: string;
  name: string;
}

// Mirror of findFunderCandidates for non-funding organizations. The
// action schema lets create_per / create_person_with_per target an
// organizationId, but without this lookup the model never sees a valid
// org id and so can't propose a role change to a non-funder employer.
async function findOrganizationCandidates(
  name: string | null | undefined,
): Promise<OrganizationCandidate[]> {
  if (!name || name.trim().length < 3) return [];
  const term = name.trim().toLowerCase();
  const rows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(
      or(
        ilike(organizations.name, term),
        ilike(organizations.name, `%${term}%`),
      ),
    )
    .limit(5);
  return rows
    .filter((r): r is { id: string; name: string } => r.name !== null)
    .map((r) => ({ id: r.id, name: r.name }));
}

// Rewrite create_org_with_per actions whose named employer already
// exists in the CRM into a plain create_per against that existing
// entity, so we never propose a duplicate. A funder match takes
// precedence over an organization match (a "Fund"/"Foundation" the model
// mislabeled as a non-funder org is still a funder). Matching is
// case-insensitive exact on the trimmed name; % / _ are escaped so org
// names can't act as LIKE wildcards. Anything with no match keeps its
// create_org_with_per action unchanged.
// Heuristic for names that read as a philanthropic funder rather than an
// operating organization. Used only as a last resort: when a
// create_org_with_per name matches no existing funder OR organization, a
// funder-looking name is dropped instead of being created as an org, so
// we never fabricate a funder (or a bogus org standing in for one) from a
// signature. Word-boundary matched so "Fund" doesn't fire on "Foundational".
export function looksLikeFunderName(name: string): boolean {
  return /\b(fund|foundation|trust|endowment|philanthrop\w*|charitable|family office|grantmak\w*)\b/i.test(
    name,
  );
}

async function reconcileCreateOrgWithPer(
  actions: ProposedAction[],
): Promise<ProposedAction[]> {
  const escapeLike = (s: string) => s.replace(/([%_\\])/g, "\\$1");
  const out: ProposedAction[] = [];
  for (const action of actions) {
    if (action.type !== "create_org_with_per") {
      out.push(action);
      continue;
    }
    const name = action.organizationName?.trim();
    if (!name) {
      out.push(action);
      continue;
    }
    const pattern = escapeLike(name);
    const [funderMatch] = await db
      .select({ id: funders.id })
      .from(funders)
      .where(ilike(funders.name, pattern))
      .limit(1);
    if (funderMatch) {
      out.push({
        type: "create_per",
        personId: action.personId,
        funderId: funderMatch.id,
        connection: action.connection,
        externalTitleOrRole: action.externalTitleOrRole,
        reason: `${action.reason} (linked to existing funder "${name}" already in CRM)`,
      });
      continue;
    }
    const [orgMatch] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(ilike(organizations.name, pattern))
      .limit(1);
    if (orgMatch) {
      out.push({
        type: "create_per",
        personId: action.personId,
        organizationId: orgMatch.id,
        connection: action.connection,
        externalTitleOrRole: action.externalTitleOrRole,
        reason: `${action.reason} (linked to existing organization "${name}" already in CRM)`,
      });
      continue;
    }
    // No existing funder or organization of that name. If the name reads
    // like a philanthropic funder, drop it rather than fabricate an org
    // (and we never auto-create funders from a signature). Otherwise keep
    // the create_org_with_per to create the new non-funder organization.
    if (looksLikeFunderName(name)) {
      logger.info(
        { proposalAction: action.type, organizationName: name },
        "reconcile: dropped create_org_with_per for funder-looking name not in CRM",
      );
      continue;
    }
    out.push(action);
  }
  return out;
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
    "• Only use IDs that appear verbatim in the CRM CONTEXT block. Never invent IDs.",
    "• When the person's EMPLOYER named in the message is NOT in context, emit `create_org_with_per` with the organization's name, your best-guess organizationType, and emailDomain when evident. The system then reconciles it deterministically: if a funder or organization of that name already exists it links the role to that existing entity instead of creating a duplicate, and if the name is a philanthropic FUNDER that isn't in the CRM it drops the action (we never invent funders). So you do NOT need to know what already exists — just surface the employer. Pick organizationType from the best-fit enum when the kind of org is clear (single charter school → school; charter network / CMO → cmo or school_network; district → school_district; law firm → law_firm; operating nonprofit → nonprofit). Note that names containing Fund, Foundation, Trust, Endowment, Philanthropies, Charitable, or Family Office are typically funders, not operating orgs. NEVER emit a bare `create_per` that lacks an entity id — either resolve the id from context, use create_org_with_per, or omit.",
    "• Be conservative. If the signal is ambiguous or contradicts current CRM state without strong evidence, return fewer actions or an empty list. The reviewer prefers missing a change over a wrong one.",
    "• Use the email message body (quoted at the bottom) as the source of truth for what the sender actually said. Don't generalize beyond it.",
    "• `reason` on each action should quote or paraphrase the specific phrase in the message that justifies the change. Keep it under 140 chars.",
    "• For LinkedIn job changes: typical pattern is one `deactivate_per` for the role they're leaving + one `create_per` for the new role at the new company when that company resolves to a funder/organization id in context — otherwise, for a new NON-FUNDER employer, use `create_org_with_per`. If the message names a replacement, add `create_person_with_per` for that successor.",
    "• For auto-responder 'I've moved' messages: deactivate the old role if a new company is named, create the new role if it resolves to a known entity, add the new email if one is given (with setPrimary=true if they say it's their new primary).",
    "• For signature_update proposals: the payload.parsed object holds {name,title,company,phone,email}. Cross-check EACH parsed field against the CRM CONTEXT and emit an action ONLY for fields that are genuinely NEW or changed. Never restate the status quo. Specifically:",
    "    – email: if it already appears under 'Emails on file' (case-insensitive), emit nothing for it.",
    "    – phone: compare digits only (ignore spaces/dashes/parens/country code) against 'Phones on file'. If a matching number is already on file, emit nothing. If it is genuinely new, emit `set_phone` with the person's id.",
    "    – title/role: if the person already has a CURRENT role at that company with that same title, emit nothing. If they have a CURRENT role at that company but its title is empty or different and the message shows a new title, emit `update_per_title` using that role's id — do NOT emit create_per for a role they already hold. Only use create_per when it is a genuinely different/new entity the person isn't already attached to AND that entity's id is in context; if the entity is a non-funder employer not yet in the CRM, use create_org_with_per instead.",
    "    – company: treat it as changed ONLY if it doesn't match the name of ANY current role entity in context. The detector sometimes mis-parses a sentence fragment as a company — if the parsed company looks like prose or references Wildflower (the user's own org), ignore it entirely.",
    "• Never emit `create_per` for a role the person already holds (same entity, current). If only the title differs, use `update_per_title`. Don't contradict yourself: if your reason says the person already has the role, emit no action for it.",
    "• For bounce messages: emit `mark_email_invalid` only for hard bounces. Soft bounces are review-only — return an empty actions array. Only mark an address invalid if it appears verbatim under the matched person's 'Emails on file' — never invalidate an address that isn't in the CRM context.",
    "• Never emit both `add_email` and `set_primary_email` for the same new address — use a single `add_email` with setPrimary=true instead.",
    "• For grant opportunities: emit one `create_grant_opportunity` per distinct RFP / grant program named, with funderId only if the funder appears in context. Use cold_lead unless the message indicates an active invitation (then warm_lead). Don't invent ask amounts — only set askAmount if the message states one. NEVER create a grant opportunity whose application deadline is already in the past relative to TODAY'S DATE shown below — skip it entirely.",
    "",
    "Suppression (separate from actions):",
    "• Set `suppress.shouldSuppress=true` when the WHOLE proposal is noise the reviewer should never see. Concretely: grant WINNER / recipient announcements (celebrating awards already made, not a new opening); promo / newsletter / event-registration / sponsorship blasts; an RFP to hire a vendor/contractor/consultant (the sender is buying services, not offering grant funding); a grant whose application DEADLINE has already passed relative to TODAY'S DATE shown below; a plain out-of-office / vacation auto-reply where the person is still at their org (only a genuine departure or new-job move is worth surfacing); a signature_update whose parsed name clearly belongs to a different person than the highlighted CRM person; a signature_update where every parsed field (email / phone / title / company) already matches the CRM state so there is nothing new for the reviewer to do.",
    "• When you suppress, you should normally also return an empty actions array.",
    "• Be conservative: suppression hides the item from the reviewer entirely, so when in doubt, leave shouldSuppress=false and let the reviewer decide.",
    "",
    "Return an empty actions array when no automatic mutation is warranted — that is a valid and often correct answer.",
  ].join("\n");
}

function buildUserPrompt(args: {
  proposal: EmailProposal;
  personContext: PersonContext | null;
  funderCandidates: FunderCandidate[];
  organizationCandidates: OrganizationCandidate[];
  funderTargetId: string | null;
  funderTargetName: string | null;
  messageBody: string | null;
}): string {
  const { proposal, personContext, funderCandidates, organizationCandidates, funderTargetId, funderTargetName, messageBody } = args;
  const lines: string[] = [];
  lines.push(`PROPOSAL KIND: ${proposal.kind}`);
  lines.push(`PROPOSAL SUBJECT: ${proposal.subjectName ?? proposal.subjectEmail ?? "(none)"}`);
  lines.push(
    `EMAIL SENT DATE: ${proposal.emailSentAt ? new Date(proposal.emailSentAt).toISOString().slice(0, 10) : "(unknown)"}`,
  );
  lines.push(`TODAY'S DATE: ${new Date().toISOString().slice(0, 10)}`);
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
    lines.push(`  Phones on file:`);
    if (personContext.phones.length === 0) lines.push("    (none)");
    for (const ph of personContext.phones) {
      lines.push(
        `    - id=${ph.id} ${ph.phoneNumber}${ph.isPreferred ? " [PRIMARY]" : ""} type=${ph.type ?? "?"}`,
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
  if (organizationCandidates.length > 0) {
    lines.push(`Organization candidates by name lookup (non-funder employers):`);
    for (const o of organizationCandidates) {
      lines.push(`  - id=${o.id} ${o.name}`);
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
    const [funderCandidatesNested, organizationCandidatesNested] = await Promise.all([
      Promise.all(candidateNames.slice(0, 2).map((n) => findFunderCandidates(n))),
      Promise.all(candidateNames.slice(0, 2).map((n) => findOrganizationCandidates(n))),
    ]);
    const dedupedById = new Map<string, FunderCandidate>();
    for (const list of funderCandidatesNested) {
      for (const c of list) dedupedById.set(c.id, c);
    }
    if (funderTargetId) dedupedById.delete(funderTargetId);
    const funderCandidates = Array.from(dedupedById.values()).slice(0, 8);

    const dedupedOrgsById = new Map<string, OrganizationCandidate>();
    for (const list of organizationCandidatesNested) {
      for (const c of list) dedupedOrgsById.set(c.id, c);
    }
    const organizationCandidates = Array.from(dedupedOrgsById.values()).slice(0, 8);

    // Pull the source message body for prompt context. Some payloads
    // already include a snippet (grant_opportunity, signature) so we
    // fall back to that when the source message id isn't set.
    const messageBody = await loadMessageBody(proposal);

    const userPrompt = buildUserPrompt({
      proposal,
      personContext,
      funderCandidates,
      organizationCandidates,
      funderTargetId,
      funderTargetName,
      messageBody,
    });

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      // Prompt caching: a single cache breakpoint on the system block
      // caches everything before it in the request (the ~2.3k-token tool
      // schema + this ~0.9k-token system prompt). Both are byte-identical
      // on every call, so during bootstrapping batches we pay the full
      // input rate once per ~5-minute window and a ~90%-discounted "cache
      // read" rate thereafter. The per-proposal user prompt stays
      // uncached (it changes every call).
      system: [
        {
          type: "text",
          text: buildSystemPrompt(),
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [ACTION_TOOL_SCHEMA as unknown as Parameters<typeof anthropic.messages.create>[0]["tools"] extends (infer U)[] | undefined ? U : never],
      tool_choice: { type: "tool", name: "propose_actions" },
      messages: [{ role: "user", content: userPrompt }],
    }, {
      // Bound each call so an occasional stalled request on the
      // integration proxy can't freeze a sequential sweep (or hold an
      // inline fire-and-forget) for the SDK's 10-minute default. On
      // timeout the SDK retries (default maxRetries=2) and, if still
      // unresolved, throws — recorded on the row's actions_error so the
      // phase-D retry pass can pick it up later.
      timeout: 60000,
    });

    let actions: ProposedAction[] = [];
    let suppress: { shouldSuppress?: boolean; reason?: string } | null = null;
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "propose_actions") {
        const input = block.input as { actions?: unknown; suppress?: unknown };
        if (Array.isArray(input.actions)) {
          actions = input.actions as ProposedAction[];
        }
        if (input.suppress && typeof input.suppress === "object") {
          suppress = input.suppress as { shouldSuppress?: boolean; reason?: string };
        }
        break;
      }
    }

    // Deterministically reconcile any create_org_with_per against entities
    // already in the CRM. The model only sees the entities we put in its
    // context, so it can propose creating an org for an employer that
    // already exists — most importantly a philanthropic FUNDER (e.g.
    // "Colorado Schools Fund" is a funder, not a non-funder org). For each
    // create_org_with_per we look the named entity up by case-insensitive
    // exact name: a funder match wins (rewrite to create_per on funderId),
    // otherwise an organization match (rewrite to create_per on
    // organizationId). No match keeps the create-org action as proposed.
    actions = await reconcileCreateOrgWithPer(actions);

    // Belt-and-suspenders: deterministically drop any grant opportunity
    // whose application deadline is already in the past relative to
    // today, regardless of what the model returned. Yearless / unparseable
    // deadlines are kept (we never guess a year).
    const now = new Date();
    actions = actions.filter((a) => {
      if (a.type !== "create_grant_opportunity") return true;
      return !deadlineHasPassed(a.deadline ?? null, now);
    });

    // When the model judges the whole proposal to be noise, auto-ignore
    // it so the reviewer never has to triage it. Guard: never suppress a
    // proposal that also carries concrete CRM mutations — if there's
    // something for the reviewer to apply, the item must stay visible.
    const shouldIgnore = suppress?.shouldSuppress === true && actions.length === 0;

    // Two writes, deliberately not combined: the first ALWAYS records the
    // analysis result (clearing the in-flight epoch sentinel), so the row
    // can never get stuck "in flight". The second conditionally
    // auto-ignores, but only for rows still 'pending' — we never flip an
    // accepted/applied row (a reviewer may have acted while the AI was in
    // flight) back to ignored. Folding these into one guarded UPDATE would
    // match zero rows in that race and leave the analysis unrecorded.
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

    if (shouldIgnore) {
      await db
        .update(emailProposals)
        .set({
          status: "ignored" as const,
          resolvedAt: new Date(),
          reviewerNote: `Auto-suppressed: ${
            suppress?.reason ?? "non-actionable noise"
          }`.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(emailProposals.id, proposalId),
            eq(emailProposals.status, "pending"),
          ),
        );
    }

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
