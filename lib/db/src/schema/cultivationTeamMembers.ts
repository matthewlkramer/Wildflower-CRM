import {
  pgTable,
  text,
  timestamp,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { cultivationTeamRoleEnum } from "./_enums";

export const cultivationTeamOwnerTypeEnum = pgEnum(
  "cultivation_team_owner_type",
  ["individual", "household", "funding_entity"],
);

export const cultivationTeamMembers = pgTable(
  "cultivation_team_members",
  {
    id: text("id").primaryKey(),
    ownerType: cultivationTeamOwnerTypeEnum("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: cultivationTeamRoleEnum("role").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqueMember: uniqueIndex("cultivation_team_members_unique").on(
      t.ownerType,
      t.ownerId,
      t.userId,
      t.role,
    ),
  }),
);

export type CultivationTeamMember = typeof cultivationTeamMembers.$inferSelect;
export type NewCultivationTeamMember =
  typeof cultivationTeamMembers.$inferInsert;
