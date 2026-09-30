import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, lt, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  conferenceAttendance,
  conferenceEvents,
  conferenceResearchRequests,
  conferenceSpeakerProposals,
  conferenceTypes,
} from "@workspace/db/schema";
import { logger } from "./logger";
import { newId } from "./helpers";
import {
  ConferenceResearchError,
  researchConferencePublicWeb,
  type ConferenceResearchKind,
  type ConferenceResearchResult,
} from "./conferencePublicWebResearch";
import { findConferenceSpeakerMatch } from "./conferenceSpeakerMatching";

const WORK_INTERVAL_MS = 5 * 60 * 1000;
const LEASE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function makeConferenceResearchPrompt(
  name: string,
  year: number,
  kind: ConferenceResearchKind,
  officialUrl: string | null,
  instructions: string | null,
): string {
  const focus = kind === "dates"
    ? "Find the official start date and optional end date for this edition."
    : "Find its publicly available official agenda, sessions, and speaker roster.";
  return [
    focus,
    `Conference: ${name}`,
    `Edition year: ${year}`,
    officialUrl ? `Known official page: ${officialUrl}` : "",
    instructions?.trim() ?? "",
    "Use public web pages only. Return cited facts for human review; never access private attendee data.",
  ].filter(Boolean).join("\n");
}

export async function enqueueConferenceResearch(
  eventId: string,
  kind: ConferenceResearchKind,
  windowKey: string,
  createdByUserId?: string | null,
  options: { attendeeSiteUrl?: string | null; instructions?: string | null } = {},
): Promise<typeof conferenceResearchRequests.$inferSelect> {
  const [joined] = await db
    .select({ event: conferenceEvents, typeName: conferenceTypes.displayName, officialUrl: conferenceTypes.websiteUrl })
    .from(conferenceEvents)
    .innerJoin(conferenceTypes, eq(conferenceTypes.id, conferenceEvents.conferenceTypeId))
    .where(eq(conferenceEvents.id, eventId));
  if (!joined) throw new Error("Conference event was not found.");
  const officialUrl = options.attendeeSiteUrl ?? joined.event.attendeeSiteUrl ?? joined.officialUrl;
  const prompt = makeConferenceResearchPrompt(
    joined.event.nameOverride?.trim() || `${joined.typeName} ${joined.event.year}`,
    joined.event.year,
    kind,
    officialUrl,
    options.instructions ?? null,
  );
  const id = newId();
  await db.insert(conferenceResearchRequests).values({
    id,
    conferenceEventId: eventId,
    attendeeSiteUrl: officialUrl,
    instructions: options.instructions ?? null,
    prompt,
    status: "queued",
    kind,
    windowKey,
    attempts: 0,
    nextAttemptAt: new Date(),
    createdByUserId: createdByUserId ?? null,
  }).onConflictDoNothing({
    target: [
      conferenceResearchRequests.conferenceEventId,
      conferenceResearchRequests.kind,
      conferenceResearchRequests.windowKey,
    ],
  });
  const [request] = await db.select().from(conferenceResearchRequests).where(and(
    eq(conferenceResearchRequests.conferenceEventId, eventId),
    eq(conferenceResearchRequests.kind, kind),
    eq(conferenceResearchRequests.windowKey, windowKey),
  ));
  if (!request) throw new Error("Conference research request could not be queued.");
  return request;
}

export interface DueResearchWindow {
  kind: ConferenceResearchKind;
  windowKey: string;
}

type ResearchRequest = typeof conferenceResearchRequests.$inferSelect;
type ResearchEvent = typeof conferenceEvents.$inferSelect;

export interface ResearchLease {
  id: string;
  attempts: number;
  startedAt: Date | null;
}

export function isResearchLeaseOwner(
  current: Pick<ResearchRequest, "status" | "attempts" | "startedAt"> | null | undefined,
  lease: ResearchLease,
): boolean {
  return !!current &&
    current.status === "running" &&
    current.attempts === lease.attempts &&
    current.startedAt?.getTime() === lease.startedAt?.getTime();
}

