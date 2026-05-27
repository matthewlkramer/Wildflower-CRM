export * from "./generated/api";

import { z } from "zod";
import {
  CreateOpportunityOrPledgeBody,
  CreateGiftOrPaymentBody,
  CreateMeetingNoteBody,
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
  "Exactly one of funderId, individualGiverPersonId, or householdId must be set (donor XOR).";

export interface DonorState {
  funderId?: string | null;
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
// empty strings. Truthiness would let `{ funderId: "" }` slip through the API
// check and trip the DB constraint as a 500.
function donorCount(s: DonorState): number {
  return (
    (s.funderId != null ? 1 : 0) +
    (s.individualGiverPersonId != null ? 1 : 0) +
    (s.householdId != null ? 1 : 0)
  );
}

export function validateOppInvariants(
  state: DonorState & OppCloseState,
): InvariantIssue[] {
  const issues: InvariantIssue[] = [];
  if (donorCount(state) !== 1) {
    issues.push({ path: "funderId", message: DONOR_XOR_MESSAGE });
  }
  return issues;
}

export function validateGiftInvariants(state: DonorState): InvariantIssue[] {
  const issues: InvariantIssue[] = [];
  if (donorCount(state) !== 1) {
    issues.push({ path: "funderId", message: DONOR_XOR_MESSAGE });
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
  "Exactly one of personId, funderId, or householdId must be set (contact XOR).";

export interface MeetingContactState {
  personId?: string | null;
  funderId?: string | null;
  householdId?: string | null;
}

function meetingContactCount(s: MeetingContactState): number {
  return (
    (s.personId != null ? 1 : 0) +
    (s.funderId != null ? 1 : 0) +
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
    },
  );
