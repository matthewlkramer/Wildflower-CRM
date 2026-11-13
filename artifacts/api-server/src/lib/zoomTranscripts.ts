import { db } from "@workspace/db";
import {
  calendarEvents,
  googleOauthTokens,
  meetingNotes,
  users,
  zoomTranscriptJobs,
  type MeetingActionItem,
  type ZoomTranscriptTarget,
} from "@workspace/db/schema";
import {
  and,
  asc,
  eq,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { isMatchEmpty } from "./emailMatcher";
import { chicagoToday } from "./effectiveProjectedCloseDate";
import { createDevelopmentMeeting } from "./developmentMeetings";
import { newId } from "./helpers";
import { logger } from "./logger";
import { meetingRelationshipContext, savedMeetingSource } from "./meetingAnalysis";
import {
  hasUsableMeetingSummary,
  mergeTranscriptActionItems,
  staffMeetingActionItems,
  summarizeMeeting,
} from "./summarizeMeeting";
import { withSyncLock } from "./syncLock";
import {
  downloadZoomTranscript,
  startZoomTranscript,
  zoomCaptureAccount,
  ZoomRequestError,
} from "./zoomClient";
import { findZoomCalendarEvents, matchZoomDonors } from "./zoomDonorMeetings";
import {
  parseZoomMeetingEvent,
  ZOOM_START_WINDOW_MS,
} from "./zoomMeetingIdentity";

type Job = typeof zoomTranscriptJobs.$inferSelect;
type Owner = Pick<typeof users.$inferSelect, "id" | "email" | "emailSyncMode">;
const RETRY_WINDOW_MS = 48 * 60 * 60_000;
const MAX_START_RETRY_MS = 90_000;
const TICK_MS = 20_000;
let running = false;

async function resolveHost(email: string) {
  const matches = await db
    .select({ id: users.id })
    .from(users)
    .leftJoin(
      googleOauthTokens,
      and(
        eq(users.id, googleOauthTokens.userId),
        isNull(googleOauthTokens.revokedAt),
      ),
    )
    .where(
      and(
        isNull(users.archivedAt),
        ne(users.role, "read_only"),
        or(
          eq(sql`lower(${users.email})`, email),
          eq(sql`lower(${googleOauthTokens.googleEmail})`, email),
        ),
      ),
    )
    .limit(2);
  return matches.length === 1 ? matches[0] : null;
}

/** Called only after signature verification. Store routing facts before acknowledging delivery. */
export async function enqueueZoomMeetingEvent(
  name: string,
  payload: unknown,
  timestamp?: number,
) {
  const account = zoomCaptureAccount();
  if (!account) return;
  const event = parseZoomMeetingEvent(
    name,
    payload,
    timestamp,
    account.accountId,
  );
  if (!event) return;
  if (event.kind === "started") {
    if (Date.now() - event.at.valueOf() > ZOOM_START_WINDOW_MS) return;
    const owner = await resolveHost(event.hostEmail!);
    if (!owner) return;
    await db
      .insert(zoomTranscriptJobs)
      .values({
        uuid: event.uuid,
        meetingId: event.meetingId,
        hostId: event.hostId,
        meetingType: event.meetingType!,
        ownerUserId: owner.id,
        startedAt: event.at,
        nextAttemptAt: new Date(),
      })
      .onConflictDoNothing();
    return;
  }
  const identity = and(
    eq(zoomTranscriptJobs.uuid, event.uuid),
    eq(zoomTranscriptJobs.hostId, event.hostId),
    eq(zoomTranscriptJobs.meetingId, event.meetingId),
    isNull(zoomTranscriptJobs.finishedAt),
  );
  if (event.kind === "ended" || event.kind === "transcript") {
    if (event.kind === "ended") {
      await db
        .update(zoomTranscriptJobs)
        .set({
          endedAt: event.at,
          nextAttemptAt: sql`coalesce(${zoomTranscriptJobs.nextAttemptAt}, now() + interval '30 seconds')`,
        })
        .where(and(identity, isNull(zoomTranscriptJobs.endedAt)));
    } else {
      await db
        .update(zoomTranscriptJobs)
        .set({
          transcriptReadyAt: event.at,
          nextAttemptAt: new Date(),
        })
        .where(and(identity, isNull(zoomTranscriptJobs.transcriptReadyAt)));
    }
    return;
  }
  // Most external guests' email addresses are withheld by Zoom. This covers
  // instant meetings when Zoom does identify the donor, without storing emails.
  const [job] = await db
    .select({ job: zoomTranscriptJobs, email: users.email })
    .from(zoomTranscriptJobs)
    .innerJoin(users, eq(users.id, zoomTranscriptJobs.ownerUserId))
    .where(
      and(
        identity,
        isNull(zoomTranscriptJobs.endedAt),
        isNull(zoomTranscriptJobs.target),
      ),
    );
  if (
    !job ||
    ![1, 4].includes(job.job.meetingType) ||
    Date.now() - job.job.startedAt.valueOf() > ZOOM_START_WINDOW_MS
  )
    return;
  const matches = await matchZoomDonors(
    [event.participantEmail!],
    job.email,
    job.job.startedAt,
  );
  if (isMatchEmpty(matches)) return;
  await db
    .update(zoomTranscriptJobs)
    .set({
      target: { kind: "donor", ...matches },
      nextAttemptAt: new Date(),
    })
    .where(
      and(
        identity,
        isNull(zoomTranscriptJobs.endedAt),
        isNull(zoomTranscriptJobs.target),
      ),
    );
}

async function resolveTarget(
  job: Job,
  owner: Owner,
): Promise<ZoomTranscriptTarget | null> {
  const developmentIds =
    process.env.ZOOM_FORWFCRM_DEVELOPMENT_MEETING_IDS?.split(",").map((id) =>
      id.trim(),
    );
  if (developmentIds?.includes(job.meetingId)) {
    return { kind: "development", day: chicagoToday(job.startedAt) };
  }
  const events = await findZoomCalendarEvents(
    owner.id,
    job.meetingId,
    job.startedAt,
    job.target?.kind === "donor",
  );
  if (events.length > 1) return null;
  const [match] = events;
  if (!match) return job.target?.kind === "donor" ? job.target : null;
  if (!match.event || !match.shareable) return null;
  const donors = await matchZoomDonors(
    match.attendeeEmails,
    owner.email,
    match.event.startAt,
  );
  return isMatchEmpty(donors)
    ? null
    : { kind: "calendar", calendarEventId: match.event.id };
}

async function finish(job: Job, outcome: string) {
  await db
    .update(zoomTranscriptJobs)
    .set({
      outcome,
      finishedAt: new Date(),
      nextAttemptAt: null,
    })
    .where(eq(zoomTranscriptJobs.uuid, job.uuid));
}

async function requestCapture(job: Job, owner: Owner) {
  if (
    job.endedAt ||
    job.transcriptReadyAt ||
    Date.now() - job.startedAt.valueOf() > ZOOM_START_WINDOW_MS
  ) {
    await finish(job, "skipped");
    return;
  }
  const target = await resolveTarget(job, owner);
  if (!target) {
    // A calendar sync may be finishing just as a scheduled call starts.
    await db
      .update(zoomTranscriptJobs)
      .set({
        nextAttemptAt:
          Date.now() - job.startedAt.valueOf() < MAX_START_RETRY_MS
            ? new Date(Date.now() + TICK_MS)
            : null,
      })
      .where(
        and(
          eq(zoomTranscriptJobs.uuid, job.uuid),
          isNull(zoomTranscriptJobs.endedAt),
          // An identified participant may have qualified it while we were looking.
          isNull(zoomTranscriptJobs.target),
        ),
      );
    if (job.target?.kind === "donor") await finish(job, "skipped");
    return;
  }
  const [claimed] = await db
    .update(zoomTranscriptJobs)
    .set({ target })
    .where(
      and(
        eq(zoomTranscriptJobs.uuid, job.uuid),
        isNull(zoomTranscriptJobs.endedAt),
        isNull(zoomTranscriptJobs.transcriptReadyAt),
      ),
    )
    .returning({ uuid: zoomTranscriptJobs.uuid });
  if (!claimed) return;
  await startZoomTranscript(job.meetingId);
  await db
    .update(zoomTranscriptJobs)
    .set({
      captureRequestedAt: new Date(),
      attempts: 0,
      nextAttemptAt: sql`case when ${zoomTranscriptJobs.transcriptReadyAt} is not null then now()
      when ${zoomTranscriptJobs.endedAt} is not null then now() + interval '30 seconds'
      else null end`,
    })
    .where(eq(zoomTranscriptJobs.uuid, job.uuid));
}

async function importTranscript(job: Job, owner: Owner) {
  const target = job.target;
  if (!target) {
    await finish(job, "skipped");
    return;
  }
  const matches =
    target.kind === "calendar"
      ? await findZoomCalendarEvents(owner.id, job.meetingId, job.startedAt)
      : [];
  const [match] = matches;
  const event = match?.event;
  if (
    target.kind === "calendar" &&
    (matches.length !== 1 ||
      !match?.shareable ||
      event?.id !== target.calendarEventId)
  ) {
    await finish(job, "skipped");
    return;
  }
  const links = event
    ? await matchZoomDonors(match!.attendeeEmails, owner.email, event.startAt)
    : target.kind === "donor"
      ? target
      : { personIds: [], organizationIds: [], householdIds: [] };
  if (target.kind !== "development" && isMatchEmpty(links)) {
    await finish(job, "skipped");
    return;
  }
  const transcript = await downloadZoomTranscript(job.uuid);
  if (!transcript) throw new Error("Zoom transcript is not ready");
  const eventScope = event && (event.gcalEventId
    ? eq(calendarEvents.gcalEventId, event.gcalEventId)
    : eq(calendarEvents.id, event.id));
  const existingForEvent = eventScope
    ? await db.select({ note: meetingNotes, version: sql<string>`${meetingNotes}."xmin"::text` })
        .from(meetingNotes)
        .innerJoin(calendarEvents, eq(calendarEvents.id, meetingNotes.calendarEventId))
        .where(eventScope).limit(2)
    : [];
  if (existingForEvent.length > 1) {
    await finish(job, "ambiguous_note");
    return;
  }
  const prior = existingForEvent[0]?.note;
  const source = prior ? savedMeetingSource(prior) : "";
  const result = await summarizeMeeting([source, transcript].filter(Boolean).join("\n\nZoom transcript\n"), {
    relationship: await meetingRelationshipContext(prior ?? links, event?.startAt ?? job.startedAt, prior?.id, true),
    priorSummary: prior?.summaryOnly ? prior.aiSummary ?? undefined : undefined,
  });
  if (!hasUsableMeetingSummary(result)) {
    throw new Error("Zoom transcript could not be summarized");
  }
  const developmentId =
    target.kind === "development"
      ? await createDevelopmentMeeting(
          target.day,
          owner.id,
          owner.emailSyncMode === "summary_only",
        )
      : null;
  await db.transaction(async (tx) => {
    // Match notes created by other staff on a synced copy of the same event.
    const existing = developmentId
      ? await tx
          .select()
          .from(meetingNotes)
          .where(eq(meetingNotes.id, developmentId))
          .for("update")
          .then((rows) => rows.map((note) => ({ note, version: undefined })))
      : eventScope
        ? await tx
            .select({ note: meetingNotes, version: sql<string>`${meetingNotes}."xmin"::text` })
            .from(meetingNotes)
            .innerJoin(
              calendarEvents,
              eq(calendarEvents.id, meetingNotes.calendarEventId),
            )
            .where(eventScope)
            .limit(2)
            .for("update", { of: meetingNotes })
        : [];
    if (existing.length > 1) {
      await tx
        .update(zoomTranscriptJobs)
        .set({
          finishedAt: new Date(),
          nextAttemptAt: null,
          outcome: "ambiguous_note",
        })
        .where(eq(zoomTranscriptJobs.uuid, job.uuid));
      return;
    }
    const [latest] = existing;
    if (eventScope && latest?.version !== existingForEvent[0]?.version) {
      throw new Error("Meeting note changed while processing Zoom transcript");
    }
    const note = latest?.note;
    const summaryOnly =
      owner.emailSyncMode === "summary_only" || !!note?.summaryOnly;
    const items = (note?.actionItems ?? []) as MeetingActionItem[];
    const existingSummary = note?.aiSummary?.trim();
    const imported = {
      followUpSuggestions: result.followUps ?? [],
      aiSummary:
        (developmentId || !source) && existingSummary && existingSummary !== result.summary
          ? existingSummary + "\n\nZoom transcript summary\n" + result.summary
          : result.summary,
      actionItems: mergeTranscriptActionItems(
        developmentId || !source || note?.summaryOnly ? items : staffMeetingActionItems(items),
        result,
      ),
      // Preserve staff-entered source material and apply the host's privacy
      // preference to the imported text only.
      rawTranscript: summaryOnly
        ? (note?.rawTranscript ?? null)
        : [note?.rawTranscript, transcript].filter(Boolean).join("\n\n"),
    };
    if (note) {
      await tx
        .update(meetingNotes)
        .set({ ...imported, updatedAt: new Date() })
        .where(eq(meetingNotes.id, note.id));
    } else {
      await tx.insert(meetingNotes).values({
        id: newId(),
        creatorUserId: owner.id,
        meetingDate: job.startedAt,
        title: event?.summary || "Donor meeting (Zoom)",
        calendarEventId: event?.id,
        summaryOnly,
        personIds: links.personIds,
        organizationIds: links.organizationIds,
        householdIds: links.householdIds,
        ...imported,
      });
    }
    await tx
      .update(zoomTranscriptJobs)
      .set({
        outcome: "imported",
        finishedAt: new Date(),
        nextAttemptAt: null,
      })
      .where(eq(zoomTranscriptJobs.uuid, job.uuid));
  });
}

async function processJob(job: Job) {
  const [owner] = await db
    .select({
      id: users.id,
      email: users.email,
      emailSyncMode: users.emailSyncMode,
    })
    .from(users)
    .where(
      and(
        eq(users.id, job.ownerUserId),
        isNull(users.archivedAt),
        ne(users.role, "read_only"),
      ),
    );
  if (!owner) return finish(job, "skipped");
  // Only download transcripts from occurrences selected by this integration.
  const importing =
    !!job.target &&
    (!!job.transcriptReadyAt || (!!job.captureRequestedAt && !!job.endedAt));
  try {
    if (importing) {
      const readySince = job.transcriptReadyAt ?? job.endedAt!;
      if (Date.now() - readySince.valueOf() > RETRY_WINDOW_MS)
        return finish(job, "transcript_unavailable");
      await importTranscript(job, owner);
    } else if (job.captureRequestedAt) {
      return;
    } else {
      await requestCapture(job, owner);
    }
  } catch (error) {
    const status = error instanceof ZoomRequestError ? error.status : undefined;
    const operation =
      error instanceof ZoomRequestError ? error.operation : undefined;
    if (
      status === 403 ||
      (!importing && Date.now() - job.startedAt.valueOf() > MAX_START_RETRY_MS)
    ) {
      await finish(job, importing ? "import_failed" : "capture_failed");
    } else {
      const delay = importing
        ? Math.min(60_000 * 2 ** job.attempts, 3_600_000)
        : TICK_MS;
      await db
        .update(zoomTranscriptJobs)
        .set({
          attempts: job.attempts + 1,
          nextAttemptAt: new Date(Date.now() + delay),
        })
        .where(eq(zoomTranscriptJobs.uuid, job.uuid));
    }
    logger.warn(
      { operation, status, importing, attempts: job.attempts + 1 },
      "Zoom transcript job will need attention",
    );
  }
}

export async function runZoomTranscriptJobs() {
  if (running || !zoomCaptureAccount()) return;
  running = true;
  try {
    await withSyncLock("wfcrm", "zoom_transcripts", async () => {
      const now = new Date();
      const jobs = await db
        .select()
        .from(zoomTranscriptJobs)
        .where(
          and(
            isNull(zoomTranscriptJobs.finishedAt),
            isNotNull(zoomTranscriptJobs.nextAttemptAt),
            lte(zoomTranscriptJobs.nextAttemptAt, now),
          ),
        )
        .orderBy(asc(zoomTranscriptJobs.nextAttemptAt))
        .limit(10);
      for (const job of jobs) await processJob(job);
      await db
        .delete(zoomTranscriptJobs)
        .where(
          lt(
            zoomTranscriptJobs.startedAt,
            new Date(now.valueOf() - 30 * 86_400_000),
          ),
        );
    });
  } catch {
    logger.warn("Zoom transcript queue could not be processed");
  } finally {
    running = false;
  }
}

export function startZoomTranscriptScheduler() {
  if (!zoomCaptureAccount()) return;
  setInterval(() => void runZoomTranscriptJobs(), TICK_MS).unref();
}