function leaseWhere(lease: ResearchLease) {
  return and(
    eq(conferenceResearchRequests.id, lease.id),
    eq(conferenceResearchRequests.status, "running"),
    eq(conferenceResearchRequests.attempts, lease.attempts),
    lease.startedAt
      ? eq(conferenceResearchRequests.startedAt, lease.startedAt)
      : isNull(conferenceResearchRequests.startedAt),
  );
}

export function scheduledWindowStartDate(windowKey: string): string | null {
  const match = /^(?:before_(?:21|2)_days|dates_confirmed):(\d{4}-\d{2}-\d{2})$/.exec(windowKey);
  return match?.[1] ?? null;
}

export function isScheduledWindowCurrent(
  kind: ConferenceResearchKind,
  windowKey: string | null,
  startDate: string | null,
): boolean {
  const windowDate = windowKey ? scheduledWindowStartDate(windowKey) : null;
  return !windowDate || kind !== "agenda_speakers" || windowDate === startDate;
}

export function researchPromptMatchesCurrentContext(
  request: Pick<ResearchRequest, "prompt" | "kind" | "attendeeSiteUrl" | "instructions">,
  event: Pick<ResearchEvent, "nameOverride" | "year">,
  typeName: string,
): boolean {
  return request.prompt === makeConferenceResearchPrompt(
    event.nameOverride?.trim() || `${typeName} ${event.year}`,
    event.year,
    request.kind as ConferenceResearchKind,
    request.attendeeSiteUrl,
    request.instructions,
  );
}

function staleContextMessage(request: ResearchRequest, event: ResearchEvent, typeName: string): string | null {
  if (!isScheduledWindowCurrent(request.kind as ConferenceResearchKind, request.windowKey, event.startDate)) {
    return `Scheduled agenda window ${request.windowKey} is obsolete because the event start date changed.`;
  }
  if (!researchPromptMatchesCurrentContext(request, event, typeName)) {
    return "Conference name, type, or year changed after this research prompt was queued.";
  }
  if (request.kind === "agenda_speakers" && !event.startDate) {
    return "Agenda research requires confirmed event dates.";
  }
  return null;
}

/** Pure window calculation; dates are compared as UTC calendar dates. */
export function getDueConferenceResearchWindows(
  event: { startDate: string | null; endDate?: string | null },
  today = new Date().toISOString().slice(0, 10),
): DueResearchWindow[] {
  if (!event.startDate) return [{ kind: "dates", windowKey: "dates_missing" }];
  const start = Date.parse(`${event.startDate}T00:00:00Z`);
  const current = Date.parse(`${today}T00:00:00Z`);
  const daysUntil = Math.floor((start - current) / 86_400_000);
  const due: DueResearchWindow[] = [];
  // Historical coverage is an explicit backfill, not a perpetual scheduled sweep.
  if (daysUntil < 0) return due;
  if (daysUntil <= 21) {
    due.push({ kind: "agenda_speakers", windowKey: `before_21_days:${event.startDate}` });
  }
  if (daysUntil <= 2) {
    due.push({ kind: "agenda_speakers", windowKey: `before_2_days:${event.startDate}` });
  }
  return due;
}

export async function enqueueScheduledResearch(now = new Date()): Promise<{
  eventsScanned: number; windowsDue: number; enqueueFailures: number;
}> {
  const events = await db.select({
    id: conferenceEvents.id,
    startDate: conferenceEvents.startDate,
    endDate: conferenceEvents.endDate,
  }).from(conferenceEvents);
  const today = now.toISOString().slice(0, 10);
  const summary = { eventsScanned: events.length, windowsDue: 0, enqueueFailures: 0 };
  for (const event of events) {
    for (const due of getDueConferenceResearchWindows(event, today)) {
      summary.windowsDue += 1;
      try {
        await enqueueConferenceResearch(event.id, due.kind, due.windowKey);
      } catch {
        summary.enqueueFailures += 1;
        logger.warn({ kind: due.kind }, "Could not enqueue scheduled conference research");
      }
    }
  }
  return summary;
}

