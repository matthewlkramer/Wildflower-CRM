import { pgTable, text, timestamp, numeric, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { gifts } from "./gifts";
import { individuals } from "./individuals";

export const giftSoftCreditTypeEnum = pgEnum("gift_soft_credit_type", [
  "spouse",
  "advisor",
  "introducer",
  "event_captain",
  "household_member",
  "other",
]);

export const giftSoftCredits = pgTable(
  "gift_soft_credits",
  {
    id: text("id").primaryKey(),
    giftId: text("gift_id")
      .notNull()
      .references(() => gifts.id, { onDelete: "cascade" }),
    individualId: text("individual_id")
      .notNull()
      .references(() => individuals.id, { onDelete: "cascade" }),
    creditType: giftSoftCreditTypeEnum("credit_type").notNull(),
    percentage: numeric("percentage", { precision: 5, scale: 2 }),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    uniqueCredit: uniqueIndex("gift_soft_credits_unique").on(
      table.giftId,
      table.individualId,
      table.creditType,
    ),
  }),
);

export type GiftSoftCredit = typeof giftSoftCredits.$inferSelect;
export type NewGiftSoftCredit = typeof giftSoftCredits.$inferInsert;
