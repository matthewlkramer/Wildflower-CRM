export * from "./generated/api";
export * from "./revenue-coding";

import { z } from "zod";
import {
  CreateOpportunityOrPledgeBody,
  CreateGiftOrPaymentBody,
  CreateMeetingNoteBody,
  CreateMediaMentionBody,
} from "./generated/api";

/**
 * Shared invariant validators for opportunities/pledges and gifts/payments.
 *
 * These mirror DB CHECK constraints so the API can return 400 instead of 500:
 *   - donor_xor: exactly one of funderId / individualGiverPersonId / householdId
 *
 * (Previously also enforced `closed_requires_completion_date` — that DB CHECK
 * and the matching invariant were dropped to support data-cleanup workflows
 * where historical opps are bulk-marked won/lost without a known close date.)
 *
 * For PATCH routes, callers must validate the MERGED post-update state
 * (`{ ...existingRow, ...body }`), not the body alone — a partial PATCH can
 * pass body-only validation and still violate the merged invariant.
 */

export const DONOR_XOR_MESSAGE =
  "Exactly one of organizationId, individualGiverPersonId, or householdId must be set (donor XOR).";

export interface DonorState {
  organizationId?: string | null;
  individualGiverPersonId?: string | null;
  householdId?: string | null;
}

export interface OppCloseState {
  status?: string | null;
  actualCompletionDate?: string | Date | null;
}

export interface InvariantIssue {
  path: string;
  message: string;
}

// Match Postgres `num_nonnulls(...)` semantics used by the donor_xor CHECK
// constraints: count any value that is neither null nor undefined, including
// empty strings. Truthiness would let `{ organizationId: "" }` slip through the API
// check and trip the DB constraint as a 500.
function donorCount(s: DonorState): number {
  return (
    (s.organizationId != null ? 1 : 0) +
    (s.individualGiverPersonId != null ? 1 : 0) +
    (s.householdId != null ? 1 : 0)
  );
}

export function validateOppInvariants(
  state: DonorState & OppCloseState,
): InvariantIssue[] {
  const issues: InvariantIssue[] = [];
  if (donorCount(state) !== 1) {
    issues.push({ path: "organizationId", message: DONOR_XOR_MESSAGE });
  }
  return issues;
}

export function validateGiftInvariants(state: DonorState): InvariantIssue[] {
  const issues: InvariantIssue[] = [];
  if (donorCount(state) !== 1) {
    issues.push({ path: "organizationId", message: DONOR_XOR_MESSAGE });
  }
  return issues;
}

function issuesToZodCtx(issues: InvariantIssue[], ctx: z.RefinementCtx): void {
  for (const i of issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: i.message,
      path: [i.path],
    });
  }
}

/**
 * CREATE refines: body IS the full state, so the body-level refine is sound.
 *
 * UPDATE bodies are intentionally NOT refined here — PATCH validation must
 * happen at the route handler against merged state. Use the un-refined
 * Update*Body schemas (re-exported from "./generated/api") for body parsing,
 * then call `validateOppInvariants` / `validateGiftInvariants` on the merged
 * row.
 */
export const CreateOpportunityOrPledgeBodyRefined =
  CreateOpportunityOrPledgeBody.superRefine(
    (b: z.infer<typeof CreateOpportunityOrPledgeBody>, ctx) => {
      issuesToZodCtx(validateOppInvariants(b), ctx);
    },
  );

export const CreateGiftOrPaymentBodyRefined =
  CreateGiftOrPaymentBody.superRefine(
    (b: z.infer<typeof CreateGiftOrPaymentBody>, ctx) => {
      issuesToZodCtx(validateGiftInvariants(b), ctx);
    },
  );

/**
 * Meeting-notes contact-xor: exactly one of personId / funderId / householdId
 * must be set. Mirrors the `meeting_notes_contact_xor` DB CHECK so the API
 * returns 400 instead of 500. PATCH routes must validate against MERGED
 * post-update state (un-refined `UpdateMeetingNoteBody` from generated/api).
 */