function confidenceBand(confidence: number): "high" | "medium" | "low" {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

function speakerFingerprint(result: Extract<ConferenceResearchResult, { kind: "agenda_speakers" }>): string {
  return createHash("sha256").update([
    result.name?.trim().toLocaleLowerCase("en") ?? "",
    result.organization?.trim().toLocaleLowerCase("en") ?? "",
    result.profileUrl ?? "",
  ].join("|")).digest("hex");
}

async function saveCompletedResult(
  lease: ResearchLease,
  kind: ConferenceResearchKind,
  results: ConferenceResearchResult[],
  citations: { url: string; title: string | null; accessedAt: string }[],
): Promise<boolean> {
  const sources = citations.map((citation) => ({
    url: citation.url,
    title: citation.title,
    publisher: null,
    fetchedAt: citation.accessedAt,
  }));
  const evidence = results.map((result) => ({
    kind: result.kind,
    sourceUrl: result.sourceUrl,
    evidence: result.evidence,
    confidence: result.confidence,
    citations: result.citations,
    ...(result.kind === "dates"
      ? { startDate: result.startDate, endDate: result.endDate }
      : { name: result.name, organization: result.organization, session: result.session }),
  }));

  let saved = false;
  await db.transaction(async (tx) => {
    const [currentRequest] = await tx.select().from(conferenceResearchRequests)
      .where(eq(conferenceResearchRequests.id, lease.id))
      .for("update");
    if (!currentRequest || !isResearchLeaseOwner(currentRequest, lease)) return;
    const [joined] = await tx.select({
      event: conferenceEvents,
      typeName: conferenceTypes.displayName,
    }).from(conferenceEvents)
      .innerJoin(conferenceTypes, eq(conferenceTypes.id, conferenceEvents.conferenceTypeId))
      .where(eq(conferenceEvents.id, currentRequest.conferenceEventId))
      .for("update");
    const contextError = joined
      ? staleContextMessage(currentRequest, joined.event, joined.typeName)
      : "Conference event or type no longer exists.";
    if (contextError) {
      await tx.update(conferenceResearchRequests).set({
        status: "failed",
        error: contextError,
        nextAttemptAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(leaseWhere(lease));
      return;
    }
    // Mark completion while holding the lease row lock. All subsequent CRM
    // writes are in this transaction and roll back together if anything fails.
    const dateResult = kind === "dates"
      ? results.find((result): result is Extract<ConferenceResearchResult, { kind: "dates" }> => result.kind === "dates")
      : undefined;
    const [completed] = await tx.update(conferenceResearchRequests).set({
      status: "completed",
      completedAt: new Date(),
      nextAttemptAt: null,
      error: null,
      sources,
      evidence,
      proposedStartDate: dateResult?.startDate ?? null,
      proposedEndDate: dateResult?.endDate ?? null,
      proposedDateConfidence: dateResult ? confidenceBand(dateResult.confidence) : null,
      updatedAt: new Date(),
    }).where(leaseWhere(lease)).returning({ id: conferenceResearchRequests.id });
    if (!completed) return;
    saved = true;

    if (kind !== "agenda_speakers") return;
    for (const item of results) {
      if (item.kind !== "agenda_speakers" || !item.name) continue;
      const match = await findConferenceSpeakerMatch({
        name: item.name,
        email: item.email,
        organizationName: item.organization,
      });
       // Exact email is sufficient only when it was literally grounded in a
       // fetched public page. Native search annotations alone cannot prove it.
       // A unique name corroborated by current organization is also sufficient.
       const corroboratedIdentity = match.matchedPersonId
         ? await findConferenceSpeakerMatch({
             name: item.name,
             organizationName: item.organization,
           })
         : null;
       if (match.matchedPersonId && item.confidence >= 0.8 &&
         (corroboratedIdentity?.matchedPersonId === match.matchedPersonId ||
           (item.verifiedPublicEmail === true && match.evidence === "Unique exact email match to an existing CRM person."))) {
        await tx.insert(conferenceAttendance).values({
          id: newId(),
          conferenceEventId: currentRequest.conferenceEventId,
          personId: match.matchedPersonId,
          status: "confirmed",
          role: "Speaker",
          sourceType: "agenda_speaker",
          sourceReference: item.sourceUrl,
          evidenceNote: `${item.evidence}${item.citations.length ? ` Sources: ${item.citations.map((c) => c.url).join(", ")}` : ""}`,
          organizationSnapshot: item.organization,
        }).onConflictDoUpdate({
          target: [conferenceAttendance.conferenceEventId, conferenceAttendance.personId],
          set: {
            status: "confirmed",
            role: "Speaker",
            evidenceNote: sql`concat_ws(E'\n\n', nullif(${conferenceAttendance.evidenceNote}, ''), ${`${item.evidence}${item.citations.length ? ` Sources: ${item.citations.map((c) => c.url).join(", ")}` : ""}`})`,
            organizationSnapshot: sql`coalesce(${conferenceAttendance.organizationSnapshot}, ${item.organization})`,
            updatedAt: new Date(),
          },
        });
        continue;
      }
      await tx.insert(conferenceSpeakerProposals).values({
        id: newId(),
        conferenceEventId: currentRequest.conferenceEventId,
        conferenceResearchRequestId: lease.id,
        speakerFingerprint: speakerFingerprint(item),
        name: item.name,
        title: item.title,
        organizationName: item.organization,
        bio: item.bio,
        profileUrl: item.profileUrl,
        sourceUrl: item.sourceUrl,
        sessionEvidence: item.session ? `${item.session}\n\n${item.evidence}` : item.evidence,
        confidence: confidenceBand(item.confidence),
        candidatePersonIds: match.candidates.map((candidate) => candidate.personId),
        matchedPersonId: null,
        matchedOrganizationId: null,
      }).onConflictDoUpdate({
        target: [conferenceSpeakerProposals.conferenceEventId, conferenceSpeakerProposals.speakerFingerprint],
        set: {
          conferenceResearchRequestId: lease.id,
          candidatePersonIds: match.candidates.map((candidate) => candidate.personId),
          updatedAt: new Date(),
        },
      });
    }
  });
  return saved;
}

/** The existing lease recovery rules; callers run this once before claiming jobs. */
export async function recoverExpiredConferenceResearchLeases(): Promise<{ requeued: number; exhausted: number }> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LEASE_TIMEOUT_MS);
  const summary = { requeued: 0, exhausted: 0 };
  await db.transaction(async (tx) => {
    const staleRequests = await tx.select().from(conferenceResearchRequests).where(and(
      eq(conferenceResearchRequests.status, "running"),
      lt(conferenceResearchRequests.startedAt, staleBefore),
    )).for("update", { skipLocked: true });
    for (const request of staleRequests) {
      const exhausted = request.attempts >= MAX_ATTEMPTS;
      const [changed] = await tx.update(conferenceResearchRequests).set({
        status: exhausted ? "failed" : "queued",
        nextAttemptAt: exhausted ? null : now,
        error: exhausted
          ? "Worker lease expired after the maximum number of research attempts."
          : "Previous worker lease expired; request safely re-queued.",
        completedAt: exhausted ? now : null,
        startedAt: null,
        updatedAt: now,
      }).where(and(
        eq(conferenceResearchRequests.id, request.id),
        eq(conferenceResearchRequests.status, "running"),
        eq(conferenceResearchRequests.attempts, request.attempts),
        request.startedAt
          ? eq(conferenceResearchRequests.startedAt, request.startedAt)
          : isNull(conferenceResearchRequests.startedAt),
      )).returning({ id: conferenceResearchRequests.id });
      if (changed) summary[exhausted ? "exhausted" : "requeued"] += 1;
    }
  });
  return summary;
}

async function claimNextRequest(): Promise<typeof conferenceResearchRequests.$inferSelect | null> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [request] = await tx.select().from(conferenceResearchRequests)
      .where(and(
        eq(conferenceResearchRequests.status, "queued"),
        or(isNull(conferenceResearchRequests.nextAttemptAt), lte(conferenceResearchRequests.nextAttemptAt, now)),
      ))
      .orderBy(asc(conferenceResearchRequests.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!request) return null;
    const [claimed] = await tx.update(conferenceResearchRequests).set({
      status: "running",
      startedAt: now,
      attempts: request.attempts + 1,
      error: null,
      updatedAt: now,
    }).where(eq(conferenceResearchRequests.id, request.id)).returning();
    return claimed ?? null;
  });
}

