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

// Per-user privacy mode for Gmail sync.
//   full         — store subject + body + attachments (existing behavior)
//   summary_only — store ONLY an AI-generated one-line topic summary.
//                  bodyText / bodyHtml / snippet are dropped during sync and
//                  attachments are not downloaded. The sender's preference
//                  wins for everyone viewing the contact timeline: if the
//                  mailbox owner is in summary_only mode, no one ever sees
//                  the body — it was never persisted.
export const emailSyncModeEnum = pgEnum("email_sync_mode", [
  "full",
  "summary_only",
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
  emailSyncMode: emailSyncModeEnum("email_sync_mode").notNull().default("full"),
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
