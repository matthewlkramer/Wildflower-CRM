import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { stagedPayments } from "./stagedPayments";
import { users } from "./users";

/**
 * Reviewer "propose alternative" comments on a reconciliation card.
 *
 * Append-only free-text notes left beside Approve in the Needs-review queue: a
 * fundraiser flags how a specific staged-payment row — or the matcher as a whole
 * — should change instead of approving it. Each row captures one comment with its
 * author and timestamp; a card accumulates many. These are read later (per-card
 * and cross-card) to act on the feedback. They never mutate match/donor/gift
 * state.
 *
 * Keyed to the card's staged_payments row (the representative row for a source
 * group). staged FK is CASCADE — a comment is meaningless without its row, and a
 * hard-deleted staged row is no longer actionable. author FK is SET NULL so a
 * removed user doesn't erase the note.
 */
export const reconciliationProposals = pgTable(
  "reconciliation_proposals",
  {
    id: text("id").primaryKey(),
    stagedPaymentId: text("staged_payment_id")
      .notNull()
      .references(() => stagedPayments.id, { onDelete: "cascade" }),
    comment: text("comment").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    // Newest-first listing of one card's comments.
    index("reconciliation_proposals_staged_payment_id_created_at_idx").on(
      t.stagedPaymentId,
      t.createdAt.desc(),
    ),
    // Newest-first cross-card feed.
    index("reconciliation_proposals_created_at_idx").on(t.createdAt.desc()),
  ],
);

export type ReconciliationProposal = typeof reconciliationProposals.$inferSelect;
export type NewReconciliationProposal =
  typeof reconciliationProposals.$inferInsert;
