import {
  pgTable,
  text,
  numeric,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { giftsAndPayments } from "./giftsAndPayments";
import { users } from "./users";

/**
 * Many-to-many CORROBORATING evidence links between a CRM gift and a piece of
 * funding/accounting evidence (a QuickBooks staged row or a Stripe staged
 * charge). This is the additive layer that makes evidence↔gift truly
 * many-to-many (INV-6 / §4.2): one gift may point at several evidence rows (the
 * Stripe charge AND the QuickBooks deposit for the same money) and one evidence
 * row may corroborate several gifts (a bulk deposit that batches many donors).
 *
 * Book-once is preserved structurally: these links are *corroborating only* and
 * never contribute to any counted total. The single COUNTED (book-once) source
 * of a gift's amount stays where it already lives —
 * `gifts_and_payments.final_amount_*` and the partial-unique
 * `staged_payments.matched/created/group_reconciled_gift_id` /
 * `staged_payment_splits` pointers. Because a corroborating link can never be
 * "the counted source", adding any number of them cannot double-count a dollar.
 *
 * `evidenceId` is polymorphic (a staged_payments.id OR a
 * stripe_staged_charges.id) so — like `duplicate_dismissals` — it carries NO
 * foreign key; `evidenceKind` disambiguates. The gift FK is CASCADE: a
 * corroborating link is a re-derivable CRM-side annotation, not part of the
 * money trail, so deleting/merging a gift simply drops its links (the detector
 * re-surfaces the tie if it still holds) without having to edit the
 * battle-tested gift merge/delete paths.
 */
export const giftEvidenceLinks = pgTable(
  "gift_evidence_links",
  {
    id: text("id").primaryKey(),
    giftId: text("gift_id")
      .notNull()
      .references(() => giftsAndPayments.id, { onDelete: "cascade" }),
    // 'qb_staged' → staged_payments.id, 'stripe_charge' → stripe_staged_charges.id
    evidenceKind: text("evidence_kind").notNull(),
    evidenceId: text("evidence_id").notNull(),
    // The portion of the evidence attributed to this gift, for display/audit.
    // Optional — corroboration does not require an exact sub-amount.
    subAmount: numeric("sub_amount", { precision: 14, scale: 2 }),
    note: text("note"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // A given evidence row corroborates a given gift at most once.
    uniqueIndex("gift_evidence_links_gift_evidence_uq").on(
      t.giftId,
      t.evidenceKind,
      t.evidenceId,
    ),
    // Reverse lookup: which gifts does this evidence corroborate?
    index("gift_evidence_links_evidence_idx").on(t.evidenceKind, t.evidenceId),
    index("gift_evidence_links_gift_id_idx").on(t.giftId),
    check(
      "gift_evidence_links_evidence_kind",
      sql`${t.evidenceKind} in ('qb_staged', 'stripe_charge')`,
    ),
  ],
);

export type GiftEvidenceLink = typeof giftEvidenceLinks.$inferSelect;
export type NewGiftEvidenceLink = typeof giftEvidenceLinks.$inferInsert;
