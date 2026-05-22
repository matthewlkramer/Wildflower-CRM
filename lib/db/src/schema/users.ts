import { pgTable, text, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", [
  "admin",
  "team_member",
  "finance",
  "read_only",
]);

export const fundEnum = pgEnum("fund", [
  "general_operating",
  "seed_fund",
  "black_wildflowers",
  "sunlight",
]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  clerkId: text("clerk_id").notNull().unique(),
  email: text("email").notNull().unique(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  displayName: text("display_name"),
  role: userRoleEnum("role").notNull().default("team_member"),
  defaultFund: fundEnum("default_fund"),
  // Soft-delete marker. Non-null = archived. Archived users are filtered
  // out of user pickers but remain resolvable so historical owner_user_id
  // refs still render a real name. Every owner_user_id FK is RESTRICT, so
  // archive is the only safe way to retire a team member without orphaning
  // records they owned.
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
