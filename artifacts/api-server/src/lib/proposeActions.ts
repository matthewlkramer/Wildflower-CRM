import { db } from "@workspace/db";
import {
  emailIntelPrompts,
  emailProposals,
  emails as emailsTable,
  households,
  organizations,
  paymentIntermediaries,
  people,
  peopleEntityRoles,
  phoneNumbers,
  type EmailProposal,
} from "@workspace/db/schema";
import { and, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { anthropic, withRateLimitRetry } from "@workspace/integrations-anthropic-ai";
import { deadlineHasPassed } from "./intelDetectors";
import { aiProposalLimit } from "./aiConcurrency";
import { logger } from "./logger";
import { newId } from "./helpers";
import { loadWildflowerUpdateNote } from "./wildflowerUpdatesNote";
import {
  buildActionProposingCorePrompt,
  composeSystemPrompt,
  deriveHideDecision,
  resolveReviewPrompts,
  signalTypeForKind,
} from "./emailIntelPrompts";

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
      // Display-only: the referenced role's title and the name of the
      // entity it's at, set by enrichRoleActionLabels so the review UI can
      // render "Title @ Entity" instead of a raw role id. Not used when
      // applying. Absent when the role no longer resolves.
      roleTitle?: string | null;
      roleEntityName?: string | null;
      reason: string;
    }
  | {
      type: "create_per";
      personId: string;
      // Exactly one of these three must be set; matches the
      // per_entity_discriminator check on people_entity_roles.
      organizationId?: string;
      paymentIntermediaryId?: string;
      householdId?: string;
      // Display-only: human-readable name of the linked entity, set by
      // reconcileCreateOrgWithPer so the review UI can show the entity
      // name instead of a raw id. Not used when applying.
      entityName?: string;
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
      // Like create_org_with_per, but the missing employer is a
      // philanthropic GRANTMAKER (a funder that gives grants/money) not yet
      // in the CRM. Creates the funder in the `funders` table (not
      // organizations) and attaches the role. The MODEL emits this only
      // when the email gives strong evidence the employer is a grantmaker
      // — a name merely containing "Fund"/"Foundation" is NOT enough
      // (operating nonprofits and Wildflower sub-entities use
      // create_org_with_per). Reviewer-gated: nothing is created until
      // accept. reconcileCreateOrgWithPer still dedupes it against existing
      // funders/orgs first.
      type: "create_funder_with_per";
      personId: string;
      funderName: string;
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
      // Display-only: the name of the target the change applies to, set by
      // enrichPersonActionNames so the review UI names the person (or
      // organization) instead of the bare word "person". Not used when
      // applying. Exactly one is set per the email-owner XOR.
      personName?: string | null;
      organizationName?: string | null;
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
      // Display-only: the name of the target (person or organization that
      // owns the email — see add_email).
      personName?: string | null;
      organizationName?: string | null;
      reason: string;
    }
  | {
      type: "mark_email_invalid";
      emailAddress: string;
      reason: string;
    }
  | {
      type: "create_grant_opportunity";
      organizationId?: string;
      organizationName?: string;
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
      // Display-only: the name of the target (person or organization — see
      // add_email).
      personName?: string | null;
      organizationName?: string | null;
      reason: string;
    }
  | {
      type: "update_per_title";
      // Existing people_entity_roles row to set externalTitleOrRole on.
      perId: string;
      externalTitleOrRole: string;
      // Display-only: the referenced role's current title and the name of
      // the entity it's at, set by enrichRoleActionLabels (see
      // deactivate_per). Absent when the role no longer resolves.
      roleTitle?: string | null;
      roleEntityName?: string | null;
      reason: string;
    };

