import { pgTable, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { users } from "./users";

export const householdStatusEnum = pgEnum("household_status", [
  "active",
  "dissolved",
]);

export const households = pgTable("households", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  primaryOwnerUserId: text("primary_owner_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  status: householdStatusEnum("status").notNull().default("active"),
  formationDate: timestamp("formation_date"),
  dissolvedDate: timestamp("dissolved_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Household = typeof households.$inferSelect;
export type NewHousehold = typeof households.$inferInsert;
