import { check, date, index, integer, pgTable, text, timestamp, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { opportunitiesAndPledges } from "./opportunitiesAndPledges";
import { meetingNotes } from "./meetingNotes";
import { emailMessages } from "./emailMessages";
import { users } from "./users";

export const opportunityFollowUps = pgTable("opportunity_follow_ups", {
  id: text("id").primaryKey(),
  opportunityId: text("opportunity_id").notNull().references(() => opportunitiesAndPledges.id, { onDelete: "cascade" }),
  meetingNoteId: text("meeting_note_id").references(() => meetingNotes.id, { onDelete: "set null" }),
  suggestionKey: text("suggestion_key"),
  kind: text("kind", { enum: ["ours", "waiting", "shared"] }).notNull(),
  title: text("title").notNull(),
  ownerName: text("owner_name"),
  pointPersonId: text("point_person_id").references(() => users.id, { onDelete: "set null" }),
  evidenceEmailId: text("evidence_email_id").references(() => emailMessages.id, { onDelete: "set null" }),
  evidenceUrl: text("evidence_url"),
  evidenceNote: text("evidence_note"),
  readStatus: text("read_status", { enum: ["unread", "read", "unknown"] }),
  externalDueDate: date("external_due_date"),
  dependencyId: text("dependency_id").references((): AnyPgColumn => opportunityFollowUps.id),
  checkInDays: integer("check_in_days").notNull().default(14),
  checkInOn: date("check_in_on"),
  sentOn: date("sent_on"),
  resolvedOn: date("resolved_on"),
  updateEmailId: text("update_email_id").references(() => emailMessages.id, { onDelete: "set null" }),
  reviewedEmailsThrough: timestamp("reviewed_emails_through", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("opportunity_follow_ups_opportunity_idx").on(t.opportunityId),
  index("opportunity_follow_ups_check_in_idx").on(t.checkInOn).where(sql`${t.kind} = 'waiting' and ${t.resolvedOn} is null`),
  uniqueIndex("opportunity_follow_ups_suggestion_uq").on(t.opportunityId, t.meetingNoteId, t.suggestionKey),
  check("opportunity_follow_ups_kind_ck", sql`${t.kind} in ('ours', 'waiting', 'shared')`),
  check("opportunity_follow_ups_read_status_ck", sql`${t.readStatus} in ('unread', 'read', 'unknown')`),
  check("opportunity_follow_ups_check_in_days_ck", sql`${t.checkInDays} between 1 and 365`),
]);

export type OpportunityFollowUpRow = typeof opportunityFollowUps.$inferSelect;
