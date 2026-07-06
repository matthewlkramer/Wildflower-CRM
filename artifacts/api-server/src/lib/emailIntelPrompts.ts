import { db } from "@workspace/db";
import {
  emailIntelPrompts,
  emailIntelReviewPhaseEnum,
  emailIntelSignalTypeEnum,
  emailProposalKindEnum,
} from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";

type EmailProposalKind = (typeof emailProposalKindEnum.enumValues)[number];

/**
 * Email-intelligence prompt model (post split — task: review-prompt rework).
 *
 * The single global system prompt that used to drive the action-proposal
 * pipeline has been split in two:
 *
 *   1. A HIDDEN, hard-coded "action-proposing core" — the *how to act*
 *      instructions (which CRM mutation to emit for a given signal). It lives
 *      ONLY in this file: admins can neither see nor edit it, and it is never
 *      stored in the DB. `buildActionProposingCorePrompt()` returns it.
 *
 *   2. Admin-editable REVIEW prompts, one per (signal type, review phase):
 *        - accuracy    — is the detected signal actually correct?
 *        - suppression — even if accurate, is it worth a human's attention?
 *      These are versioned in `email_intel_prompts` (keyed on signal_type +
 *      review_phase). When no active version exists for a key the pipeline
 *      falls back to the built-in default (`buildDefaultReviewPrompt`).
 *
 * `composeSystemPrompt()` stitches the hidden core together with the resolved
 * accuracy + suppression review prompts for a single proposal's signal type to
 * form the full system prompt sent to the model.
 *
 * `wildflower_update` proposals are intentionally OUTSIDE this model: they are
 * materialized already-analyzed and never call the review step, so they have no
 * signal type here.
 */

export type EmailIntelSignalType =
  (typeof emailIntelSignalTypeEnum.enumValues)[number];
export type EmailIntelReviewPhase =
  (typeof emailIntelReviewPhaseEnum.enumValues)[number];

export const EMAIL_INTEL_SIGNAL_TYPES: readonly EmailIntelSignalType[] =
  emailIntelSignalTypeEnum.enumValues;
export const EMAIL_INTEL_REVIEW_PHASES: readonly EmailIntelReviewPhase[] =
  emailIntelReviewPhaseEnum.enumValues;

/**
 * Map an `email_proposals.kind` to the review signal type it is reviewed
 * under. The two bounce kinds collapse to `bounce`; `wildflower_update`
 * (and any future non-reviewed kind) maps to null — those rows never go
 * through the AI review step.
 */
export function signalTypeForKind(kind: string): EmailIntelSignalType | null {
  switch (kind) {
    case "linkedin_job_change":
      return "linkedin_job_change";
    case "auto_responder_move":
      return "auto_responder_move";
    case "bounce_invalid":
    case "bounce_soft":
      return "bounce";
    case "signature_update":
      return "signature_update";
    case "grant_opportunity":
      return "grant_opportunity";
    case "thank_you_acknowledgment":
      return "thank_you_acknowledgment";
    default:
      return null;
  }
}

/**
 * The `email_proposals.kind` values that a review signal type covers — the
 * inverse of `signalTypeForKind`. Used to scope reviewer-feedback samples to
 * the right signal when generating an improved review prompt. `bounce` fans
 * back out to both bounce kinds; every other signal type maps 1:1.
 */
export function kindsForSignalType(
  signalType: EmailIntelSignalType,
): EmailProposalKind[] {
  return signalType === "bounce"
    ? ["bounce_invalid", "bounce_soft"]
    : [signalType];
}

const SIGNAL_TYPE_LABELS: Record<EmailIntelSignalType, string> = {
  linkedin_job_change: "LinkedIn job change",
  auto_responder_move: "Auto-responder / departure",
  bounce: "Email bounce",
  signature_update: "Email signature update",
  grant_opportunity: "Grant opportunity",
  thank_you_acknowledgment: "Thank-you acknowledgment",
};