export async function invalidateStaleActiveRequests(): Promise<number> {
  let invalidated = 0;
  const active = await db.select({ id: conferenceResearchRequests.id })
    .from(conferenceResearchRequests)
    .where(inArray(conferenceResearchRequests.status, ["queued", "running"]));
  for (const { id } of active) {
    await db.transaction(async (tx) => {
      const [request] = await tx.select().from(conferenceResearchRequests)
        .where(eq(conferenceResearchRequests.id, id))
        .for("update");
      if (!request || (request.status !== "queued" && request.status !== "running")) return;
      const [joined] = await tx.select({
        event: conferenceEvents,
        typeName: conferenceTypes.displayName,
      }).from(conferenceEvents)
        .innerJoin(conferenceTypes, eq(conferenceTypes.id, conferenceEvents.conferenceTypeId))
        .where(eq(conferenceEvents.id, request.conferenceEventId))
        .for("update");
      const error = joined
        ? staleContextMessage(request, joined.event, joined.typeName)
        : "Conference event or type no longer exists.";
      if (!error) return;
      const [changed] = await tx.update(conferenceResearchRequests).set({
        status: "failed",
        error,
        nextAttemptAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(conferenceResearchRequests.id, request.id),
        eq(conferenceResearchRequests.status, request.status),
        eq(conferenceResearchRequests.attempts, request.attempts),
        request.startedAt
          ? eq(conferenceResearchRequests.startedAt, request.startedAt)
          : isNull(conferenceResearchRequests.startedAt),
      )).returning({ id: conferenceResearchRequests.id });
      if (changed) invalidated += 1;
    });
  }
  return invalidated;
}