// JSON schema mirror for Claude's input_schema. Keep tightly aligned
// with the TS union above — adding a new action type means editing
// both. The discriminator on "type" is what makes the union parseable.
const ACTION_TOOL_SCHEMA = {
  name: "propose_actions",
  description:
    "Return the structured CRM mutations the reviewer should consider for this email-intelligence proposal. Return an empty array if no actions are warranted — that's a valid response. Separately, set `accuracy` to judge whether the detected signal is genuinely correct, and `suppress` when an accurate proposal is nonetheless noise the reviewer should never have to see. Follow the ACCURACY REVIEW and SUPPRESSION REVIEW criteria given in the system prompt.",
  input_schema: {
    type: "object",
    properties: {
      accuracy: {
        type: "object",
        description:
          "Judge whether the DETECTED SIGNAL is genuinely what it claims to be, per the ACCURACY REVIEW criteria in the system prompt. Set isAccurate=false ONLY when the signal is clearly wrong (e.g. a grant WINNER announcement detected as a new opportunity, a vendor RFP detected as funding, a signature whose name belongs to someone other than the matched person, an out-of-office detected as a departure). An inaccurate proposal is hidden from the reviewer regardless of any actions — be conservative and leave isAccurate=true for borderline-but-plausible signals.",
        required: ["isAccurate", "reason"],
        properties: {
          isAccurate: { type: "boolean" },
          reason: { type: "string", description: "Short justification when isAccurate is false, under 140 chars." },
        },
      },
      suppress: {
        type: "object",
        description:
          "Set shouldSuppress=true ONLY when an ACCURATE proposal is clearly noise the reviewer should not have to triage, per the SUPPRESSION REVIEW criteria in the system prompt — e.g. an opportunity whose application deadline has already passed, a plain out-of-office auto-reply (person still at the org, no new contact), or a signature where every parsed field already matches the CRM. Be conservative: when in doubt, do NOT suppress.",
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
                organizationName: { type: "string", description: "Name of the non-grantmaking organization to create (charter school, school network, nonprofit, company, etc.). Set issuesGrants=false internally." },
                organizationType: {
                  type: "string",
                  enum: ["advocacy_membership_lobbyist", "authorizer", "capital_provider", "government", "corporation", "education_vendor", "elected_official", "higher_ed", "investor", "law_firm", "media", "nonprofit", "philanthropic_advisor", "real_estate", "school", "school_district", "school_network", "small_business_consulting", "tribal"],
                  description: "Best-fit org type when clear. A single charter school → school; a charter school network / CMO → school_network; a school district → school_district.",
                },
                emailDomain: { type: "string", description: "The org's email domain if evident from the sender address (e.g. phoenixcharteracademy.org)." },
                connection: { type: "string", enum: ["employee", "principal", "board_member", "partner", "professor", "donor_advisor", "elected_official"] },
                externalTitleOrRole: { type: "string" },
                reason: { type: "string" },
              },
            },
            {
              type: "object",
              required: ["type", "personId", "funderName", "reason"],
              properties: {
                type: { const: "create_funder_with_per" },
                personId: { type: "string", description: "Existing person ID this new role attaches to." },
                funderName: { type: "string", description: "Name of the philanthropic GRANTMAKER to create — an entity whose role is to give grants/money to grantees (private/community/family foundation, grantmaking trust, corporate giving program). Set issuesGrants=true internally. Do NOT use this for an operating nonprofit, a Wildflower sub-entity, or any org that merely has 'Fund'/'Foundation' in its name — those are create_org_with_per." },
                emailDomain: { type: "string", description: "The grantmaker's email domain if evident from the sender address." },
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
                organizationId: { type: "string" },
                organizationName: { type: "string" },
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
      wildflowerUpdate: {
        type: "object",
        description:
          "OPTIONAL and RARE. Only relevant when a WILDFLOWER UPDATES note is shown in the context. Set one or both sub-objects when THIS email warrants it; omit the whole object otherwise. (a) donorOutreach — propose a cultivation next-step to reach out to this donor about a current Wildflower talking point from the note (set only when there is a matched donor and the note is genuinely relevant to them). (b) noteRevision — propose an edit to the shared note itself when this email contains a concrete, newsworthy Wildflower update the team should add. Be conservative: when in doubt, omit. This is independent of the actions array.",
        properties: {
          donorOutreach: {
            type: "object",
            required: ["title", "rationale"],
            properties: {
              title: {
                type: "string",
                description:
                  "Imperative, specific outreach task title (e.g. 'Share new microschool launch with Jane Doe'). Under 100 chars.",
              },
              description: {
                type: "string",
                description:
                  "1-3 sentences of concrete guidance on the outreach, referencing the relevant Wildflower update.",
              },
              rationale: {
                type: "string",
                description:
                  "Why this donor + this update now. Under 240 chars.",
              },
            },
          },
          noteRevision: {
            type: "object",
            required: ["proposedContent", "rationale"],
            properties: {
              proposedContent: {
                type: "string",
                description:
                  "The full proposed NEW text of the shared Wildflower updates note (the human reviewer can edit before applying). Incorporate the new information rather than only describing the delta.",
              },
              rationale: {
                type: "string",
                description:
                  "What in this email justifies revising the shared note. Under 240 chars.",
              },
            },
          },
        },
      },
    },
    required: ["actions"],
  },
} as const;

/**
 * Optional model output describing Wildflower-update follow-ups for a single
 * email. Materialized into separate `kind='wildflower_update'` email_proposals
 * rows (already analyzed — no further AI). `donorOutreach` accept mints a
 * cultivation task; `noteRevision` accept applies the edit to the shared note
 * after human review.
 */
type WildflowerUpdateToolOutput = {
  donorOutreach?: {
    title?: string;
    description?: string;
    rationale?: string;
  };
  noteRevision?: {
    proposedContent?: string;
    rationale?: string;
  };
};

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
    organizationId: string | null;
    connection: string | null;
    externalTitleOrRole: string | null;
    current: string;
    // The role entity's known prior names + free-text aliases, so the model
    // can recognize a signature still naming a former/alias name as the SAME
    // employer (no rename / no duplicate-org proposal).
    entityHistoricalNames: string[] | null;
    entityOtherNames: string | null;
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
        organizationId: peopleEntityRoles.organizationId,
        organizationName: organizations.name,
        organizationHistoricalNames: organizations.historicalNames,
        organizationOtherNames: organizations.otherNames,
        connection: peopleEntityRoles.connection,
        externalTitleOrRole: peopleEntityRoles.externalTitleOrRole,
        current: peopleEntityRoles.current,
      })
      .from(peopleEntityRoles)
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
      entityName: r.organizationName ?? null,
      organizationId: r.organizationId,
      connection: r.connection,
      externalTitleOrRole: r.externalTitleOrRole,
      current: r.current,
      entityHistoricalNames: r.organizationHistoricalNames ?? null,
      entityOtherNames: r.organizationOtherNames ?? null,
    })),
  };
}

