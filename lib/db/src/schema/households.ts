import {
  pgTable,
  text,
  timestamp,
  pgEnum,
  numeric,
  jsonb,
} from "drizzle-orm/pg-core";
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
  totalGiving: numeric("total_giving", { precision: 15, scale: 2 }).default(
    "0",
  ),
  notes: text("notes"),
  customFields: jsonb("custom_fields").default({}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Household = typeof households.$inferSelect;
export type NewHousehold = typeof households.$inferInsert;
