import { pgTable, text, timestamp, numeric } from "drizzle-orm/pg-core";
import { fundEnum } from "./users";
import { gifts } from "./gifts";

export const giftAllocations = pgTable("gift_allocations", {
  id: text("id").primaryKey(),
  giftId: text("gift_id")
    .notNull()
    .references(() => gifts.id, { onDelete: "cascade" }),
  fund: fundEnum("fund").notNull(),
  amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
  fiscalYear: text("fiscal_year"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type GiftAllocation = typeof giftAllocations.$inferSelect;
export type NewGiftAllocation = typeof giftAllocations.$inferInsert;
