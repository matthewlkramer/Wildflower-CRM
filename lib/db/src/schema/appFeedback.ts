import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

export type AppFeedbackContext = Record<string, unknown>;

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
