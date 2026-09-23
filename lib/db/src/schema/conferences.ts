import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { people } from "./people";
import { users } from "./users";

export const conferenceTypes = pgTable(
  "conference_types",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    organizer: text("organizer"),
    websiteUrl: text("website_url"),
    active: boolean("active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("conference_types_display_name_uq").on(t.displayName)],
);

export const conferenceEvents = pgTable(
  "conference_events",
  {
    id: text("id").primaryKey(),
    conferenceTypeId: text("conference_type_id")
      .notNull()
      .references(() => conferenceTypes.id, { onDelete: "restrict" }),
    year: integer("year").notNull(),
    nameOverride: text("name_override"),
    startDate: date("start_date", { mode: "string" }),
    endDate: date("end_date", { mode: "string" }),
    location: text("location"),
    attendeeSiteUrl: text("attendee_site_url"),
    source: text("source"),
    status: text("status").notNull().default("planned"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conference_events_type_year_uq").on(t.conferenceTypeId, t.year),
    index("conference_events_type_idx").on(t.conferenceTypeId),
    check("conference_events_year_ck", sql`${t.year} BETWEEN 2000 AND 2200`),
    check("conference_events_status_ck", sql`${t.status} IN ('planned', 'completed', 'cancelled')`),
  ],
);

export const conferenceImportBatches = pgTable(
  "conference_import_batches",
  {
    id: text("id").primaryKey(),
    conferenceEventId: text("conference_event_id")
      .notNull()
      .references(() => conferenceEvents.id, { onDelete: "cascade" }),
    sourceHash: text("source_hash").notNull(),
    sourceFilename: text("source_filename"),
    status: text("status").notNull().default("staged"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    confirmedByUserId: text("confirmed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conference_import_batches_event_hash_uq").on(t.conferenceEventId, t.sourceHash),
    index("conference_import_batches_event_idx").on(t.conferenceEventId),
    check("conference_import_batches_status_ck", sql`${t.status} IN ('staged', 'confirmed')`),
  ],
);

export const conferenceImportRows = pgTable(
  "conference_import_rows",
  {
    id: text("id").primaryKey(),
    conferenceImportBatchId: text("conference_import_batch_id")
      .notNull()
      .references(() => conferenceImportBatches.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    rawName: text("raw_name"),
    rawEmail: text("raw_email"),
    rawOrganization: text("raw_organization"),
    matchStatus: text("match_status").notNull(),
    matchedPersonId: text("matched_person_id").references(() => people.id, { onDelete: "set null" }),
    matchEvidence: text("match_evidence"),
    reviewedPersonId: text("reviewed_person_id").references(() => people.id, { onDelete: "set null" }),
    disposition: text("disposition").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conference_import_rows_batch_number_uq").on(t.conferenceImportBatchId, t.rowNumber),
    index("conference_import_rows_batch_idx").on(t.conferenceImportBatchId),
    index("conference_import_rows_person_idx").on(t.matchedPersonId),
    check("conference_import_rows_match_status_ck", sql`${t.matchStatus} IN ('exact', 'ambiguous', 'unmatched')`),
    check("conference_import_rows_disposition_ck", sql`${t.disposition} IN ('pending', 'accept', 'skip')`),
  ],
);

export const conferenceAttendance = pgTable(
  "conference_attendance",
  {
    id: text("id").primaryKey(),
    conferenceEventId: text("conference_event_id")
      .notNull()
      .references(() => conferenceEvents.id, { onDelete: "cascade" }),
    personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("confirmed"),
    sourceType: text("source_type").notNull().default("manual"),
    sourceReference: text("source_reference"),
    evidenceNote: text("evidence_note"),
    organizationSnapshot: text("organization_snapshot"),
    matchedByUserId: text("matched_by_user_id").references(() => users.id, { onDelete: "set null" }),
    importedByUserId: text("imported_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conference_attendance_event_person_uq").on(t.conferenceEventId, t.personId),
    index("conference_attendance_person_idx").on(t.personId),
    index("conference_attendance_event_idx").on(t.conferenceEventId),
    check("conference_attendance_status_ck", sql`${t.status} IN ('confirmed', 'likely', 'possible')`),
    check("conference_attendance_source_type_ck", sql`${t.sourceType} IN ('uploaded_list', 'conference_website', 'wildflower_email', 'manual')`),
  ],
);

export const conferenceAttendanceSuggestions = pgTable(
  "conference_attendance_suggestions",
  {
    id: text("id").primaryKey(),
    conferenceEventId: text("conference_event_id").notNull().references(() => conferenceEvents.id, { onDelete: "cascade" }),
    personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    emailMessageId: text("email_message_id"),
    confidence: text("confidence").notNull(),
    evidenceNote: text("evidence_note").notNull(),
    status: text("status").notNull().default("pending"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conference_attendance_suggestions_event_person_email_uq").on(t.conferenceEventId, t.personId, t.emailMessageId),
    index("conference_attendance_suggestions_event_idx").on(t.conferenceEventId, t.status),
    check("conference_attendance_suggestions_confidence_ck", sql`${t.confidence} IN ('high', 'medium', 'low')`),
    check("conference_attendance_suggestions_status_ck", sql`${t.status} IN ('pending', 'accepted', 'dismissed')`),
  ],
);

export const conferenceResearchRequests = pgTable(
  "conference_research_requests",
  {
    id: text("id").primaryKey(),
    conferenceEventId: text("conference_event_id").notNull().references(() => conferenceEvents.id, { onDelete: "cascade" }),
    attendeeSiteUrl: text("attendee_site_url"),
    instructions: text("instructions"),
    prompt: text("prompt").notNull(),
    status: text("status").notNull().default("drafted"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conference_research_requests_event_idx").on(t.conferenceEventId)],
);

export type ConferenceType = typeof conferenceTypes.$inferSelect;
export type ConferenceEvent = typeof conferenceEvents.$inferSelect;
export type ConferenceAttendance = typeof conferenceAttendance.$inferSelect;