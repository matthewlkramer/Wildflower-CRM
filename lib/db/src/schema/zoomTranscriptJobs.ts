import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export type ZoomTranscriptTarget =
  | { kind: "development"; day: string }
  | { kind: "calendar"; calendarEventId: string }
  | {
      kind: "donor";
      personIds: string[];
      organizationIds: string[];
      householdIds: string[];
    };

// The occurrence UUID is unique even when a recurring Zoom number is reused.
// This queue contains routing metadata only. Transcript text lives in notes.
export const zoomTranscriptJobs = pgTable(
  "zoom_transcript_jobs",
  {
    uuid: text("uuid").primaryKey(),
    meetingId: text("meeting_id").notNull(),
    hostId: text("host_id").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    meetingType: integer("meeting_type").notNull(),
    target: jsonb("target").$type<ZoomTranscriptTarget>(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    transcriptReadyAt: timestamp("transcript_ready_at", { withTimezone: true }),
    captureRequestedAt: timestamp("capture_requested_at", {
      withTimezone: true,
    }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text("outcome"),
  },
  (t) => [index("zoom_transcript_jobs_due_idx").on(t.nextAttemptAt)],
);
