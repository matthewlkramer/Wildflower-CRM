import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { cleanupQueueStatusEnum } from "./_enums";

export type CleanupProposalKind = "gift_donor" | "default_intermediary";
export type CleanupProposalConfidence = "high" | "medium" | "low";
export type CleanupProposalDonorKind =
  | "individual"
  | "household"
  | "organization";

export interface CleanupProposalDonorRef {
  kind: CleanupProposalDonorKind;
  id: string;
  name?: string | null;
}

export interface CleanupProposal {
  fromDonor?: CleanupProposalDonorRef | null;
  toDonor?: CleanupProposalDonorRef | null;
  donor?: CleanupProposalDonorRef | null;
  paymentIntermediary?: {
    id: string;
    name?: string | null;
    type?: string | null;
  } | null;
  rationale?: string | null;
}

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
    // Human-readable shared working text. Team members may edit this note to
    // exchange updates about the cleanup item.
    note: text("note").notNull(),
    // Optional structured proposal. Ordinary cleanup items leave these null.
    proposalKind: text("proposal_kind").$type<CleanupProposalKind>(),
    proposalConfidence: text(
      "proposal_confidence",
    ).$type<CleanupProposalConfidence>(),
    proposedChanges: jsonb("proposed_changes").$type<CleanupProposal | null>(),
    // User who first created the flag. Historical migration-seeded rows remain
    // null and are presented as System.
    flaggedByUserId: text("flagged_by_user_id"),
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
    index("cleanup_queue_proposal_status_idx").on(
      t.status,
      t.proposalConfidence,
      t.proposalKind,
    ),
  ],
);

export type CleanupQueueRow = typeof cleanupQueue.$inferSelect;
export type NewCleanupQueueRow = typeof cleanupQueue.$inferInsert;
