import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations";
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
    dateSourceUrl: text("date_source_url"),
    dateEvidence: text("date_evidence"),
    dateConfidence: text("date_confidence"),
    dateResearchedAt: timestamp("date_researched_at", { withTimezone: true }),
    dateReviewedByUserId: text("date_reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    dateReviewedAt: timestamp("date_reviewed_at", { withTimezone: true }),
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
    sourceDocumentHash: text("source_document_hash"),
    sourceMapping: jsonb("source_mapping").$type<Record<string, unknown>>(),
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
    rawTitle: text("raw_title"),
    rawCombinedTitleOrganization: text("raw_combined_title_organization"),
    proposedTitle: text("proposed_title"),
    proposedOrganization: text("proposed_organization"),
    splitNeedsReview: boolean("split_needs_review"),
    splitEvidence: text("split_evidence"),
    rawCells: jsonb("raw_cells").$type<string[]>(),
    category: text("category"),
    matchConfidence: text("match_confidence"),
    matchedOrganizationId: text("matched_organization_id").references(() => organizations.id, { onDelete: "set null" }),
    candidatePersonIds: text("candidate_person_ids").array(),
    reviewError: text("review_error"),
    foundationEvidence: text("foundation_evidence"),
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
    role: text("role").notNull().default("Attendee"),
    registrationListed: boolean("registration_listed").notNull().default(false),
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
    check("conference_attendance_source_type_ck", sql`${t.sourceType} IN ('uploaded_list', 'conference_website', 'wildflower_email', 'manual', 'agenda_speaker')`),
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
    kind: text("kind").notNull().default("agenda_speakers"),
    windowKey: text("window_key"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    sources: jsonb("sources").$type<unknown[]>().notNull().default([]),
    evidence: jsonb("evidence").$type<unknown[]>().notNull().default([]),
    proposedStartDate: date("proposed_start_date", { mode: "string" }),
    proposedEndDate: date("proposed_end_date", { mode: "string" }),
    proposedDateConfidence: text("proposed_date_confidence"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("conference_research_requests_event_idx").on(t.conferenceEventId),
    index("conference_research_requests_status_next_attempt_idx").on(t.status, t.nextAttemptAt),
    uniqueIndex("conference_research_requests_event_kind_window_uq").on(t.conferenceEventId, t.kind, t.windowKey),
    check("conference_research_requests_kind_ck", sql`${t.kind} IN ('dates', 'agenda_speakers')`),
    check("conference_research_requests_attempts_ck", sql`${t.attempts} >= 0`),
  ],
);

export const conferenceSpeakerProposals = pgTable(
  "conference_speaker_proposals",
  {
    id: text("id").primaryKey(),
    conferenceEventId: text("conference_event_id").notNull().references(() => conferenceEvents.id, { onDelete: "cascade" }),
    conferenceResearchRequestId: text("conference_research_request_id").references(() => conferenceResearchRequests.id, { onDelete: "set null" }),
    speakerFingerprint: text("speaker_fingerprint").notNull(),
    name: text("name").notNull(),
    title: text("title"),
    organizationName: text("organization_name"),
    bio: text("bio"),
    profileUrl: text("profile_url"),
    sourceUrl: text("source_url"),
    sessionEvidence: text("session_evidence"),
    confidence: text("confidence").notNull(),
    candidatePersonIds: text("candidate_person_ids").array().notNull().default(sql`'{}'::text[]`),
    matchedPersonId: text("matched_person_id").references(() => people.id, { onDelete: "set null" }),
    matchedOrganizationId: text("matched_organization_id").references(() => organizations.id, { onDelete: "set null" }),
    addedPersonId: text("added_person_id").references(() => people.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conference_speaker_proposals_event_fingerprint_uq").on(t.conferenceEventId, t.speakerFingerprint),
    index("conference_speaker_proposals_event_status_idx").on(t.conferenceEventId, t.status),
    index("conference_speaker_proposals_run_idx").on(t.conferenceResearchRequestId),
    check("conference_speaker_proposals_status_ck", sql`${t.status} IN ('pending', 'added', 'ignored')`),
    check("conference_speaker_proposals_confidence_ck", sql`${t.confidence} IN ('high', 'medium', 'low')`),
  ],
);

export type ConferenceType = typeof conferenceTypes.$inferSelect;
export type ConferenceEvent = typeof conferenceEvents.$inferSelect;
export type ConferenceAttendance = typeof conferenceAttendance.$inferSelect;
export type ConferenceResearchRequest = typeof conferenceResearchRequests.$inferSelect;
export type ConferenceSpeakerProposal = typeof conferenceSpeakerProposals.$inferSelect;
