import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Financial-correction proposals an admin has explicitly dismissed in the
 * corrections review queue, so the detector never re-surfaces them. Mirrors
 * `duplicate_dismissals` for the entity duplicate queue.
 *
 * `kind` is the proposal kind ('merge_gifts' | 'link_evidence'). `proposalKey`
 * is the detector's CANONICAL, order-independent key for the proposal (e.g. the
 * sorted gift ids for a merge, or the evidence id + sorted gift ids for a
 * link), so a dismissal is idempotent regardless of how the detector orders the
 * members on a later run. No foreign keys: this is historical review state, and
 * a key pointing at since-merged/archived rows is harmless because that proposal
 * can no longer be produced.
 */
export const financialCorrectionDismissals = pgTable(
  "financial_correction_dismissals",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    proposalKey: text("proposal_key").notNull(),
    dismissedByUserId: text("dismissed_by_user_id"),
    dismissedAt: timestamp("dismissed_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("financial_correction_dismissals_key_unique").on(
      t.kind,
      t.proposalKey,
    ),
  ],
);

export type FinancialCorrectionDismissalRow =
  typeof financialCorrectionDismissals.$inferSelect;
export type NewFinancialCorrectionDismissalRow =
  typeof financialCorrectionDismissals.$inferInsert;
