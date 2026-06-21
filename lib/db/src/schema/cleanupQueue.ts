import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { cleanupQueueStatusEnum } from "./_enums";

/**
 * Records flagged as needing manual data cleanup that can't be auto-fixed.
 *
 * Each row points at a target record (`targetType` + `targetId`) and carries a
 * human-readable `note` describing what to fix, plus a machine `reasonCode`
 * that categorizes the flag and keeps seeding idempotent. A fundraiser works
 * through the queue and either resolves (record fixed) or dismisses (false
 * flag) each item; both states drop the item out of the default queue view.
 *
 * `targetType` is polymorphic (e.g. 'pledge', 'opportunity', 'organization',
 * 'person', 'gift') and intentionally has NO foreign key on `targetId` — this
 * is historical review state, not a live relationship, and a row pointing at a
 * since-merged/deleted record is harmless. Keeping `targetId` as plain text
 * also keeps it out of the `mergeEntities` FK-inventory test (which only tracks
 * live FK references to organizations/people).
 *
 * The unique index on (target_type, target_id, reason_code) makes seeding
 * idempotent: re-running a seed for the same record + reason is a no-op.
 */
export const cleanupQueue = pgTable(
  "cleanup_queue",
  {
    id: text("id").primaryKey(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    // Machine-readable category of the flag (e.g. 'conditional_commitment_stage').
    // Part of the idempotency key so the same record can later be flagged for a
    // different reason without colliding.
    reasonCode: text("reason_code").notNull(),
    // Human-readable description of what to fix.
    note: text("note").notNull(),
    status: cleanupQueueStatusEnum("status").notNull().default("open"),
    flaggedAt: timestamp("flagged_at").defaultNow().notNull(),
    // Set when the item leaves the 'open' state (resolved or dismissed).
    resolvedAt: timestamp("resolved_at"),
    // Plain text (no FK) — mirrors the review-queue convention; provenance only.
    resolvedByUserId: text("resolved_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("cleanup_queue_target_reason_unique").on(
      t.targetType,
      t.targetId,
      t.reasonCode,
    ),
    index("cleanup_queue_status_idx").on(t.status),
  ],
);

export type CleanupQueueRow = typeof cleanupQueue.$inferSelect;
export type NewCleanupQueueRow = typeof cleanupQueue.$inferInsert;