export function signalTypeLabel(signalType: EmailIntelSignalType): string {
  return SIGNAL_TYPE_LABELS[signalType];
}

// ──────────────────────────────────────────────────────────────────
// Hidden action-proposing core (how to act) — never stored, never shown
// ──────────────────────────────────────────────────────────────────

/**
 * The hidden, hard-coded core system prompt. It defines the steward role,
 * the tool-call contract, and ALL "how to act" rules (which mutation to
 * emit for each signal). It deliberately contains NO accuracy/suppression
 * CRITERIA — those are the admin-editable review prompts appended after it
 * by `composeSystemPrompt`. This is never persisted and never returned by
 * any API: admins cannot see or edit it.
 */
export function buildActionProposingCorePrompt(): string {
  return [
    "You are a fundraising-CRM data steward. The user runs Wildflower Schools' fundraising operation.",
    "Each turn, you receive one email-intelligence proposal — a signal extracted from a synced Gmail message — along with whatever CRM context is relevant.",
    "Your job: call the `propose_actions` tool exactly once. In that single call you must (a) return the concrete CRM mutations the reviewer should consider applying, (b) judge the ACCURACY of the detected signal, and (c) judge whether the proposal should be SUPPRESSED as not worth a human's attention. The specific ACCURACY and SUPPRESSION criteria for this signal type are given in the two sections appended at the end of this prompt — follow them when setting the `accuracy` and `suppress` fields.",
    "",
    "HOW TO ACT — rules for the `actions` array:",
    "• Only use IDs that appear verbatim in the CRM CONTEXT block. Never invent IDs.",
    "• When the person's EMPLOYER named in the message is NOT in context, surface it so a reviewer can add it. Default to `create_org_with_per` (it goes in the organizations table) with the org's name, your best-guess organizationType, and emailDomain when evident. ONLY use `create_funder_with_per` instead when the email gives strong evidence the employer is a philanthropic GRANTMAKER — an entity whose purpose is to give grants/money to grantees (private/community/family foundation, grantmaking trust, corporate giving program). The system reconciles either one deterministically: if a funder or organization of that name already exists it links the role to that existing entity instead of creating a duplicate. So you do NOT need to know what already exists — just surface the employer and pick the right table. CRITICAL: a name containing \"Fund\", \"Foundation\", \"Trust\", \"Endowment\", \"Philanthropies\", or \"Charitable\" does NOT make it a funder — operating nonprofits (e.g. Foundation for Economic Education), think tanks, charities that deliver programs, and internal sub-entities/fiscal-sponsorship funds are organizations, not grantmakers. An employer whose name contains \"Wildflower\" is the user's OWN organization or an internal Wildflower sub-entity/fiscal-sponsorship fund (e.g. \"Black Wildflowers Fund\") — always use create_org_with_per for it, never create_funder_with_per. When unsure, choose create_org_with_per. Pick organizationType from the best-fit enum when the kind of org is clear (single charter school → school; charter network / CMO → cmo or school_network; district → school_district; law firm → law_firm; operating nonprofit → nonprofit). NEVER emit a bare `create_per` that lacks an entity id — either resolve the id from context, use create_org_with_per / create_funder_with_per, or omit.",
    "• Be conservative. If the signal is ambiguous or contradicts current CRM state without strong evidence, return fewer actions or an empty list. The reviewer prefers missing a change over a wrong one.",
    "• Use the email message body (quoted at the bottom) as the source of truth for what the sender actually said. Don't generalize beyond it.",
    "• `reason` on each action should quote or paraphrase the specific phrase in the message that justifies the change. Keep it under 140 chars.",
    "• For LinkedIn job changes: typical pattern is one `deactivate_per` for the role they're leaving + one `create_per` for the new role at the new company when that company resolves to a funder/organization id in context — otherwise, for a new NON-FUNDER employer, use `create_org_with_per`. If the message names a replacement, add `create_person_with_per` for that successor.",
    "• For auto-responder 'I've moved' / departure / 'I'm no longer here' messages: deactivate the old role if a new company is named, create the new role if it resolves to a known entity, add the new email if one is given (with setPrimary=true if they say it's their new primary).",
    "• CRITICAL for departure/move auto-replies: these messages frequently name a SUCCESSOR / new point of contact at the SAME org (e.g. 'reach out to my colleague Jane Doe at jane@org.org'). When the message names such a replacement who is NOT already in the CRM, you MUST propose adding them with `create_person_with_per` — firstName + lastName, their emailAddress and externalTitleOrRole (title/role) when the message gives them — attached via organizationId to the org they belong to (the departing person's org). Resolve that organizationId from the CRM CONTEXT: the matched person's current/past role entity, the 'Matched organization', or the 'Organization candidates by name lookup' (the sender's domain is matched there). If the org is NOT in context at all, fall back to `create_org_with_per` (or `create_funder_with_per` for a clear grantmaker) naming the successor's employer the same way you would for any employer-not-in-context — never silently drop the successor. This add-successor action is IN ADDITION to any legitimate change to the departing person, not instead of it.",
    "• A SUCCESSOR must be a DIFFERENT, specifically NAMED individual (a real first AND last name). The departing / subject person themselves is NOT a successor — never create_person_with_per for the very person whose departure the auto-reply announces. A generic role mailbox or unnamed group is NOT a successor either — e.g. info@/grants@/contact@ addresses, 'a member of the team', 'your regular point of contact', 'the SeaChange team'.",
    "• For signature_update proposals: the payload.parsed object holds {name,title,company,phone,email}. Cross-check EACH parsed field against the CRM CONTEXT and emit an action ONLY for fields that are genuinely NEW or changed. Never restate the status quo. Specifically:",
    "    – email: if it already appears under 'Emails on file' (case-insensitive), emit nothing for it.",
    "    – phone: compare digits only (ignore spaces/dashes/parens/country code) against 'Phones on file'. If a matching number is already on file, emit nothing. If it is genuinely new, emit `set_phone` with the person's id. NEVER treat a conference / meeting dial-in number as a personal phone — Zoom / Google Meet / Teams / Webex access numbers (e.g. 'one tap mobile', 'dial by your location', 'join by phone', a country/city-labeled dial line such as 'US: +1 …' or '(US) +1 …', an 'Or dial: …' line, a 'Meeting ID' / 'Passcode' / 'PIN' / access code, or a number with a ',,123456789#' suffix) are meeting access numbers, not the contact's phone; emit nothing for them. This holds EVEN IF payload.parsed.phone is already populated with such a number: a populated phone is only a candidate — do not emit `set_phone` for it, and if the ONLY reason you can give for the phone would itself reference a Zoom/Meet/Teams/dial-in/conference/PIN context, that is proof it is a dial-in number, so emit nothing.",
    "    – title/role: if the person already has a CURRENT role at that company with that same title, emit nothing. If they have a CURRENT role at that company but its title is empty or different and the message shows a new title, emit `update_per_title` using that role's id — do NOT emit create_per for a role they already hold. Only use create_per when it is a genuinely different/new entity the person isn't already attached to AND that entity's id is in context; if the entity is a non-funder employer not yet in the CRM, use create_org_with_per instead.",
    "    – company: treat it as changed ONLY if it doesn't match the name of ANY current role entity in context.",
    "• Never emit `create_per` for a role the person already holds (same entity, current). If only the title differs, use `update_per_title`. Don't contradict yourself: if your reason says the person already has the role, emit no action for it.",
    "• For bounce messages: emit `mark_email_invalid` only for hard bounces. Soft bounces are review-only — return an empty actions array. Only mark an address invalid if it appears verbatim under the matched person's 'Emails on file' — never invalidate an address that isn't in the CRM context.",
    "• Never emit both `add_email` and `set_primary_email` for the same new address — use a single `add_email` with setPrimary=true instead.",
    "• For grant opportunities: emit one `create_grant_opportunity` per distinct RFP / grant program named, with organizationId only if the grant-making organization appears in context. Use cold_lead unless the message indicates an active invitation (then warm_lead). Don't invent ask amounts — only set askAmount if the message states one. NEVER create a grant opportunity whose application deadline is already in the past relative to TODAY'S DATE shown below — skip it entirely.",
    "",
    "ACCURACY + SUPPRESSION verdicts (set on EVERY call):",
    "• `accuracy.isAccurate` — true when the detected signal is genuinely what it claims to be, false otherwise; when false add a short `accuracy.reason` (under 140 chars). Be conservative: only mark inaccurate when the signal is clearly wrong. An inaccurate proposal is hidden from the reviewer regardless of any actions, so do not flag a borderline-but-plausible signal as inaccurate.",
    "• `suppress.shouldSuppress` — true ONLY when an ACCURATE signal is nonetheless noise the reviewer should never have to triage; add a short `suppress.reason` (under 140 chars). When in doubt, leave it false and let the reviewer decide. When you suppress, you should normally also return an empty actions array.",
    "• Follow the signal-type-specific ACCURACY REVIEW and SUPPRESSION REVIEW criteria appended below.",
    "",
    "Wildflower updates (independent of actions / accuracy / suppression):",
    "• When a WILDFLOWER UPDATES note appears in the context, it holds the team's current shared talking points / news. You MAY set the optional `wildflowerUpdate` object on the tool — but only rarely, when this specific email genuinely warrants it: `donorOutreach` to suggest reaching out to THIS matched donor about a relevant current update, and/or `noteRevision` to suggest editing the shared note when this email contains a concrete newsworthy Wildflower update worth adding. Omit `wildflowerUpdate` entirely when neither applies — that is the common case.",
    "",
    "Return an empty actions array when no automatic mutation is warranted — that is a valid and often correct answer.",
  ].join("\n");
}