// Resolve a CRM person from an email address (exact, case-insensitive).
// Used as a fallback when a proposal has no targetPersonId but its subject
// email is on file for a person — e.g. a bounce row created before we started
// linking the bounced address to its owner. Lets reviewer guidance like
// "mark the role inactive" reach that person's roles (+ perId).
async function resolvePersonByEmail(email: string | null): Promise<string | null> {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;
  // Normalized equality (NOT ilike — '%'/'_' in an address are literal text,
  // not LIKE wildcards). An address belongs to at most one person, though the
  // same address may also sit on an org/household row (personId null), so
  // filter to the person owner. Order by id so the match is deterministic.
  const [row] = await db
    .select({ personId: emailsTable.personId })
    .from(emailsTable)
    .where(
      and(
        eq(sql`lower(${emailsTable.email})`, normalized),
        isNotNull(emailsTable.personId),
      ),
    )
    .orderBy(emailsTable.id)
    .limit(1);
  return row?.personId ?? null;
}

interface OrganizationCandidate {
  id: string;
  name: string;
  issuesGrants: boolean;
}

// Search organizations table by name — covers both grantmakers (issuesGrants=true)
// and non-grantmakers (issuesGrants=false). Also matches an org's known PRIOR
// names (`historicalNames`) and free-text aliases (`otherNames`) so a signature
// still referencing a former name resolves to the existing org instead of
// looking brand-new. Two-pass on the primary name (exact-ish, then loose
// substring); prior/other names match on substring. Cap at 5 so the prompt
// stays small.
async function findOrganizationCandidates(
  name: string | null | undefined,
): Promise<OrganizationCandidate[]> {
  if (!name || name.trim().length < 3) return [];
  const term = name.trim().toLowerCase();
  const rows = await db
    .select({ id: organizations.id, name: organizations.name, issuesGrants: organizations.issuesGrants })
    .from(organizations)
    .where(
      or(
        ilike(organizations.name, term),
        ilike(organizations.name, `%${term}%`),
        sql`EXISTS (SELECT 1 FROM unnest(${organizations.historicalNames}) AS hn WHERE hn ILIKE ${`%${term}%`})`,
        ilike(organizations.otherNames, `%${term}%`),
      ),
    )
    .limit(5);
  return rows
    .filter((r): r is { id: string; name: string; issuesGrants: boolean } => r.name !== null)
    .map((r) => ({ id: r.id, name: r.name, issuesGrants: r.issuesGrants }));
}

// Resolve an organization by the sender's email domain (e.g.
// "edforwarddc.org"). Critical for departure / "I've moved" auto-replies
// where the subject person is NOT a matched CRM record (so there's no
// role context to surface the org) but the email still names a successor
// at the same org. The org's emailDomain column ties the sender domain to
// an existing entity so the model can attach the new contact to it.
async function findOrganizationsByDomain(
  domain: string | null | undefined,
): Promise<OrganizationCandidate[]> {
  const term = domain?.trim().toLowerCase();
  if (!term || !term.includes(".")) return [];
  const rows = await db
    .select({ id: organizations.id, name: organizations.name, issuesGrants: organizations.issuesGrants })
    .from(organizations)
    .where(ilike(organizations.emailDomain, term))
    .limit(5);
  return rows
    .filter((r): r is { id: string; name: string; issuesGrants: boolean } => r.name !== null)
    .map((r) => ({ id: r.id, name: r.name, issuesGrants: r.issuesGrants }));
}

// Extract the domain part of an email address ("a@b.org" -> "b.org").
function emailDomainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.includes(".") ? domain : null;
}

// Dedupe "create a new employer + attach role" actions against the CRM.
// Both create_org_with_per and create_funder_with_per name an employer the
// model believes is missing. Before we propose creating it, look the name
// up in the organizations table: if any organization of that name already
// exists — under its primary name, a known PRIOR name (`historicalNames`,
// exact element match), or its free-text aliases (`otherNames`, substring) —
// rewrite to a plain create_per against that existing entity so we never
// propose a duplicate for a renamed/aliased org. Primary/prior-name matching
// is case-insensitive; % / _ are escaped so names can't act as LIKE
// wildcards. With no match the action is kept exactly as the model emitted it.
async function reconcileCreateOrgWithPer(
  actions: ProposedAction[],
): Promise<ProposedAction[]> {
  const escapeLike = (s: string) => s.replace(/([%_\\])/g, "\\$1");
  const out: ProposedAction[] = [];
  for (const action of actions) {
    if (
      action.type !== "create_org_with_per" &&
      action.type !== "create_funder_with_per"
    ) {
      out.push(action);
      continue;
    }
    const name =
      action.type === "create_org_with_per"
        ? action.organizationName?.trim()
        : action.funderName?.trim();
    if (!name) {
      out.push(action);
      continue;
    }
    const pattern = escapeLike(name);
    const [orgMatch] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        or(
          ilike(organizations.name, pattern),
          sql`EXISTS (SELECT 1 FROM unnest(${organizations.historicalNames}) AS hn WHERE hn ILIKE ${pattern})`,
          ilike(organizations.otherNames, `%${pattern}%`),
        ),
      )
      .limit(1);
    if (orgMatch) {
      out.push({
        type: "create_per",
        personId: action.personId,
        organizationId: orgMatch.id,
        entityName: name,
        connection: action.connection,
        externalTitleOrRole: action.externalTitleOrRole,
        reason: `${action.reason} (linked to existing organization "${name}" already in CRM)`,
      });
      continue;
    }
    // No existing organization of that name — keep the model's action
    // as-is. Nothing is created until a reviewer accepts.
    out.push(action);
  }
  return out;
}

