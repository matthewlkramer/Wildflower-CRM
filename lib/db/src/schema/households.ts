import { index, pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const households = pgTable("households", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // Marks whether the household is still intact. Set to false when a
  // household is dissolved by death or divorce.
  active: boolean("active").default(true).notNull(),
  // Soft-delete: non-null = archived (hidden from non-admins). Separate from
  // the `active` flag (household intact vs dissolved).
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("households_archived_at_idx").on(t.archivedAt),
]);

export type Household = typeof households.$inferSelect;
export type NewHousehold = typeof households.$inferInsert;
