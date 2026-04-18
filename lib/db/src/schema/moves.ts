import {
  pgTable,
  text,
  timestamp,
  boolean,
  pgEnum,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { individuals } from "./individuals";
import { households } from "./households";
import { fundingEntities } from "./fundingEntities";
import { opportunities } from "./opportunities";
import { users } from "./users";

export const moveLevelEnum = pgEnum("move_level", [
  "individual",
  "household",
  "funding_entity",
]);

export const moveTypeEnum = pgEnum("move_type", [
  "email",
  "call",
  "meeting",
  "site_visit",
  "event",
  "letter",
  "proposal_submission",
  "report",
  "other",
]);

export const moveSourceEnum = pgEnum("move_source", [
  "manual",
  "gmail",
  "calendar",
]);

export const moves = pgTable("moves", {
  id: text("id").primaryKey(),
  subject: text("subject").notNull(),
  moveType: moveTypeEnum("move_type").notNull(),
  moveLevel: moveLevelEnum("move_level").notNull(),
  date: timestamp("date").notNull(),
  individualId: text("individual_id").references(() => individuals.id, {
    onDelete: "set null",
  }),
  householdId: text("household_id").references(() => households.id, {
    onDelete: "set null",
  }),
  fundingEntityId: text("funding_entity_id").references(
    () => fundingEntities.id,
    { onDelete: "set null" },
  ),
  opportunityId: text("opportunity_id").references(() => opportunities.id, {
    onDelete: "set null",
  }),
  staffUserId: text("staff_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  summary: text("summary"),
  outcome: text("outcome"),
  nextStep: text("next_step"),
  nextStepDueDate: timestamp("next_step_due_date"),
  isDraft: boolean("is_draft").default(false),
  source: moveSourceEnum("source").default("manual"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  exactlyOneSubject: check(
    "moves_exactly_one_subject",
    sql`(
      (CASE WHEN ${t.individualId} IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN ${t.householdId} IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN ${t.fundingEntityId} IS NOT NULL THEN 1 ELSE 0 END)
    ) = 1`,
  ),
  levelMatchesSubject: check(
    "moves_level_matches_subject",
    sql`(
      (${t.moveLevel} = 'individual' AND ${t.individualId} IS NOT NULL)
      OR (${t.moveLevel} = 'household' AND ${t.householdId} IS NOT NULL)
      OR (${t.moveLevel} = 'funding_entity' AND ${t.fundingEntityId} IS NOT NULL)
    )`,
  ),
}));

export const moveParticipants = pgTable("move_participants", {
  id: text("id").primaryKey(),
  moveId: text("move_id")
    .notNull()
    .references(() => moves.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Move = typeof moves.$inferSelect;
export type NewMove = typeof moves.$inferInsert;