// Fill the display-only `entityName` on every create_per that links an
// existing funder / organization / payment intermediary / household by id,
// so the review UI shows the entity name instead of a raw record id.
// Batched one query per entity type. Ids that no longer resolve are left
// without a name (the UI falls back to the id).
async function enrichCreatePerEntityNames(
  actions: ProposedAction[],
): Promise<ProposedAction[]> {
  const creates = actions.filter(
    (a): a is Extract<ProposedAction, { type: "create_per" }> =>
      a.type === "create_per",
  );
  if (creates.length === 0) return actions;

  const ids = {
    organization: new Set<string>(),
    paymentIntermediary: new Set<string>(),
    household: new Set<string>(),
  };
  for (const a of creates) {
    if (a.organizationId) ids.organization.add(a.organizationId);
    else if (a.paymentIntermediaryId) ids.paymentIntermediary.add(a.paymentIntermediaryId);
    else if (a.householdId) ids.household.add(a.householdId);
  }

  const nameOf = new Map<string, string>();
  const load = async (
    set: Set<string>,
    table: typeof organizations | typeof paymentIntermediaries | typeof households,
  ) => {
    if (set.size === 0) return;
    const rows = await db
      .select({ id: table.id, name: table.name })
      .from(table)
      .where(inArray(table.id, [...set]));
    for (const r of rows) if (r.name) nameOf.set(r.id, r.name);
  };
  await Promise.all([
    load(ids.organization, organizations),
    load(ids.paymentIntermediary, paymentIntermediaries),
    load(ids.household, households),
  ]);

  return actions.map((a) => {
    if (a.type !== "create_per") return a;
    const id =
      a.organizationId ?? a.paymentIntermediaryId ?? a.householdId;
    const name = id ? nameOf.get(id) : undefined;
    return name ? { ...a, entityName: name } : a;
  });
}

// Fill the display-only name on every person-targeted action (set_phone /
// add_email / set_primary_email) so the review UI names the target instead
// of the bare word "person". Phone/email rows are owned by exactly one of
// a person OR an organization (the email-owner XOR), so we resolve both:
// person targets get `personName`, organization-owned targets get
// `organizationName`. set_primary_email may carry only an emailId, so we
// resolve that to its owner (person or organization) first. Ids that no
// longer resolve are left without a name (the UI falls back to "person").
async function enrichPersonActionNames(
  actions: ProposedAction[],
): Promise<ProposedAction[]> {
  const isPersonAction = (
    a: ProposedAction,
  ): a is Extract<
    ProposedAction,
    { type: "set_phone" | "add_email" | "set_primary_email" }
  > =>
    a.type === "set_phone" ||
    a.type === "add_email" ||
    a.type === "set_primary_email";

  // An organization id may ride along on any of these actions even though
  // the JSON schema only names personId — the union allows extra fields and
  // the email-owner XOR means a target can be an organization. Read it
  // defensively without widening the typed shape.
  const orgIdOf = (a: ProposedAction): string | undefined => {
    const v = (a as { organizationId?: unknown }).organizationId;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };

  const targets = actions.filter(isPersonAction);
  if (targets.length === 0) return actions;

  const personIds = new Set<string>();
  const orgIds = new Set<string>();
  const emailIds = new Set<string>();
  for (const a of targets) {
    const org = orgIdOf(a);
    if (org) orgIds.add(org);
    if (a.type === "set_primary_email") {
      if (a.personId) personIds.add(a.personId);
      else if (!org && a.emailId) emailIds.add(a.emailId);
    } else if (a.personId) {
      personIds.add(a.personId);
    }
  }

  // Resolve set_primary_email rows that only carry an emailId to their
  // owner (person or organization), so we can name them too.
  const emailToPerson = new Map<string, string>();
  const emailToOrg = new Map<string, string>();
  if (emailIds.size > 0) {
    const rows = await db
      .select({
        id: emailsTable.id,
        personId: emailsTable.personId,
        organizationId: emailsTable.organizationId,
      })
      .from(emailsTable)
      .where(inArray(emailsTable.id, [...emailIds]));
    for (const r of rows) {
      if (r.personId) {
        emailToPerson.set(r.id, r.personId);
        personIds.add(r.personId);
      } else if (r.organizationId) {
        emailToOrg.set(r.id, r.organizationId);
        orgIds.add(r.organizationId);
      }
    }
  }

  if (personIds.size === 0 && orgIds.size === 0) return actions;
  const personNameOf = new Map<string, string>();
  const orgNameOf = new Map<string, string>();
  await Promise.all([
    (async () => {
      if (personIds.size === 0) return;
      const rows = await db
        .select({ id: people.id, fullName: people.fullName })
        .from(people)
        .where(inArray(people.id, [...personIds]));
      for (const r of rows) if (r.fullName) personNameOf.set(r.id, r.fullName);
    })(),
    (async () => {
      if (orgIds.size === 0) return;
      const rows = await db
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(inArray(organizations.id, [...orgIds]));
      for (const r of rows) if (r.name) orgNameOf.set(r.id, r.name);
    })(),
  ]);

  return actions.map((a) => {
    if (!isPersonAction(a)) return a;
    // A person target wins; otherwise fall back to an organization target.
    const personId =
      a.type === "set_primary_email"
        ? a.personId ?? (a.emailId ? emailToPerson.get(a.emailId) : undefined)
        : a.personId;
    const personName = personId ? personNameOf.get(personId) : undefined;
    if (personName) return { ...a, personName };

    const orgId =
      orgIdOf(a) ??
      (a.type === "set_primary_email" && a.emailId
        ? emailToOrg.get(a.emailId)
        : undefined);
    const orgName = orgId ? orgNameOf.get(orgId) : undefined;
    if (orgName) return { ...a, organizationName: orgName };

    return a;
  });
}

