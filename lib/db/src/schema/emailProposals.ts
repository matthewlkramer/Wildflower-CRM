import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { emailMessages } from "./emailMessages";
import { people } from "./people";
import { funders } from "./funders";
import { emails } from "./emails";
import {
  emailProposalKindEnum,
  emailProposalStatusEnum,
} from "./_enums";

/**
 * Actionable items produced by the email intelligence pipeline. One
 * row per (mailboxUserId, dedupe_key); the dedupe key is per-kind and
 * encodes whatever makes a proposal "the same one we've already
 * surfaced" (e.g. for a LinkedIn job change: person name + new
 * company). Re-emitting an identical proposal is a no-op via the
 * unique index.
 *
 * Once a user accepts or rejects a proposal, status flips out of
 * `pending` and the row is preserved as an audit trail — we never
 * delete proposals, just re-classify them.
 *
 * `target_*_id` columns are nullable hints from the detector for
 * which CRM entity the proposal is about. They may be wrong (fuzzy
 * match) and the accept handler is responsible for confirming /
 * letting the user override.
 *
 * `payload` is detector-specific JSON. Documented per-kind below.
 *   - linkedin_job_change: { personName, newTitle?, newCompany,
 *       sourceLine, matchConfidence? }
 *   - auto_responder_move: { leftCompany?, newCompany?, newEmail?,
 *       quotedSnippet }
 *   - bounce_invalid / bounce_soft: { recipient, smtpCode?,
 *       enhancedCode?, reason? }
 *   - signature_update: { name?, title?, company?, phone?,
 *       email?, current: {title?, primaryOrg?} }
 *   - grant_opportunity: { title, funderName?, deadline?, amount?,
 *       url?, snippet, sourceDigest? }
 */
export const emailProposals = pgTable(
  "email_proposals",
  {
    id: text("id").primaryKey(),
    mailboxUserId: text("mailbox_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: emailProposalKindEnum("kind").notNull(),
    status: emailProposalStatusEnum("status").default("pending").notNull(),
    sourceMessageId: text("source_message_id").references(
      () => emailMessages.id,
      { onDelete: "set null" },
    ),
    targetPersonId: text("target_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    targetFunderId: text("target_funder_id").references(() => funders.id, {
      onDelete: "set null",
    }),
    targetEmailId: text("target_email_id").references(() => emails.id, {
      onDelete: "set null",
    }),
    // The "subject" of the proposal in human terms — what email address
    // / name / domain the proposal is about. Used to render review-queue
    // cards without joining out to other tables.
    subjectEmail: text("subject_email"),
    subjectName: text("subject_name"),
    subjectDomain: text("subject_domain"),
    payload: jsonb("payload").notNull().default({}),
    // AI-proposed structured actions to execute when the user accepts
    // this proposal. Populated asynchronously by `proposeActionsForProposal`
    // after the detector emits the row — see `proposeActions.ts` for the
    // action-object schema and `applyProposalActions.ts` for dispatch.
    // Empty array = AI ran but produced no actionable change suggestions
    // (signal worth surfacing but nothing to auto-mutate). NULL via
    // default `[]` won't happen at the row level — instead we use
    // `actionsAnalyzedAt IS NULL` as the "AI hasn't run yet" signal.
    proposedActions: jsonb("proposed_actions").notNull().default([]),
    actionsAnalyzedAt: timestamp("actions_analyzed_at"),
    actionsModel: text("actions_model"),
    actionsError: text("actions_error"),
    // Dedupe key — per-kind shape (see file header). Combined with
    // mailbox_user_id for the unique index so two users with the same
    // signal each get their own row.
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Optional free-text reviewer feedback captured when the user
    // accepts or (more usefully) rejects a proposal. Lives on the same
    // row as the verdict so prompt-tuning can join {payload, verdict,
    // note} without extra tables. Nullable; UI defaults to empty.
    reviewerNote: text("reviewer_note"),
  },
  (t) => [
    // Dedupe only suppresses while a proposal is still pending. Once a
    // user accepts/rejects, the row is preserved as audit trail but
    // stops claiming the dedupe slot — so a future identical signal
    // (e.g. another hard-bounce months later, a fresh signature drift
    // after the role moved again) can surface as a new pending proposal
    // instead of being silently swallowed.
    uniqueIndex("email_proposals_dedupe_pending_uq")
      .on(t.mailboxUserId, t.dedupeKey)
      .where(sql`status = 'pending'`),
    index("email_proposals_mailbox_status_idx").on(
      t.mailboxUserId,
      t.status,
      t.kind,
    ),
    index("email_proposals_target_person_idx").on(t.targetPersonId),
    index("email_proposals_target_funder_idx").on(t.targetFunderId),
  ],
);

export type EmailProposal = typeof emailProposals.$inferSelect;
export type NewEmailProposal = typeof emailProposals.$inferInsert;
