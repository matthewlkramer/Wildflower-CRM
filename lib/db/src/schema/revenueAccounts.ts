import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * Closed list of QuickBooks revenue accounts (Object Codes) from the CFO
 * "Revenue Extractor" spec. The Object Code on a gift/pledge allocation MUST be
 * one of these `code` values — the derivation engine and the form choosers read
 * from this table.
 *
 * Seeded (and kept in sync) from `REVENUE_ACCOUNTS` in
 * `@workspace/api-zod` (revenue-coding). Lightly editable by admins (name /
 * active), but the code set itself is a fixed taxonomy.
 *
 *   kind: 'unrestricted' (4000.x) | 'restricted' (4100.x) | 'special'
 *   payerType: individual | foundation | corporation | governmental (the .x
 *              suffix), or null for the special accounts.
 */
export const revenueAccounts = pgTable("revenue_accounts", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  payerType: text("payer_type"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type RevenueAccount = typeof revenueAccounts.$inferSelect;
export type NewRevenueAccount = typeof revenueAccounts.$inferInsert;