// Fill the display-only `roleTitle` / `roleEntityName` on every
// role-targeted action (deactivate_per / update_per_title) so the review
// UI can render "Title @ Entity" instead of an opaque role record id.
// Looks up the referenced people_entity_roles row, then resolves the name
// of the entity (organization / payment intermediary / household) it's at.
// Roles that no longer resolve are left unenriched (the UI falls back to
// the id-based text).
async function enrichRoleActionLabels(
  actions: ProposedAction[],
): Promise<ProposedAction[]> {
  const isRoleAction = (
    a: ProposedAction,
  ): a is Extract<
    ProposedAction,
    { type: "deactivate_per" | "update_per_title" }
  > => a.type === "deactivate_per" || a.type === "update_per_title";

  const perIds = new Set<string>();
  for (const a of actions) if (isRoleAction(a) && a.perId) perIds.add(a.perId);
  if (perIds.size === 0) return actions;

  const roleRows = await db
    .select({
      id: peopleEntityRoles.id,
      externalTitleOrRole: peopleEntityRoles.externalTitleOrRole,
      organizationId: peopleEntityRoles.organizationId,
      paymentIntermediaryId: peopleEntityRoles.paymentIntermediaryId,
      householdId: peopleEntityRoles.householdId,
    })
    .from(peopleEntityRoles)
    .where(inArray(peopleEntityRoles.id, [...perIds]));

  const entityIds = {
    organization: new Set<string>(),
    paymentIntermediary: new Set<string>(),
    household: new Set<string>(),
  };
  for (const r of roleRows) {
    if (r.organizationId) entityIds.organization.add(r.organizationId);
    else if (r.paymentIntermediaryId)
      entityIds.paymentIntermediary.add(r.paymentIntermediaryId);
    else if (r.householdId) entityIds.household.add(r.householdId);
  }

  const entityNameOf = new Map<string, string>();
  const loadNames = async (
    set: Set<string>,
    table: typeof organizations | typeof paymentIntermediaries | typeof households,
  ) => {
    if (set.size === 0) return;
    const rows = await db
      .select({ id: table.id, name: table.name })
      .from(table)
      .where(inArray(table.id, [...set]));
    for (const r of rows) if (r.name) entityNameOf.set(r.id, r.name);
  };
  await Promise.all([
    loadNames(entityIds.organization, organizations),
    loadNames(entityIds.paymentIntermediary, paymentIntermediaries),
    loadNames(entityIds.household, households),
  ]);

  const labelOf = new Map<
    string,
    { roleTitle: string | null; roleEntityName: string | null }
  >();
  for (const r of roleRows) {
    const entityId =
      r.organizationId ?? r.paymentIntermediaryId ?? r.householdId;
    labelOf.set(r.id, {
      roleTitle: r.externalTitleOrRole ?? null,
      roleEntityName: entityId ? entityNameOf.get(entityId) ?? null : null,
    });
  }

  return actions.map((a) => {
    if (!isRoleAction(a)) return a;
    const label = labelOf.get(a.perId);
    if (!label) return a;
    return {
      ...a,
      roleTitle: label.roleTitle,
      roleEntityName: label.roleEntityName,
    };
  });
}

// ──────────────────────────────────────────────────────────────────
// Prompt builder
// ──────────────────────────────────────────────────────────────────