// ──────────────────────────────────────────────────────────────────
// Per-(signal type, review phase) default review prompts
// ──────────────────────────────────────────────────────────────────

const DEFAULT_ACCURACY_PROMPTS: Record<EmailIntelSignalType, string> = {
  linkedin_job_change: [
    "Confirm the message genuinely reports a JOB CHANGE for the highlighted CRM person — a new employer and/or title — rather than a celebratory post, work anniversary, generic LinkedIn digest, or an update about a different person.",
    "Mark inaccurate when: the 'new company' is actually mis-parsed prose or references Wildflower (the user's own org); the update is about someone other than the matched person; or there is no concrete role change at all.",
  ].join("\n"),
  auto_responder_move: [
    "Confirm this is a genuine departure / 'I've moved' / 'I'm no longer here' message — the sender has actually left or changed roles.",
    "Mark inaccurate when it is a routine out-of-office / vacation auto-reply with no role change, or when the only 'successor' named is a generic role mailbox (info@/grants@) or an unnamed team rather than a real, specifically-named individual.",
  ].join("\n"),
  bounce: [
    "Confirm this is a real delivery-failure bounce for an address on file for the matched person, and that the hard- vs soft-bounce classification is correct (hard = permanent: unknown/invalid recipient; soft = transient: mailbox full, temporary failure).",
    "Mark inaccurate when the message is actually an auto-reply, a spam-filter / quarantine notice, or when the bounced address is not in the CRM context.",
  ].join("\n"),
  signature_update: [
    "Cross-check the parsed signature {name,title,company,phone,email} against the matched CRM person. The parsed NAME must clearly belong to the highlighted person.",
    "Mark inaccurate when the signature belongs to someone else (a forwarded message, a different signer), when the parsed 'company' is mis-parsed prose, or when the parsed value is a meeting dial-in rather than a personal phone. A parsed phone that is a Zoom / Google Meet / Teams / Webex dial-in access number — including country/city-labeled forms like 'US: +1 …' or '(US) +1 …', an 'Or dial:' line, or a number paired with a Meeting ID / Passcode / PIN — is NOT a personal phone: never emit `set_phone` for it, regardless of whether payload.parsed.phone was populated with it.",
  ].join("\n"),
  grant_opportunity: [
    "Confirm the message describes a real, currently-OPEN grant or funding opportunity Wildflower could apply for.",
    "Mark inaccurate when it is actually a grant WINNER / recipient announcement (an award already made), a promo / newsletter / event / sponsorship blast, or an RFP to hire a vendor/contractor/consultant (the sender is buying services, not offering funding).",
  ].join("\n"),
  thank_you_acknowledgment: [
    "Confirm this outbound staff email is a genuine thank-you acknowledgment for the candidate gift in context — it references that gift/donation, is addressed to that donor's contact, and reads as gratitude.",
    "Mark inaccurate when it is not really a thank-you for that gift (e.g. a generic newsletter, an unrelated message, or a thank-you for a different gift than the one in context).",
  ].join("\n"),
};

