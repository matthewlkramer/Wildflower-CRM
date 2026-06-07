import {
  pgTable,
  text,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { stagedPayments } from "./stagedPayments";
import { giftsAndPayments } from "./giftsAndPayments";
import { users } from "./users";

/**
 * Split reconciliation (manual): one staged payment → many existing gifts.
 *
 * A single incoming-money record (typically a Stripe payout that nets fees and
 * deposits a lump sum) can cover several different donors' gifts. The one-to-one
 * reconcile (matchedGiftId) and many-to-one group reconcile (groupReconciledGiftId)
 * both assume ONE gift per staged row, so a split needs its own child table:
 * each row links the staged payment to ONE pre-existing gift for a portion
 * (subAmount) of the payout.
 *
 * Invariants (enforced here + in the split route):
 *   - A gift may be the target of at most ONE split link (unique on giftId),
 *     mirroring the one-staged↔one-gift partial-unique indexes on
 *     staged_payments.matched_gift_id / created_gift_id. Combined with the
 *     route's cross-link guard, a gift is "taken" once it is matched, created,
 *     group-reconciled, OR split-linked, and cannot be claimed twice.
 *   - subAmount = the linked gift's own (gross) amount; the sum of a staged
 *     row's split sub-amounts must sit in the fee-band tolerance around the
 *     staged (net) amount. Split membership is exactly the rows sharing one
 *     stagedPaymentId.
 *   - When a staged row is split it carries NONE of matchedGiftId /
 *     createdGiftId / groupReconciledGiftId; its resolution lives entirely in
 *     this table. Reverting the staged row deletes its split rows.
 *
 * gift FK is RESTRICT (a split link is a money-trail reference — unsplit before
 * deleting the gift); staged FK is CASCADE (splits are meaningless without the
 * parent staged row).
 */
export const stagedPaymentSplits = pgTable(
  "staged_payment_splits",
  {
    id: text("id").primaryKey(),
    stagedPaymentId: text("staged_payment_id")
      .notNull()
      .references(() => stagedPayments.id, { onDelete: "cascade" }),
    giftId: text("gift_id")
      .notNull()
      .references(() => giftsAndPayments.id, { onDelete: "restrict" }),
    // The portion of the staged payment attributed to this gift — the gift's
    // own gross amount at split time.
    subAmount: numeric("sub_amount", { precision: 14, scale: 2 }).notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // A gift can be split-linked at most once (no double counting).
    uniqueIndex("staged_payment_splits_gift_id_uq").on(t.giftId),
    // Look up the members of a staged row's split.
    index("staged_payment_splits_staged_payment_id_idx").on(t.stagedPaymentId),
  ],
);

export type StagedPaymentSplit = typeof stagedPaymentSplits.$inferSelect;
export type NewStagedPaymentSplit = typeof stagedPaymentSplits.$inferInsert;