function buildUserPrompt(args: {
  proposal: EmailProposal;
  personContext: PersonContext | null;
  organizationCandidates: OrganizationCandidate[];
  targetOrgId: string | null;
  targetOrgName: string | null;
  messageBody: string | null;
  reviewerGuidance?: string | null;
  wildflowerNote?: string | null;
}): string {
  const { proposal, personContext, organizationCandidates, targetOrgId, targetOrgName, messageBody, reviewerGuidance, wildflowerNote } = args;
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
        `    - id=${r.id} ${r.current.toUpperCase()} at ${r.entityName ?? "?"} (${r.entityType}, ${r.connection ?? "?"})${r.externalTitleOrRole ? ` title="${r.externalTitleOrRole}"` : ""}${r.organizationId ? ` organizationId=${r.organizationId}` : ""}`,
      );
      const aka: string[] = [];
      if (r.entityHistoricalNames && r.entityHistoricalNames.length > 0) {
        aka.push(`prior names: ${r.entityHistoricalNames.join(", ")}`);
      }
      if (r.entityOtherNames && r.entityOtherNames.trim().length > 0) {
        aka.push(`other names: ${r.entityOtherNames.trim()}`);
      }
      if (aka.length > 0) {
        lines.push(
          `        (same entity also known as — ${aka.join("; ")})`,
        );
      }
    }
  } else {
    lines.push("No matched person on file.");
  }
  if (targetOrgId) {
    lines.push(`Matched organization: id=${targetOrgId} name=${targetOrgName ?? "?"}`);
  }
  if (organizationCandidates.length > 0) {
    lines.push(`Organization candidates by name lookup:`);
    for (const o of organizationCandidates) {
      lines.push(`  - id=${o.id} ${o.name}${o.issuesGrants ? " [grantmaker]" : ""}`);
    }
  }
  if (messageBody) {
    lines.push("");
    lines.push("EMAIL MESSAGE (truncated to 4000 chars):");
    lines.push(messageBody.slice(0, 4000));
  }
  if (wildflowerNote && wildflowerNote.trim()) {
    lines.push("");
    lines.push(
      "WILDFLOWER UPDATES (the team's current shared talking points / news — consider whether this email warrants a donor-outreach suggestion or a revision to this note, via the optional `wildflowerUpdate` tool field):",
    );
    lines.push(wildflowerNote.trim().slice(0, 4000));
  }
  if (reviewerGuidance && reviewerGuidance.trim()) {
    lines.push("");
    lines.push(
      "REVIEWER GUIDANCE (a human reviewer corrected the previous suggestion — treat this as authoritative and honor it when proposing actions; where it conflicts with your own interpretation, follow the reviewer):",
    );
    lines.push(reviewerGuidance.trim().slice(0, 2000));
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
export async function proposeActionsForProposal(
  proposalId: string,
  opts?: { reviewerGuidance?: string | null; disableAutoSuppress?: boolean },
): Promise<{
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
    let personContext = proposal.targetPersonId
      ? await loadPersonContext(proposal.targetPersonId)
      : null;
    // Fallback for BOUNCE proposals with no explicit person link (older bounce
    // rows created before we linked the bounced address to its owner): if the
    // subject email is unambiguously on file for one CRM person, load that
    // person's context so reviewer guidance can act on their roles (+ perId).
    // Scoped to bounces on purpose — for a non-bounce proposal the subject
    // email is the sender/correspondent, not necessarily the record an action
    // targets, so resolving it could inject the wrong person's context.
    if (
      !personContext &&
      (proposal.kind === "bounce_invalid" || proposal.kind === "bounce_soft")
    ) {
      const resolvedPersonId = await resolvePersonByEmail(proposal.subjectEmail);
      if (resolvedPersonId) personContext = await loadPersonContext(resolvedPersonId);
    }

    // For the organization side: prefer the detector-emitted hint
    // (targetFunderId, stored legacy name), else attempt a name lookup
    // against payload hints (newCompany / funderName / sender name).
    let targetOrgId = proposal.targetOrganizationId;
    let targetOrgName: string | null = null;
    if (targetOrgId) {
      const [o] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, targetOrgId))
        .limit(1);
      targetOrgName = o?.name ?? null;
    }
    const payload = (proposal.payload ?? {}) as Record<string, unknown>;
    const candidateNames = [
      payload.newCompany,
      payload.funderName,
      proposal.subjectName,
    ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    const organizationCandidatesNested = await Promise.all(
      candidateNames.slice(0, 2).map((n) => findOrganizationCandidates(n)),
    );
    const dedupedOrgsById = new Map<string, OrganizationCandidate>();
    for (const list of organizationCandidatesNested) {
      for (const c of list) dedupedOrgsById.set(c.id, c);
    }
    // Also resolve the sender's email domain to an existing org. This is
    // what lets a departure / "I've moved" auto-reply attach the named
    // successor to the right org even when the subject person isn't a
    // matched CRM record (no role context to surface the org otherwise).
    const senderDomain =
      emailDomainOf(proposal.subjectEmail) ??
      emailDomainOf(typeof payload.fromEmail === "string" ? payload.fromEmail : null);
    const domainOrgs = await findOrganizationsByDomain(senderDomain);
    for (const c of domainOrgs) dedupedOrgsById.set(c.id, c);
    if (targetOrgId) dedupedOrgsById.delete(targetOrgId);
    const organizationCandidates = Array.from(dedupedOrgsById.values()).slice(0, 8);

    // Pull the source message body for prompt context. Some payloads
    // already include a snippet (grant_opportunity, signature) so we
    // fall back to that when the source message id isn't set.
    const messageBody = await loadMessageBody(proposal);

    const wildflowerNote = await loadWildflowerUpdateNote();
    const userPrompt = buildUserPrompt({
      proposal,
      personContext,
      organizationCandidates,
      targetOrgId,
      targetOrgName,
      messageBody,
      reviewerGuidance: opts?.reviewerGuidance ?? null,
      wildflowerNote,
    });

    // Build the system prompt: the hidden, hard-coded action-proposing core
    // (how to act) + the admin-editable accuracy & suppression REVIEW prompts
    // for THIS proposal's signal type (active DB version per phase, or the
    // built-in default). Done once here so the same text drives both the
    // request and the prompt-cache key for this call. A proposal whose kind
    // maps to no review signal type (defensive — wildflower_update rows never
    // reach this path) falls back to the core alone.
    const signalType = signalTypeForKind(proposal.kind);
    let systemPrompt: string;
    if (signalType) {
      const reviewPrompts = await resolveReviewPrompts(signalType);
      systemPrompt = composeSystemPrompt({
        signalType,
        accuracyPrompt: reviewPrompts.accuracy,
        suppressionPrompt: reviewPrompts.suppression,
      });
    } else {
      systemPrompt = buildActionProposingCorePrompt();
    }

    // Route the AI call through (a) a process-global concurrency limiter so
    // a sync's inline fan-out can't burst many simultaneous requests at the
    // shared integration proxy, and (b) a rate-limit-aware retry that backs
    // off on transient 429 / RATELIMIT_EXCEEDED / quota responses (honoring
    // retry-after when the proxy sends it) instead of letting them land as a
    // permanent actions_error. Non-rate-limit errors still fail fast and are
    // recorded below. We disable the SDK's own retries (maxRetries: 0) so
    // backoff is owned solely by withRateLimitRetry — no double-retrying.
    const response = await aiProposalLimit(() =>
      withRateLimitRetry(
        () =>
          anthropic.messages.create({
            model: MODEL,
            max_tokens: 8192,
            // Prompt caching: a single cache breakpoint on the system block
            // caches everything before it in the request (the ~2.3k-token
            // tool schema + this ~0.9k-token system prompt). Both are
            // byte-identical on every call, so during bootstrapping batches
            // we pay the full input rate once per ~5-minute window and a
            // ~90%-discounted "cache read" rate thereafter. The per-proposal
            // user prompt stays uncached (it changes every call).
            system: [
              {
                type: "text",
                text: systemPrompt,
                cache_control: { type: "ephemeral" },
              },
            ],
            tools: [ACTION_TOOL_SCHEMA as unknown as Parameters<typeof anthropic.messages.create>[0]["tools"] extends (infer U)[] | undefined ? U : never],
            tool_choice: { type: "tool", name: "propose_actions" },
            messages: [{ role: "user", content: userPrompt }],
          }, {
            // Bound each call so an occasional stalled request on the
            // integration proxy can't freeze a sequential sweep (or hold an
            // inline fire-and-forget) for the SDK's 10-minute default. The
            // retry/backoff is owned by withRateLimitRetry, so turn off the
            // SDK's built-in retries to avoid stacking two backoff loops.
            timeout: 60000,
            maxRetries: 0,
          }),
        {
          onRetry: ({ attempt, delayMs }) =>
            logger.info(
              { proposalId, attempt, delayMs },
              "proposeActionsForProposal: rate-limited, backing off",
            ),
        },
      ),
    );

    let actions: ProposedAction[] = [];
    let accuracy: { isAccurate?: boolean; reason?: string } | null = null;
    let suppress: { shouldSuppress?: boolean; reason?: string } | null = null;
    let wildflowerUpdate: WildflowerUpdateToolOutput | null = null;
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "propose_actions") {
        const input = block.input as {
          actions?: unknown;
          accuracy?: unknown;
          suppress?: unknown;
          wildflowerUpdate?: unknown;
        };
        if (Array.isArray(input.actions)) {
          actions = input.actions as ProposedAction[];
        }
        if (input.accuracy && typeof input.accuracy === "object") {
          accuracy = input.accuracy as { isAccurate?: boolean; reason?: string };
        }
        if (input.suppress && typeof input.suppress === "object") {
          suppress = input.suppress as { shouldSuppress?: boolean; reason?: string };
        }
        if (input.wildflowerUpdate && typeof input.wildflowerUpdate === "object") {
          wildflowerUpdate = input.wildflowerUpdate as WildflowerUpdateToolOutput;
        }
        break;
      }
    }

    // Deterministically reconcile any create_org_with_per OR
    // create_funder_with_per against entities already in the CRM. The model
    // only sees the entities we put in its context, so it can propose
    // creating an entity for an employer that already exists. For each such
    // action we look the named entity up by case-insensitive exact name: a
    // funder match wins (rewrite to create_per on funderId), otherwise an
    // organization match (rewrite to create_per on organizationId). No match
    // keeps the model's chosen create action (org or funder) as proposed.
    actions = await reconcileCreateOrgWithPer(actions);

    // Resolve a human-readable entityName for every create_per that links
    // an existing funder/org/intermediary/household by id, so the review UI
    // can show the entity name instead of a raw record id. Covers both
    // model-emitted create_per (ids drawn from context) and the
    // reconciler-rewritten ones.
    actions = await enrichCreatePerEntityNames(actions);

    // Name the person on phone/email actions and attach the role's
    // title + entity name on the two role actions, so the review UI can
    // render readable descriptions instead of bare "person" / raw role ids.
    actions = await enrichPersonActionNames(actions);
    actions = await enrichRoleActionLabels(actions);

    // Belt-and-suspenders: deterministically drop any grant opportunity
    // whose application deadline is already in the past relative to
    // today, regardless of what the model returned. Yearless / unparseable
    // deadlines are kept (we never guess a year).
    const now = new Date();
    actions = actions.filter((a) => {
      if (a.type !== "create_grant_opportunity") return true;
      return !deadlineHasPassed(a.deadline ?? null, now);
    });

    // Decide whether to auto-hide the proposal from the reviewer, and why.
    // Two distinct reasons: an INACCURATE signal (hidden regardless of any
    // actions — the detection itself is wrong) takes precedence over
    // SUPPRESSION of an accurate-but-noise proposal (only when it carries no
    // concrete mutations). `disableAutoSuppress` (the reviewer-driven /revise
    // path) keeps the proposal pending no matter what the model returns: the
    // reviewer explicitly asked to re-run it and expects it to stay in their
    // queue. See deriveHideDecision for the full precedence.
    const hideDecision = deriveHideDecision({
      disableAutoSuppress: opts?.disableAutoSuppress,
      actionsCount: actions.length,
      accuracy,
      suppress,
    });

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

    if (hideDecision.hide) {
      await db
        .update(emailProposals)
        .set({
          status: hideDecision.status,
          resolvedAt: new Date(),
          reviewerNote: hideDecision.reviewerNote,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(emailProposals.id, proposalId),
            eq(emailProposals.status, "pending"),
          ),
        );
    }

    // Materialize any Wildflower-update follow-ups the model proposed into
    // their own standalone `kind='wildflower_update'` rows so they surface in
    // the email-intelligence queue alongside the source proposal. These are
    // already fully analyzed (no further AI): we stamp actionsAnalyzedAt and
    // leave proposedActions empty. Dedupe mirrors upsertProposal's partial
    // (mailbox_user_id, dedupe_key) WHERE status='pending' unique index.
    if (wildflowerUpdate) {
      await materializeWildflowerUpdateProposals({
        sourceProposal: proposal,
        wildflowerUpdate,
      });
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

/**
 * Insert standalone `kind='wildflower_update'` proposal rows for the donor-
 * outreach and/or note-revision follow-ups the model proposed for a source
 * email. Rows are inserted already-analyzed (no further AI). Dedupe is the
 * partial unique (mailbox_user_id, dedupe_key) WHERE status='pending' index,
 * so a re-emit while a prior identical row is still pending is a no-op.
 */
async function materializeWildflowerUpdateProposals(args: {
  sourceProposal: EmailProposal;
  wildflowerUpdate: WildflowerUpdateToolOutput;
}): Promise<void> {
  const { sourceProposal: src, wildflowerUpdate } = args;
  const now = new Date();

  type WfRow = {
    dedupeKey: string;
    payload: Record<string, unknown>;
    targetPersonId: string | null;
    targetOrganizationId: string | null;
  };
  const rows: WfRow[] = [];

  // donor_outreach — only when we actually have a donor to reach out to.
  const outreach = wildflowerUpdate.donorOutreach;
  const donorKey = src.targetPersonId ?? src.targetOrganizationId ?? null;
  if (outreach && outreach.title && donorKey) {
    rows.push({
      dedupeKey: `wf_update:outreach:${donorKey}`,
      targetPersonId: src.targetPersonId ?? null,
      targetOrganizationId: src.targetOrganizationId ?? null,
      payload: {
        flavor: "donor_outreach",
        title: outreach.title,
        description: outreach.description ?? null,
        rationale: outreach.rationale ?? null,
        sourceProposalId: src.id,
      },
    });
  }

  // note_revision — only when the model proposed concrete new note content.
  const revision = wildflowerUpdate.noteRevision;
  if (revision && revision.proposedContent && revision.proposedContent.trim()) {
    rows.push({
      dedupeKey: `wf_update:revision:${src.sourceMessageId ?? src.id}`,
      targetPersonId: src.targetPersonId ?? null,
      targetOrganizationId: src.targetOrganizationId ?? null,
      payload: {
        flavor: "note_revision",
        proposedContent: revision.proposedContent,
        rationale: revision.rationale ?? null,
        sourceProposalId: src.id,
      },
    });
  }

  for (const row of rows) {
    await db
      .insert(emailProposals)
      .values({
        id: newId(),
        mailboxUserId: src.mailboxUserId,
        kind: "wildflower_update",
        dedupeKey: row.dedupeKey,
        sourceMessageId: src.sourceMessageId ?? null,
        targetPersonId: row.targetPersonId,
        targetOrganizationId: row.targetOrganizationId,
        subjectEmail: src.subjectEmail ?? null,
        subjectName: src.subjectName ?? null,
        subjectDomain: src.subjectDomain ?? null,
        emailSentAt: src.emailSentAt ?? null,
        payload: row.payload,
        proposedActions: [],
        actionsAnalyzedAt: now,
        actionsModel: MODEL,
      })
      .onConflictDoNothing({
        target: [emailProposals.mailboxUserId, emailProposals.dedupeKey],
        where: sql`status = 'pending'`,
      });
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