const DEFAULT_SUPPRESSION_PROMPTS: Record<EmailIntelSignalType, string> = {
  linkedin_job_change: [
    "Suppress when there is nothing new to record: the move is to or from Wildflower (the user's own org), the new role already matches the CRM person's current role, or the item is a generic LinkedIn digest with no concrete job change.",
  ].join("\n"),
  auto_responder_move: [
    "Suppress a plain out-of-office / vacation auto-reply where the person is still at their org AND names no new contact.",
    "NEVER suppress a genuine departure / move that names a successor, a new email, or a role change worth recording — keep it visible. Suppress only when there is genuinely nothing new for a human.",
  ].join("\n"),
  bounce: [
    "Hard and soft bounces are normally worth surfacing (hard bounces drive a mark-email-invalid action; soft bounces are review-only).",
    "Suppress only true noise — e.g. a transient bounce that is clearly already superseded, or a bounce for an address that has no bearing on the CRM.",
  ].join("\n"),
  signature_update: [
    "Suppress when every parsed field (email / phone / title / company) already matches the CRM state, so there is nothing new for the reviewer to do.",
  ].join("\n"),
  grant_opportunity: [
    "Suppress an opportunity whose application DEADLINE has already passed relative to today's date.",
    "Suppress an accurate-but-not-actionable item that nonetheless reached this step (e.g. an opportunity that is clearly irrelevant to Wildflower's mission or geography).",
  ].join("\n"),
  thank_you_acknowledgment: [
    "Suppress when there is no real gift to stamp, or the candidate gift has already been acknowledged.",
  ].join("\n"),
};

