import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { giftFinalAmountSourceEnum } from "./_enums";
import { giftsAndPayments } from "./giftsAndPayments";
import { users } from "./users";

// Worklist of gifts whose `amount` was overwritten by reconciliation
// (stampGiftFinalAmount) but whose gift_allocations could NOT be auto-rebalanced
// to the new amount. A single-allocation gift is always auto-rescaled and never
// lands here; this only captures the ambiguous cases:
//   - no_allocation             — the gift had zero allocations, so there is
//                                 nothing to rescale (a human must allocate it).
//   - multi_allocation_mismatch — the gift has 2+ allocations whose split is
//                                 ambiguous and no longer sums to the new amount;
//                                 a human must re-apportion the sub_amounts.
// The money on the GIFT is already correct (amount is the single source of
// truth); only the allocation split needs a human. At most one OPEN row per gift
// (partial-unique index on gift_id WHERE resolved_at IS NULL); re-running
// reconciliation refreshes that open row instead of piling up duplicates.
export const giftAmountAllocationReview = pgTable(
  "gift_amount_allocation_review",
  {
    id: text("id").primaryKey(),
    // CASCADE: a transient worklist entry, not a money-trail record. If the
    // backing gift is ever hard-deleted (gift merge / QuickBooks revert), the
    // review entry goes with it.
    giftId: text("gift_id")
      .notNull()
      .references(() => giftsAndPayments.id, { onDelete: "cascade" }),
    // Which reconciliation source overwrote the amount ('stripe' | 'quickbooks').
    source: giftFinalAmountSourceEnum("source").notNull(),
    // Amount before / after the stamp (reviewer context).
    oldAmount: numeric("old_amount", { precision: 14, scale: 2 }),
    newAmount: numeric("new_amount", { precision: 14, scale: 2 }),
    // How many gift_allocations rows existed when flagged (0, or >= 2).
    allocationCount: integer("allocation_count").notNull(),
    // 'no_allocation' | 'multi_allocation_mismatch'
    reason: text("reason").notNull(),
    resolvedAt: timestamp("resolved_at"),
    // SET NULL: keep the resolved row if the resolver's user is ever removed.
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("gift_amount_allocation_review_gift_id_idx").on(t.giftId),
    index("gift_amount_allocation_review_resolved_at_idx").on(t.resolvedAt),
    // At most one OPEN review per gift; reconciliation re-runs upsert onto it.
    uniqueIndex("gift_amount_allocation_review_open_gift_uq")
      .on(t.giftId)
      .where(sql`resolved_at IS NULL`),
  ],
);

export type GiftAmountAllocationReview =
  typeof giftAmountAllocationReview.$inferSelect;
export type NewGiftAmountAllocationReview =
  typeof giftAmountAllocationReview.$inferInsert;
