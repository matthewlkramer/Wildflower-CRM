export * from "./generated";
export * from "./revenue-coding";
export * from "./loan-or-grant";

import { z } from "zod";
import {
  CreateOpportunityOrPledgeBody,
  CreateGiftOrPaymentBody,
  CreateMeetingNoteBody,
  CreateMediaMentionBody,
} from "./generated";

/**
 * Shared invariant validators for opportunities/pledges and gifts/payments.
 *
 * These mirror DB CHECK constraints so the API can return 400 instead of 500:
 *   - donor_xor: exactly one of funderId / individualGiverPersonId / householdId
 *
 * (The old `closed_requires_completion_date` DB CHECK was dropped to support
 * data-cleanup workflows where historical opps are bulk-marked won/lost without
 * a known close date — 244 legacy closed rows have no date and must stay
 * editable. The rule lives on as an API-level TRANSITION check instead:
 * `validateOppCloseTransition` below fires only when a request NEWLY closes a
 * row, never on edits to already-closed rows.)
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

// ── Close-transition rule (API-level replacement for the dropped
// `closed_requires_completion_date` DB CHECK) ────────────────────────────────
// Closing an opportunity = setting `lossType` (dormant/lost) or moving `stage`
// to 'complete'. A request that NEWLY closes a row must leave it with an
// actualCompletionDate (pre-existing on the row or supplied in the same
// request). Already-closed rows (incl. the 244 legacy no-date rows) are never
// blocked: renames, re-closes (dormant↔lost), and reopens all pass.

export const CLOSE_REQUIRES_COMPLETION_DATE_MESSAGE =
  "Closing an opportunity requires an actual completion date — provide actualCompletionDate in the same request (or set it on the record first).";

export interface OppCloseTransitionState {
  lossType?: string | null;
  stage?: string | null;
  actualCompletionDate?: string | Date | null;
}

function isClosed(s: OppCloseTransitionState): boolean {
  return (
    s.lossType === "dormant" ||
    s.lossType === "lost" ||
    s.stage === "complete"
  );
}

function hasDate(d: string | Date | null | undefined): boolean {
  if (d == null) return false;
  return !(typeof d === "string" && d.trim() === "");
}

/**
 * Validate a close TRANSITION. `existing` is the current row state (pass `{}`
 * for CREATE — nothing exists yet, so any closing value in the body is a new
 * close). `patch` is the request body; a field left out of the patch
 * (undefined) means "unchanged".
 */
export function validateOppCloseTransition(
  existing: OppCloseTransitionState,
  patch: OppCloseTransitionState,
): InvariantIssue[] {
  // The request must itself set a closing value — merged-state closes caused
  // purely by pre-existing fields are not a transition.
  const requestCloses =
    patch.lossType === "dormant" ||
    patch.lossType === "lost" ||
    patch.stage === "complete";
  if (!requestCloses) return [];
  // Already-closed rows are grandfathered: edits (incl. switching
  // dormant↔lost on a legacy no-date row) never force a date.
  if (isClosed(existing)) return [];
  const mergedDate =
    patch.actualCompletionDate !== undefined
      ? patch.actualCompletionDate
      : existing.actualCompletionDate;
  if (!hasDate(mergedDate)) {
    return [
      {
        path: "actualCompletionDate",
        message: CLOSE_REQUIRES_COMPLETION_DATE_MESSAGE,
      },
    ];
  }
  return [];
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
      // A row created already-closed must carry its completion date up front.
      issuesToZodCtx(validateOppCloseTransition({}, b), ctx);
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