async function verifyLeaseContext(lease: ResearchLease): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [request] = await tx.select().from(conferenceResearchRequests)
      .where(eq(conferenceResearchRequests.id, lease.id))
      .for("update");
    if (!request || !isResearchLeaseOwner(request, lease)) return false;
    const [joined] = await tx.select({
      event: conferenceEvents,
      typeName: conferenceTypes.displayName,
    }).from(conferenceEvents)
      .innerJoin(conferenceTypes, eq(conferenceTypes.id, conferenceEvents.conferenceTypeId))
      .where(eq(conferenceEvents.id, request.conferenceEventId))
      .for("update");
    const error = joined
      ? staleContextMessage(request, joined.event, joined.typeName)
      : "Conference event or type no longer exists.";
    if (!error) return true;
    await tx.update(conferenceResearchRequests).set({
      status: "failed",
      error,
      nextAttemptAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(leaseWhere(lease));
    return false;
  });
}

async function processRequest(request: typeof conferenceResearchRequests.$inferSelect): Promise<void> {
  const lease: ResearchLease = {
    id: request.id,
    attempts: request.attempts,
    startedAt: request.startedAt,
  };
  if (!(await verifyLeaseContext(lease))) return;
  const [joined] = await db.select({
    event: conferenceEvents,
    typeName: conferenceTypes.displayName,
  }).from(conferenceEvents)
    .innerJoin(conferenceTypes, eq(conferenceTypes.id, conferenceEvents.conferenceTypeId))
    .where(eq(conferenceEvents.id, request.conferenceEventId));
  if (!joined) return;
  const result = await researchConferencePublicWeb({
    conferenceName: joined.event.nameOverride?.trim() || joined.typeName,
    year: joined.event.year,
    kind: request.kind as ConferenceResearchKind,
    officialUrl: request.attendeeSiteUrl,
  });
  await saveCompletedResult(
    lease,
    result.kind,
    result.results,
    result.citations,
  );
}