export const MEETING_CONTACT_XOR_MESSAGE =
  "Exactly one of personId, organizationId, or householdId must be set (contact XOR).";

export interface MeetingContactState {
  personId?: string | null;
  organizationId?: string | null;
  householdId?: string | null;
}

function meetingContactCount(s: MeetingContactState): number {
  return (
    (s.personId != null ? 1 : 0) +
    (s.organizationId != null ? 1 : 0) +
    (s.householdId != null ? 1 : 0)
  );
}

export function validateMeetingContactInvariants(
  state: MeetingContactState,
): InvariantIssue[] {
  const issues: InvariantIssue[] = [];
  if (meetingContactCount(state) !== 1) {
    issues.push({ path: "personId", message: MEETING_CONTACT_XOR_MESSAGE });
  }
  return issues;
}

export const CreateMeetingNoteBodyRefined =
  CreateMeetingNoteBody.superRefine(
    (b: z.infer<typeof CreateMeetingNoteBody>, ctx) => {
      issuesToZodCtx(validateMeetingContactInvariants(b), ctx);
      // Exactly one of transcript / summary. Both routes are mutually
      // exclusive: transcript runs through AI; summary is stored verbatim.
      const hasT = typeof b.transcript === "string" && b.transcript.trim().length > 0;
      const hasS = typeof b.summary === "string" && b.summary.trim().length > 0;
      if (!hasT && !hasS) {
        ctx.addIssue({
          code: "custom",
          path: ["transcript"],
          message: "Either transcript or summary is required.",
        });
      } else if (hasT && hasS) {
        ctx.addIssue({
          code: "custom",
          path: ["summary"],
          message: "Provide either transcript or summary, not both.",
        });
      }
    },
  );

/**
 * Media-mention field invariants that OpenAPI/zod schemas can't express:
 *   - aiSummary must be <= 100 words (product requirement for AI summaries)
 *   - url must be an absolute http(s) URL — blocks javascript:/data: links that
 *     would otherwise be rendered into an <a href> as a stored-XSS vector.
 * Mirrors the route-level validation pattern used for opps/gifts/meeting notes.
 * PATCH routes must validate the MERGED post-update state.
 */
export const MEDIA_AI_SUMMARY_MAX_WORDS = 100;
export const MEDIA_AI_SUMMARY_MESSAGE = `AI summary must be ${MEDIA_AI_SUMMARY_MAX_WORDS} words or fewer.`;
export const MEDIA_URL_MESSAGE = "URL must be an absolute http(s) URL.";

export interface MediaMentionFieldState {
  aiSummary?: string | null;
  url?: string | null;
}

function wordCount(s: string): number {
  const trimmed = s.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

// Cross-environment (no DOM/node URL global): require an absolute http(s)
// scheme. Rejects javascript:/data:/mailto: etc. so a stored value is always
// safe to drop into an <a href>. Trim first so a leading-whitespace value
// (which browsers strip before resolving the scheme) can't sneak past.
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

export function validateMediaMentionInvariants(
  state: MediaMentionFieldState,
): InvariantIssue[] {
  const issues: InvariantIssue[] = [];
  if (
    state.aiSummary != null &&
    wordCount(state.aiSummary) > MEDIA_AI_SUMMARY_MAX_WORDS
  ) {
    issues.push({ path: "aiSummary", message: MEDIA_AI_SUMMARY_MESSAGE });
  }
  if (
    state.url != null &&
    state.url.length > 0 &&
    !isHttpUrl(state.url)
  ) {
    issues.push({ path: "url", message: MEDIA_URL_MESSAGE });
  }
  return issues;
}

export const CreateMediaMentionBodyRefined =
  CreateMediaMentionBody.superRefine(
    (b: z.infer<typeof CreateMediaMentionBody>, ctx) => {
      issuesToZodCtx(validateMediaMentionInvariants(b), ctx);
    },
  );