/**
 * The built-in default review prompt text for a (signal type, review phase)
 * key — used as the fallback when no admin-saved active version exists, and
 * as the starting point the AI "generate from feedback" flow improves on.
 */
export function buildDefaultReviewPrompt(
  signalType: EmailIntelSignalType,
  phase: EmailIntelReviewPhase,
): string {
  return phase === "accuracy"
    ? DEFAULT_ACCURACY_PROMPTS[signalType]
    : DEFAULT_SUPPRESSION_PROMPTS[signalType];
}

// ──────────────────────────────────────────────────────────────────
// Compose + resolve
// ──────────────────────────────────────────────────────────────────

/**
 * Stitch the hidden core together with the resolved accuracy + suppression
 * review prompts for a single signal type into the full system prompt sent
 * to the model.
 */
export function composeSystemPrompt(args: {
  signalType: EmailIntelSignalType;
  accuracyPrompt: string;
  suppressionPrompt: string;
}): string {
  const { signalType, accuracyPrompt, suppressionPrompt } = args;
  const label = signalTypeLabel(signalType);
  return [
    buildActionProposingCorePrompt(),
    "",
    `===== ACCURACY REVIEW (signal type: ${label}) =====`,
    "Decide whether the detected signal is actually correct. Set `accuracy.isAccurate`, and a short `accuracy.reason` when it is false.",
    accuracyPrompt,
    "",
    `===== SUPPRESSION REVIEW (signal type: ${label}) =====`,
    "Even when the signal is accurate, decide whether it is worth a human's attention. Set `suppress.shouldSuppress`, and a short `suppress.reason` when true.",
    suppressionPrompt,
  ].join("\n");
}

