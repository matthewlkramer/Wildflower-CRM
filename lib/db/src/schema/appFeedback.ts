import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

export type AppFeedbackContext = Record<string, unknown>;

export type AppFeedbackProposalCodeArea = {
  area: string;
  rationale: string;
};

export type AppFeedbackProposalContent = {
  title: string;
  summary: string;
  userExperience: string[];
  implementationSteps: string[];
  likelyCodeAreas: AppFeedbackProposalCodeArea[];
  acceptanceCriteria: string[];
  testPlan: string[];
  risksAndOpenQuestions: string[];
  implementationBrief: string;
};

export type AppFeedbackProposalSnapshot = {
  feedbackId: string;
  category: string;
  message: string;
  pageUrl: string;
  pagePath: string;
  pageTitle: string | null;
  capturedContext: Record<string, unknown>;
  architectureContextVersion: string;
  likelyAreas: string[];
};

/**
 * User-submitted product feedback with enough page context to reproduce the
 * issue. Screenshots live in the existing private object store; this table
 * keeps only the authenticated object URL.
 */
export const appFeedback = pgTable(
  "app_feedback",
  {
    id: text("id").primaryKey(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    category: text("category").notNull().default("bug"),
    message: text("message").notNull(),
    status: text("status").notNull().default("open"),
    pageUrl: text("page_url").notNull(),
    pagePath: text("page_path").notNull(),
    pageTitle: text("page_title"),
    context: jsonb("context")
      .$type<AppFeedbackContext>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    screenshotUrl: text("screenshot_url"),
    screenshotFilename: text("screenshot_filename"),
    screenshotStatus: text("screenshot_status").notNull().default("skipped"),
    screenshotError: text("screenshot_error"),
    adminNotes: text("admin_notes"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    check(
      "app_feedback_category_ck",
      sql`${t.category} IN ('bug', 'question', 'suggestion', 'other')`,
    ),
    check(
      "app_feedback_status_ck",
      sql`${t.status} IN ('open', 'in_progress', 'resolved', 'dismissed')`,
    ),
    check(
      "app_feedback_screenshot_status_ck",
      sql`${t.screenshotStatus} IN ('captured', 'failed', 'skipped')`,
    ),
    index("app_feedback_status_created_idx").on(t.status, t.createdAt),
    index("app_feedback_creator_created_idx").on(
      t.createdByUserId,
      t.createdAt,
    ),
    index("app_feedback_created_idx").on(t.createdAt),
  ],
);

export type AppFeedback = typeof appFeedback.$inferSelect;
export type NewAppFeedback = typeof appFeedback.$inferInsert;

/**
 * AI-authored implementation proposal for one feedback item.
 *
 * There is one durable row per feedback item. Revising regenerates the
 * proposal in place, increments revision, and appends the human guidance so
 * the current proposal and its review trail stay together. `contextSnapshot`
 * records exactly what the model was allowed to reason over; it deliberately
 * excludes browser fingerprint fields and the screenshot binary.
 */
export const appFeedbackProposals = pgTable(
  "app_feedback_proposals",
  {
    id: text("id").primaryKey(),
    feedbackId: text("feedback_id")
      .notNull()
      .references(() => appFeedback.id, { onDelete: "cascade" }),
    generationStatus: text("generation_status").notNull().default("queued"),
    revision: integer("revision").notNull().default(1),
    contextSnapshot: jsonb("context_snapshot")
      .$type<AppFeedbackProposalSnapshot>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    proposal: jsonb("proposal").$type<AppFeedbackProposalContent>(),
    reviewerGuidance: text("reviewer_guidance"),
    analyzedAt: timestamp("analyzed_at"),
    model: text("model"),
    error: text("error"),
    implementationRequestedAt: timestamp("implementation_requested_at"),
    implementationRequestedByUserId: text(
      "implementation_requested_by_user_id",
    ).references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("app_feedback_proposals_feedback_uq").on(t.feedbackId),
    check(
      "app_feedback_proposals_generation_status_ck",
      sql`${t.generationStatus} IN ('queued', 'generating', 'ready', 'error')`,
    ),
    check(
      "app_feedback_proposals_revision_ck",
      sql`${t.revision} >= 1`,
    ),
    index("app_feedback_proposals_generation_idx").on(
      t.generationStatus,
      t.updatedAt,
    ),
    index("app_feedback_proposals_implementation_idx").on(
      t.implementationRequestedAt,
    ),
  ],
);

export type AppFeedbackProposal = typeof appFeedbackProposals.$inferSelect;
export type NewAppFeedbackProposal = typeof appFeedbackProposals.$inferInsert;