export function isCredentialUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "provider_not_configured") return true;
  return "message" in error &&
    typeof error.message === "string" &&
    /HTTP (?:401|403)\b/.test(error.message);
}

export function getResearchRetryDelayMs(attempts: number, credentialsUnavailable = false): number {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  if (credentialsUnavailable) {
    return Math.min(24 * 60 * 60_000, 15 * 60_000 * 2 ** Math.min(safeAttempts - 1, 10));
  }
  return Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(safeAttempts, 18));
}

export type ResearchJobOutcome = "completed" | "retry" | "failed" | "skipped";

export async function runOneResearchJob(): Promise<ResearchJobOutcome | null> {
  const request = await claimNextRequest();
  if (!request) return null;
  try {
    await processRequest(request);
    const [current] = await db.select({ status: conferenceResearchRequests.status })
      .from(conferenceResearchRequests).where(eq(conferenceResearchRequests.id, request.id));
    return current?.status === "completed" ? "completed" :
      current?.status === "failed" ? "failed" : "skipped";
  } catch (error) {
    const attempts = request.attempts;
     const credentialUnavailable = isCredentialUnavailable(error);
     const unsupportedPublicPdf = error instanceof ConferenceResearchError &&
       error.code === "unsupported_public_pdf";
     const delayedRetry = credentialUnavailable || unsupportedPublicPdf;
     const retryable = delayedRetry ||
      !(error && typeof error === "object" && "retryable" in error && error.retryable === false);
     const exhausted = !retryable || (!delayedRetry && attempts >= MAX_ATTEMPTS);
     const retryDelay = getResearchRetryDelayMs(attempts, delayedRetry);
    const message = error instanceof Error ? error.message : "Conference research failed.";
     const [changed] = await db.update(conferenceResearchRequests).set({
      status: exhausted ? "failed" : "queued",
      error: message,
      nextAttemptAt: exhausted ? null : new Date(Date.now() + retryDelay),
      completedAt: exhausted ? new Date() : null,
      updatedAt: new Date(),
      startedAt: null,
    }).where(leaseWhere({
      id: request.id,
      attempts: request.attempts,
      startedAt: request.startedAt,
     })).returning({ id: conferenceResearchRequests.id });
     if (!changed) return "skipped";
     // Error messages can contain public page text or provider details. Keep job
     // diagnostics in the request row; scheduled-deployment logs contain counts only.
     logger.warn({ attempts, retryable, category: unsupportedPublicPdf ? "unsupported_pdf" :
       credentialUnavailable ? "provider_unavailable" : "research_error" }, "Conference research job failed");
     return exhausted ? "failed" : "retry";
  }
}

let workerRunning = false;
let schedulerStarted = false;

export async function runConferenceResearchWorkerTick(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    await invalidateStaleActiveRequests();
    await recoverExpiredConferenceResearchLeases();
    await enqueueScheduledResearch();
    // Bound each tick so the scheduler remains responsive.
    for (let i = 0; i < 5; i += 1) {
      if ((await runOneResearchJob()) === null) break;
    }
  } catch (error) {
    logger.error({ error }, "Conference research worker tick failed");
  } finally {
    workerRunning = false;
  }
}

export function startConferenceResearchScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  void runConferenceResearchWorkerTick();
  setInterval(() => void runConferenceResearchWorkerTick(), WORK_INTERVAL_MS);
}

/** Production runs bounded research through the external n8n integration or CLI. */
export function shouldStartConferenceResearchScheduler(nodeEnv = process.env.NODE_ENV): boolean {
  return nodeEnv !== "production";
}