/**
 * Resolve the active review-prompt text for each phase of a signal type:
 * the admin-saved active version from `email_intel_prompts` if one exists,
 * otherwise the built-in default. Read per-run so an admin's save takes
 * effect on the next proposal without a redeploy.
 */
export async function resolveReviewPrompts(
  signalType: EmailIntelSignalType,
): Promise<Record<EmailIntelReviewPhase, string>> {
  const rows = await db
    .select({
      reviewPhase: emailIntelPrompts.reviewPhase,
      promptText: emailIntelPrompts.promptText,
    })
    .from(emailIntelPrompts)
    .where(
      and(
        eq(emailIntelPrompts.signalType, signalType),
        eq(emailIntelPrompts.status, "active"),
      ),
    );
  const byPhase = new Map<EmailIntelReviewPhase, string>();
  for (const r of rows) {
    if (r.reviewPhase) byPhase.set(r.reviewPhase, r.promptText);
  }
  return {
    accuracy:
      byPhase.get("accuracy") ?? buildDefaultReviewPrompt(signalType, "accuracy"),
    suppression:
      byPhase.get("suppression") ??
      buildDefaultReviewPrompt(signalType, "suppression"),
  };
}

// ──────────────────────────────────────────────────────────────────
// Hide decision (pure)
// ──────────────────────────────────────────────────────────────────

export type HideDecision =
  | { hide: false }
  | { hide: true; status: "ignored"; reviewerNote: string };

/**
 * Decide whether a freshly-analyzed proposal should be auto-hidden from the
 * reviewer, and why. Pure + deterministic so it can be unit-tested.
 *
 * Precedence:
 *   1. `disableAutoSuppress` (the reviewer-driven /revise path) — never hide;
 *      the reviewer explicitly asked to re-run it and expects it to stay.
 *   2. INACCURATE signal (`accuracy.isAccurate === false`) — hide as
 *      "Flagged inaccurate: …", regardless of any proposed actions (an
 *      inaccurate signal means any actions rest on a false premise).
 *   3. SUPPRESS (`suppress.shouldSuppress === true`) AND no actions — hide as
 *      "Auto-suppressed: …". Guarded on zero actions so a proposal that also
 *      carries concrete mutations always stays visible.
 *   4. Otherwise — keep visible.
 */
export function deriveHideDecision(args: {
  disableAutoSuppress?: boolean;
  actionsCount: number;
  accuracy: { isAccurate?: boolean; reason?: string } | null | undefined;
  suppress: { shouldSuppress?: boolean; reason?: string } | null | undefined;
}): HideDecision {
  const { disableAutoSuppress, actionsCount, accuracy, suppress } = args;
  if (disableAutoSuppress) return { hide: false };

  if (accuracy?.isAccurate === false) {
    return {
      hide: true,
      status: "ignored",
      reviewerNote: `Flagged inaccurate: ${
        accuracy.reason?.trim() || "detected signal is not accurate"
      }`.slice(0, 500),
    };
  }

  if (suppress?.shouldSuppress === true && actionsCount === 0) {
    return {
      hide: true,
      status: "ignored",
      reviewerNote: `Auto-suppressed: ${
        suppress.reason?.trim() || "non-actionable noise"
      }`.slice(0, 500),
    };
  }

  return { hide: false };
}
