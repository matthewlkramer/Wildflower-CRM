import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";
import { organizations } from "./organizations";
import { people } from "./people";
import { households } from "./households";
import { calendarEvents } from "./calendarEvents";

/**
 * Meeting notes captured from live staff notes, pasted transcripts,
 * photographed paper notes, or browser-recorded meeting audio. The server
 * can run source text through an AI model to extract:
 *   - aiSummary:   short paragraph summary
 *   - actionItems: structured todos (jsonb)
 *
 * Privacy: when the creator's `users.email_sync_mode = 'summary_only'`,
 * raw transcript text is dropped server-side BEFORE insert. Explicitly
 * uploaded source files remain attached to the meeting. The
 * `summaryOnly` boolean snapshots that decision at create time so the
 * UI can show "transcript discarded" even if the user later flips back
 * to `full` mode. The mirror of the email-sync privacy split — the
 * creator owns the privacy decision and it's irreversible per-record.
 *
 * Contact xor: a meeting note is always about exactly ONE primary
 * contact — a person, a household, or an organization. DB-enforced via
 * the `meeting_notes_contact_xor` CHECK constraint. Routes pre-validate
 * the same invariant to return 400 instead of 500.
 */
export const meetingNotes = pgTable(
  "meeting_notes",
  {
    id: text("id").primaryKey(),
    title: text("title"),
    meetingDate: timestamp("meeting_date", { withTimezone: true })
      .defaultNow()
      .notNull(),
    attendees: text("attendees").array(),
    // Verbatim notes typed by a staff member during or after the meeting.
    // Kept separate from the AI summary so later summarization never
    // overwrites the source notes.
    manualNotes: text("manual_notes"),
    rawTranscript: text("raw_transcript"),
    summaryOnly: boolean("summary_only").notNull().default(false),
    aiSummary: text("ai_summary"),
    actionItems: jsonb("action_items"),
    // Immutable source files captured for this meeting. The object itself
    // lives in private object storage; this JSON keeps its metadata and the
    // OpenAI-produced transcript next to the meeting record.
    artifacts: jsonb("artifacts")
      .$type<MeetingArtifact[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    creatorUserId: text("creator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // FKs are RESTRICT, not SET NULL — the contact_xor CHECK requires
    // exactly one non-null contact, so an ON DELETE SET NULL would turn
    // a routine person/org/household delete into a CHECK violation
    // and refuse the delete (or leave the meeting note in a forbidden
    // state). Forcing the user to delete the meeting note first keeps
    // the invariant clean.
    personId: text("person_id").references(() => people.id, {
      onDelete: "restrict",
    }),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    householdId: text("household_id").references(() => households.id, {
      onDelete: "restrict",
    }),
    calendarEventId: text("calendar_event_id").references(
      () => calendarEvents.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("meeting_notes_creator_user_id_idx").on(t.creatorUserId),
    index("meeting_notes_meeting_date_idx").on(t.meetingDate),
    index("meeting_notes_person_id_idx").on(t.personId),
    index("meeting_notes_organization_id_idx").on(t.organizationId),
    index("meeting_notes_household_id_idx").on(t.householdId),
    uniqueIndex("meeting_notes_calendar_event_id_uq")
      .on(t.calendarEventId)
      .where(sql`${t.calendarEventId} is not null`),
    check(
      "meeting_notes_contact_xor",
      sql`num_nonnulls(${t.personId}, ${t.organizationId}, ${t.householdId}) = 1`,
    ),
  ],
);

export type MeetingNote = typeof meetingNotes.$inferSelect;
export type NewMeetingNote = typeof meetingNotes.$inferInsert;

/**
 * Shape of one element of meeting_notes.action_items (jsonb array).
 * `promotedTaskId` is set after the user clicks "Promote to task" so the
 * UI can show a "Created task" affordance and avoid duplicate promotion.
 */
export interface MeetingActionItem {
  title: string;
  assigneeName?: string | null;
  dueDate?: string | null;
  promotedTaskId?: string | null;
}

export type MeetingArtifactKind = "handwritten_notes" | "audio_recording";

export interface MeetingArtifact {
  id: string;
  kind: MeetingArtifactKind;
  objectPath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  transcript: string;
  createdAt: string;
}
