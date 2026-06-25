import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./users";
import {
  emailIntelPromptOriginEnum,
  emailIntelPromptStatusEnum,
  emailIntelReviewPhaseEnum,
  emailIntelSignalTypeEnum,
} from "./_enums";

/**
 * Versioned AI system-prompt for the email-intelligence proposal
 * pipeline. The plain-text instructions Claude follows when drafting
 * proposed CRM actions used to be hard-coded in `proposeActions.ts`;
 * they now live here so an admin can hand-edit, AI-draft, and revert
 * them without a code change + redeploy.
 *
 * Exactly one row is `active` at a time (enforced by a partial unique
 * index). The pipeline reads the active row at run time and falls back
 * to the built-in default when no row exists. `draft` rows are
 * AI-generated candidates awaiting admin approval (at most one). All
 * previously-active versions are kept as `archived` history so an admin
 * can revert — revert copies an old version into a new active row
 * rather than destroying history.
 */
export const emailIntelPrompts = pgTable(
  "email_intel_prompts",
  {
    id: text("id").primaryKey(),
    promptText: text("prompt_text").notNull(),
    status: emailIntelPromptStatusEnum("status").notNull().default("archived"),
    origin: emailIntelPromptOriginEnum("origin").notNull(),
    // Which review prompt this version belongs to. Nullable ONLY for legacy
    // pre-split combined-prompt rows retained as archived history — every new
    // row written by the admin console carries both. The active/draft partial
    // uniques are keyed on (signal_type, review_phase), so legacy null-keyed
    // rows must be archived (they can never occupy a per-key active/draft slot).
    signalType: emailIntelSignalTypeEnum("signal_type"),
    reviewPhase: emailIntelReviewPhaseEnum("review_phase"),
    // Who authored this version. For AI-generated drafts this is the
    // admin who clicked "Generate AI update". Nullable so deleting a
    // user doesn't destroy prompt history.
    authorUserId: text("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // At most one active version and one outstanding draft PER review key
    // (signal_type, review_phase). Legacy null-keyed rows are all archived,
    // so they never satisfy these partial predicates — only properly-keyed
    // rows compete for a slot. (A composite unique treats NULLs as distinct
    // anyway, so even a stray null-keyed active row wouldn't collide.)
    uniqueIndex("email_intel_prompts_active_key_uq")
      .on(t.signalType, t.reviewPhase)
      .where(sql`status = 'active'`),
    uniqueIndex("email_intel_prompts_draft_key_uq")
      .on(t.signalType, t.reviewPhase)
      .where(sql`status = 'draft'`),
    index("email_intel_prompts_created_idx").on(t.createdAt),
  ],
);

export type EmailIntelPrompt = typeof emailIntelPrompts.$inferSelect;
export type NewEmailIntelPrompt = typeof emailIntelPrompts.$inferInsert;