/** Read-only preflight: never enqueue against a partially published schema. */
export async function assertConferenceResearchSchemaReady(): Promise<void> {
  const result = await db.execute(sql`
    SELECT
      to_regclass('public.conference_speaker_proposals') IS NOT NULL
      AND (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'conference_events'
          AND column_name IN ('date_source_url', 'date_evidence', 'date_confidence',
            'date_researched_at', 'date_reviewed_by_user_id', 'date_reviewed_at')) = 6
      AND (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'conference_attendance'
          AND column_name = 'role') = 1
      AND (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'conference_research_requests'
          AND column_name IN ('kind', 'window_key', 'attempts', 'next_attempt_at',
            'started_at', 'completed_at', 'error', 'sources', 'evidence',
            'proposed_start_date', 'proposed_end_date', 'proposed_date_confidence')) = 12
      AND (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'
        AND indexname IN ('conference_research_requests_status_next_attempt_idx',
          'conference_research_requests_event_kind_window_uq',
          'conference_speaker_proposals_event_fingerprint_uq',
          'conference_speaker_proposals_event_status_idx',
          'conference_speaker_proposals_run_idx')) = 5
      AND (SELECT count(*) FROM pg_constraint
        WHERE conname IN ('conference_research_requests_kind_ck',
          'conference_research_requests_attempts_ck',
          'conference_speaker_proposals_status_ck',
          'conference_speaker_proposals_confidence_ck')) = 4
      AND EXISTS (SELECT 1 FROM pg_constraint
        WHERE conname = 'conference_attendance_source_type_ck'
          AND pg_get_constraintdef(oid) LIKE '%agenda_speaker%') AS ready
  `);
  requireConferenceResearchSchema(result.rows[0]?.ready);
}

export class ConferenceResearchSchemaNotReadyError extends Error {
  constructor() {
    super("Conference research schema is not ready: publish migration 0267 before running the scheduled job.");
    this.name = "ConferenceResearchSchemaNotReadyError";
  }
}

export function requireConferenceResearchSchema(ready: unknown): void {
  if (ready !== true) throw new ConferenceResearchSchemaNotReadyError();
}

export async function enqueueConferenceResearchBackfill(args: {
  eventIds?: string[];
  includeKnownDates?: boolean;
  includeCompletedEvents?: boolean;
}): Promise<{ selectedEventCount: number; dateRunsQueued: number; agendaRunsQueued: number; requestIds: string[] }> {
  const filters = [];
  if (args.eventIds?.length) filters.push(inArray(conferenceEvents.id, args.eventIds));
   if (args.includeCompletedEvents === false) filters.push(sql`${conferenceEvents.status} <> 'completed'`);
  const events = await db.select({
    id: conferenceEvents.id,
    startDate: conferenceEvents.startDate,
  }).from(conferenceEvents).where(filters.length ? and(...filters) : undefined);
  const result = { selectedEventCount: events.length, dateRunsQueued: 0, agendaRunsQueued: 0, requestIds: [] as string[] };
  for (const event of events) {
    if (!event.startDate || args.includeKnownDates) {
      const request = await enqueueConferenceResearch(event.id, "dates", "retroactive");
      result.dateRunsQueued += 1;
      result.requestIds.push(request.id);
    }
    if (event.startDate) {
      const request = await enqueueConferenceResearch(event.id, "agenda_speakers", "retroactive");
      result.agendaRunsQueued += 1;
      result.requestIds.push(request.id);
    }
  }
  return result;
}

export async function retryConferenceResearchRequest(id: string): Promise<typeof conferenceResearchRequests.$inferSelect | null> {
  return db.transaction(async (tx) => {
    const [request] = await tx.select().from(conferenceResearchRequests)
      .where(eq(conferenceResearchRequests.id, id)).for("update");
    if (!request || request.status !== "failed") return null;
    const [queued] = await tx.update(conferenceResearchRequests).set({
      status: "queued",
      attempts: 0,
      error: null,
      nextAttemptAt: new Date(),
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
    }).where(eq(conferenceResearchRequests.id, id)).returning();
    return queued ?? null;
  });
}
