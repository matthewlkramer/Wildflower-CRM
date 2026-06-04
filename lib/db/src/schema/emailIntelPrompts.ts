import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./users";
import {
  emailIntelPromptOriginEnum,
  emailIntelPromptStatusEnum,
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
    // At most one active version and one outstanding draft. Both indexes
    // are partial on a constant-valued column: every matching row shares
    // the same `status` value, so a plain unique on `status` collapses to
    // "only one row may have this status".
    uniqueIndex("email_intel_prompts_active_uq")
      .on(t.status)
      .where(sql`status = 'active'`),
    uniqueIndex("email_intel_prompts_draft_uq")
      .on(t.status)
      .where(sql`status = 'draft'`),
    index("email_intel_prompts_created_idx").on(t.createdAt),
  ],
);

export type EmailIntelPrompt = typeof emailIntelPrompts.$inferSelect;
export type NewEmailIntelPrompt = typeof emailIntelPrompts.$inferInsert;
