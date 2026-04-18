import {
  pgTable,
  text,
  timestamp,
  boolean,
  date,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { households } from "./households";
import { individuals } from "./individuals";

export const householdMemberRoleEnum = pgEnum("household_member_role", [
  "primary",
  "spouse_partner",
  "dependent",
  "other",
]);

export const householdMembers = pgTable(
  "household_members",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    individualId: text("individual_id")
      .notNull()
      .references(() => individuals.id, { onDelete: "cascade" }),
    role: householdMemberRoleEnum("role").notNull().default("other"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    isCurrent: boolean("is_current").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    onePrimaryPerHousehold: uniqueIndex("household_members_one_primary")
      .on(t.householdId)
      .where(sql`${t.role} = 'primary' AND ${t.isCurrent} = true`),
  }),
);

export type HouseholdMember = typeof householdMembers.$inferSelect;
export type NewHouseholdMember = typeof householdMembers.$inferInsert;
