import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { users } from "./users";

export const households = pgTable("households", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  primaryOwnerUserId: text("primary_owner_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Household = typeof households.$inferSelect;
export type NewHousehold = typeof households.$inferInsert;
