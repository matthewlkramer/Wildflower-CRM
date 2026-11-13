import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  calendarEvents,
  developmentAgenda,
  meetingNotes,
  tasks,
  users,
} from "@workspace/db/schema";
import type {
  MeetingActionItem,
  MeetingArtifact,
  MeetingArtifactKind,
  MeetingNote,
} from "@workspace/db/schema";
import { and, desc, count, eq, or, sql, type SQL } from "drizzle-orm";
import {
  ListMeetingNotesQueryParams,
  CreateMeetingNoteBodyRefined,
  UpdateMeetingNoteBody,
  PromoteMeetingActionItemBody,
  RegenerateMeetingSummaryBody,
  ProcessMeetingMediaBody,
  validateMeetingLinkInvariants,
  MEETING_LINK_MESSAGE,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parseBoolQuery,
  parseOrBadRequest,
  parsePagination,
} from "../lib/helpers";
import { hasUsableMeetingSummary, mergeTranscriptActionItems, staffMeetingActionItems, summarizeMeeting } from "../lib/summarizeMeeting";
import { meetingRelationshipContext, savedMeetingSource } from "../lib/meetingAnalysis";
import { organizationActivityArrayScope } from "../lib/organizationActivityScope";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  draftMeetingFollowUp,
  cleanDictatedMeetingNotes,
  generateMeetingTaskProposals,
  ocrHandwrittenNotes,
  transcribeMeetingAudio,
} from "../lib/openaiMeeting";

const router: IRouter = Router();
router.use(requireAuth);
const objectStorage = new ObjectStorageService();

function meetingNoteResponse(row: MeetingNote) {
  // Legacy scalar columns are retained only to backfill old-app writes.
  const {
    personId: _personId,
    organizationId: _organizationId,
    householdId: _householdId,
    ...publicNote
  } = row;
  return publicNote;
}

async function validateMeetingArtifacts(artifacts: MeetingArtifact[]) {
  if (artifacts.length > 12)
    throw new Error("A meeting can have at most 12 source files.");
  for (const artifact of artifacts) {
    if (
      artifact.sourcePages?.length &&
      (artifact.kind !== "handwritten_notes" ||
        artifact.sourcePages[0].objectPath !== artifact.objectPath ||
        artifact.sourcePages.some(
          (page) => !page.mimeType.startsWith("image/"),
        ))
    ) {
      throw new Error(
        "Paper-note pages must be images and begin with the linked source file.",
      );
    }
    const pages = artifact.sourcePages?.length
      ? artifact.sourcePages
      : [{ objectPath: artifact.objectPath }];
    if (pages.length > 24)
      throw new Error("Paper notes can have at most 24 pages.");
    for (const page of pages) {
      if (!page.objectPath.startsWith("/objects/uploads/")) {
        throw new Error(
          "Meeting source files must use private object storage.",
        );
      }
      await objectStorage.getObjectEntityFile(page.objectPath);
    }
  }
}

function meetingArtifactSourceLabel(kind: MeetingArtifactKind): string {
  if (kind === "handwritten_notes") return "Handwritten notes";
  if (kind === "voice_dictation") return "Dictated voice notes";
  return "Recorded meeting";
}

router.get(
  "/meeting-notes",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListMeetingNotesQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.personId)
      filters.push(
        sql`${meetingNotes.personIds} @> ARRAY[${q.personId}]::text[]`,
      );
    if (q.organizationId) {
      filters.push(
        parseBoolQuery(req, "includeLinkedPeople") === true
          ? organizationActivityArrayScope(
              q.organizationId,
              sql`${meetingNotes.organizationIds}`,
              sql`${meetingNotes.personIds}`,
            )
          : sql`${meetingNotes.organizationIds} @> ARRAY[${q.organizationId}]::text[]`,
      );
    }
    if (q.householdId)
      filters.push(
        sql`${meetingNotes.householdIds} @> ARRAY[${q.householdId}]::text[]`,
      );
    if (q.creatorUserId)
      filters.push(eq(meetingNotes.creatorUserId, q.creatorUserId));
    if (q.calendarEventId)
      filters.push(eq(meetingNotes.calendarEventId, q.calendarEventId));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select()
        .from(meetingNotes)
        .where(where)
        .orderBy(desc(meetingNotes.meetingDate))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(meetingNotes).where(where),
    ]);
    res.json({
      data: rows.map(meetingNoteResponse),
      pagination: { page, limit, total: Number(total) },
    });
  }),
);

router.get(
  "/meeting-notes/:id",
  asyncHandler(async (req, res) => {
    const row = await db
      .select()
      .from(meetingNotes)
      .where(eq(meetingNotes.id, paramId(req)))
      .then((r) => r[0]);
    if (!row) return notFound(res, "meeting note");
    res.json(meetingNoteResponse(row));
  }),
);

router.post(
  "/meeting-notes",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateMeetingNoteBodyRefined, req.body, res);
    if (!body) return;
    const user = getAppUser(req);
    if (!user) return notFound(res, "user");

    if (body.calendarEventId) {
      const event = await db
        .select()
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.id, body.calendarEventId),
            or(
              eq(calendarEvents.isPrivate, false),
              eq(calendarEvents.calendarUserId, user.id),
            ),
          ),
        )
        .then((rows) => rows[0]);
      if (!event) {
        res.status(400).json({
          error: "validation_error",
          message: "The linked calendar event was not found or is private.",
        });
        return;
      }
      // Automatic attendee matching is a convenience, not a prerequisite.
      // Staff may explicitly associate phone, in-person, or first-time donor
      // meetings with any CRM contact from the meeting workspace.
      const existingNote = await db
        .select({ id: meetingNotes.id })
        .from(meetingNotes)
        .innerJoin(
          calendarEvents,
          eq(calendarEvents.id, meetingNotes.calendarEventId),
        )
        .where(
          event.gcalEventId.trim()
            ? sql`NULLIF(BTRIM(${calendarEvents.gcalEventId}), '') = ${event.gcalEventId.trim()}`
            : eq(calendarEvents.id, event.id),
        )
        .then((rows) => rows[0]);
      if (existingNote) {
        res.status(409).json({
          error: "conflict",
          message: "A note is already linked to this meeting.",
          details: { meetingNoteId: existingNote.id },
        });
        return;
      }
    }

    // Per-request privacy lookup: snapshot the creator's current
    // email_sync_mode and use that to decide whether to persist the
    // raw transcript. We use email_sync_mode as the project-wide
    // privacy switch (per Task #23) — if the creator has opted out of
    // storing email bodies, they've also opted out of storing meeting
    // transcripts.
    const owner = await db
      .select({ mode: users.emailSyncMode })
      .from(users)
      .where(eq(users.id, user.id))
      .then((r) => r[0]);
    const summaryOnly = owner?.mode === "summary_only";

    // Two intake paths: pasted transcript (run through AI to produce a
    // summary + action items) vs hand-typed notes (`summary`, stored
    // verbatim with no AI processing and no rawTranscript). Refined
    // body validation has already enforced that exactly one is set.
    const artifacts = (body.artifacts ?? []) as MeetingArtifact[];
    try {
      await validateMeetingArtifacts(artifacts);
    } catch (error) {
      res.status(400).json({
        error: "validation_error",
        message:
          error instanceof Error
            ? error.message
            : "Invalid meeting source file.",
      });
      return;
    }
    const transcriptParts = [
      body.transcript?.trim() || "",
      ...artifacts.map((artifact) =>
        artifact.transcript.trim()
          ? `${meetingArtifactSourceLabel(artifact.kind)} (${artifact.fileName}):\n${artifact.transcript.trim()}`
          : "",
      ),
    ].filter(Boolean);
    const isTranscriptPath = transcriptParts.length > 0;
    const summaryInput = [
      body.manualNotes?.trim()
        ? `Staff notes:\n${body.manualNotes.trim()}`
        : "",
      ...transcriptParts,
    ]
      .filter(Boolean)
      .join("\n\n");
    const meetingDate = body.meetingDate ? new Date(body.meetingDate) : new Date();
    const ai = isTranscriptPath
      ? await summarizeMeeting(summaryInput, {
          relationship: await meetingRelationshipContext(body, meetingDate),
        })
      : {
          summary: body.summary?.trim() || null,
          actionItems: [] as MeetingActionItem[],
        };

    const [row] = await db
      .insert(meetingNotes)
      .values({
        id: newId(),
        title: body.title ?? null,
        meetingDate,
        attendees: body.attendees ?? null,
        manualNotes: body.manualNotes?.trim() || null,
        // Privacy split mirrors the Gmail sync path: in summary_only
        // mode we drop the transcript here, BEFORE the insert, so the
        // raw bytes never reach postgres in the first place. The
        // hand-typed-notes path never has a transcript to begin with.
        rawTranscript:
          summaryOnly ? null : body.transcript?.trim() || null,
        summaryOnly,
        aiSummary: ai.summary,
        actionItems: ai.actionItems as unknown as MeetingActionItem[],
        artifacts: summaryOnly
          ? artifacts.map((artifact) => ({ ...artifact, transcript: "" }))
          : artifacts,
        creatorUserId: user.id,
        personIds: body.personIds ?? [],
        organizationIds: body.organizationIds ?? [],
        householdIds: body.householdIds ?? [],
        calendarEventId: body.calendarEventId ?? null,
      })
      .returning();
    res.status(201).json(meetingNoteResponse(row));
  }),
);

router.patch(
  "/meeting-notes/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateMeetingNoteBody, req.body, res);
    if (!body) return;
    const current = await db
      .select({ note: meetingNotes, version: sql<string>`${meetingNotes}."xmin"::text` })
      .from(meetingNotes)
      .where(eq(meetingNotes.id, paramId(req)))
      .then((r) => r[0]);
    if (!current) return notFound(res, "meeting note");
    const { note: existing, version } = current;
    // Merge-then-validate so a partial PATCH cannot remove the last anchor.
    const merged = {
      personIds: body.personIds ?? existing.personIds,
      organizationIds: body.organizationIds ?? existing.organizationIds,
      householdIds: body.householdIds ?? existing.householdIds,
      calendarEventId: existing.calendarEventId,
    };
    if (existing.developmentWeek && getAppUser(req)?.role === "read_only") {
      res.status(403).json({ error: "forbidden", message: "This CRM account has read-only access." });
      return;
    }
    if (existing.developmentWeek && (body.personIds || body.organizationIds || body.householdIds)) {
      res.status(409).json({ error: "conflict", message: "Manage linked donors from the development meeting agenda." });
      return;
    }
    const issues = existing.developmentWeek ? [] : validateMeetingLinkInvariants(merged);
    if (issues.length > 0) {
      res.status(400).json({
        error: "validation_error",
        message: MEETING_LINK_MESSAGE,
        details: { issues },
      });
      return;
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) patch.title = body.title;
    if (body.meetingDate !== undefined)
      patch.meetingDate = new Date(body.meetingDate);
    if (body.attendees !== undefined) patch.attendees = body.attendees;
    if (body.manualNotes !== undefined) patch.manualNotes = body.manualNotes;
    if (body.aiSummary !== undefined) patch.aiSummary = body.aiSummary;
    if (body.actionItems !== undefined) {
      const priorItems = (existing.actionItems ?? []) as MeetingActionItem[];
      patch.actionItems = body.actionItems?.map((item) => {
        const prior = priorItems.find((candidate) =>
          candidate.title === item.title &&
          (candidate.assigneeName ?? null) === (item.assigneeName ?? null) &&
          (candidate.dueDate ?? null) === (item.dueDate ?? null),
        );
        return !prior || prior.staffEdited ? { ...item, staffEdited: true } : item;
      }) ?? null;
    }
    const addedTranscript = body.transcript?.trim();
    const transcript = [
      existing.rawTranscript?.trim(),
      addedTranscript && !existing.rawTranscript?.includes(addedTranscript) ? addedTranscript : "",
    ].filter(Boolean).join("\n\n");
    const incomingArtifacts = (body.artifacts ?? existing.artifacts) as MeetingArtifact[];
    if (body.artifacts !== undefined) {
      try {
        await validateMeetingArtifacts(incomingArtifacts);
      } catch (error) {
        res.status(400).json({
          error: "validation_error",
          message:
            error instanceof Error
              ? error.message
              : "Invalid meeting source file.",
        });
        return;
      }
      patch.artifacts = existing.summaryOnly
        ? incomingArtifacts.map((artifact) => ({ ...artifact, transcript: "" }))
        : incomingArtifacts;
    }
    const sourceChanged = transcript !== (existing.rawTranscript?.trim() ?? "") ||
      incomingArtifacts.some((artifact) => artifact.transcript.trim() &&
        !existing.artifacts.some((prior) => prior.id === artifact.id && prior.transcript === artifact.transcript));
    const updatingSources = Boolean(addedTranscript || body.artifacts !== undefined);
    if (addedTranscript && !existing.summaryOnly) patch.rawTranscript = transcript;
    if (sourceChanged && body.aiSummary === undefined && body.actionItems === undefined) {
      const ai = await summarizeMeeting(savedMeetingSource({
        manualNotes: body.manualNotes === undefined ? existing.manualNotes : body.manualNotes,
        rawTranscript: transcript,
        artifacts: incomingArtifacts,
      }), {
        relationship: await meetingRelationshipContext(merged, body.meetingDate ? new Date(body.meetingDate) : existing.meetingDate, existing.id),
        priorSummary: existing.summaryOnly ? existing.aiSummary ?? undefined : undefined,
      });
      if (hasUsableMeetingSummary(ai)) {
        patch.aiSummary = ai.summary;
        const items = (existing.actionItems ?? []) as MeetingActionItem[];
        patch.actionItems = mergeTranscriptActionItems(
          existing.summaryOnly ? items : staffMeetingActionItems(items), ai,
        );
      } else if (existing.summaryOnly) {
        res.status(503).json({ error: "summary_unavailable", message: "The transcript could not be summarized. Try saving again." });
        return;
      }
    }
    if (body.personIds !== undefined) patch.personIds = body.personIds;
    if (body.organizationIds !== undefined)
      patch.organizationIds = body.organizationIds;
    if (body.householdIds !== undefined) patch.householdIds = body.householdIds;
    if (
      body.personIds !== undefined ||
      body.organizationIds !== undefined ||
      body.householdIds !== undefined
    ) {
      patch.personId = null;
      patch.organizationId = null;
      patch.householdId = null;
    }
    const [row] = await db
      .update(meetingNotes)
      .set(patch)
      .where(and(
        eq(meetingNotes.id, existing.id),
        updatingSources ? sql`${meetingNotes}."xmin"::text = ${version}` : undefined,
      ))
      .returning();
    if (!row) {
      if (!updatingSources) return notFound(res, "meeting note");
      res.status(409).json({ error: "conflict", message: "The meeting note changed. Reload it before saving." });
      return;
    }
    res.json(meetingNoteResponse(row));
  }),
);

router.delete(
  "/meeting-notes/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const [developmentNote] = await db.select({ id: meetingNotes.id }).from(meetingNotes)
      .where(and(eq(meetingNotes.id, id), sql`${meetingNotes.developmentWeek} IS NOT NULL`));
    if (developmentNote) {
      res.status(409).json({ error: "conflict", message: "Weekly development meetings retain their shared agenda history." });
      return;
    }
    await db.delete(meetingNotes).where(eq(meetingNotes.id, id));
    res.status(204).end();
  }),
);

/**
 * Promote a single action item to a task. Idempotent-ish: if the item
 * already has `promotedTaskId` we 400 — the UI hides the button after a
 * successful promote, but this keeps a stray double-click honest.
 */
router.post(
  "/meeting-notes/:id/promote-action-item",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(PromoteMeetingActionItemBody, req.body, res);
    if (!body) return;
    const user = getAppUser(req);
    if (!user) return notFound(res, "user");
    const id = paramId(req);
    // Wrap read-check-insert-stamp in a transaction with SELECT ... FOR
    // UPDATE on the meeting_notes row so two concurrent promote calls
    // for the same item can't both win and create duplicate tasks. The
    // second caller will block until the first commits, see the stamped
    // promotedTaskId, and return the existing task.
    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(meetingNotes)
        .where(eq(meetingNotes.id, id))
        .for("update")
        .then((r) => r[0]);
      if (!existing) return { kind: "not_found" as const };
      if (existing.developmentWeek) return { kind: "development_meeting" as const };
      const items = (existing.actionItems ?? []) as MeetingActionItem[];
      const item = items[body.index];
      if (!item) {
        return { kind: "bad_index" as const };
      }
      if (item.promotedTaskId) {
        // Idempotent: return the already-promoted task instead of 400.
        const prior = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.id, item.promotedTaskId))
          .then((r) => r[0]);
        if (prior) return { kind: "existing" as const, task: prior };
        // Stamp pointed at a missing task (manually deleted) — fall
        // through and create a fresh one so the user isn't stuck.
      }
      const taskId = newId();
      const dueDate = body.dueDate ?? item.dueDate ?? null;
      const descLines = [
        `From meeting note ${existing.id}.`,
        existing.title ? `Meeting: ${existing.title}` : null,
        item.assigneeName
          ? `Originally assigned to: ${item.assigneeName}`
          : null,
      ].filter(Boolean) as string[];
      const [task] = await tx
        .insert(tasks)
        .values({
          id: taskId,
          title: item.title,
          description: descLines.join("\n"),
          dueDate: dueDate,
          assigneeUserId: body.assigneeUserId ?? null,
          createdByUserId: user.id,
          personIds: existing.personIds.length ? existing.personIds : null,
          organizationIds: existing.organizationIds.length
            ? existing.organizationIds
            : null,
          householdIds: existing.householdIds.length
            ? existing.householdIds
            : null,
        })
        .returning();
      const updatedItems = items.map((it, i) =>
        i === body.index ? { ...it, promotedTaskId: taskId } : it,
      );
      await tx
        .update(meetingNotes)
        .set({ actionItems: updatedItems, updatedAt: new Date() })
        .where(eq(meetingNotes.id, existing.id));
      return { kind: "created" as const, task };
    });
    if (result.kind === "not_found") return notFound(res, "meeting note");
    if (result.kind === "development_meeting") {
      res.status(409).json({ error: "conflict", message: "Assign next steps from the weekly development agenda." });
      return;
    }
    if (result.kind === "bad_index") {
      res.status(400).json({
        error: "validation_error",
        message: "actionItems index out of range",
      });
      return;
    }
    if (result.kind === "existing") {
      res.status(200).json(result.task);
      return;
    }
    res.status(201).json(result.task);
  }),
);

router.post(
  "/meeting-notes/:id/regenerate-summary",
  asyncHandler(async (req, res) => {
    if (getAppUser(req)?.role === "read_only") {
      res.status(403).json({ error: "forbidden", message: "This CRM account has read-only access." });
      return;
    }
    const body = parseOrBadRequest(RegenerateMeetingSummaryBody, req.body, res);
    if (!body) return;
    const [current] = await db.select({
      note: meetingNotes,
      version: sql<string>`${meetingNotes}."xmin"::text`,
    }).from(meetingNotes).where(eq(meetingNotes.id, paramId(req)));
    if (!current) return notFound(res, "meeting note");
    const { note, version } = current;
    const source = savedMeetingSource(note);
    if (note.developmentWeek || !source) {
      res.status(409).json({ error: "conflict", message: "This meeting needs saved source notes or a transcript to regenerate its summary." });
      return;
    }
    const result = await summarizeMeeting(source, {
      relationship: await meetingRelationshipContext(note, note.meetingDate, note.id),
      reviewer: body.reviewerContext?.trim(),
    });
    if (!hasUsableMeetingSummary(result)) {
      res.status(503).json({ error: "summary_unavailable", message: "The summary could not be regenerated. Try again." });
      return;
    }
    const [updated] = await db.update(meetingNotes).set({
      aiSummary: result.summary,
      actionItems: mergeTranscriptActionItems(
        staffMeetingActionItems((note.actionItems ?? []) as MeetingActionItem[]),
        result,
      ),
      updatedAt: new Date(),
    }).where(and(eq(meetingNotes.id, note.id), sql`${meetingNotes}."xmin"::text = ${version}`)).returning();
    if (!updated) {
      res.status(409).json({ error: "conflict", message: "The meeting note changed during regeneration. Reload it and try again." });
      return;
    }
    res.json(meetingNoteResponse(updated));
  }),
);

router.post(
  "/meeting-notes/:id/generate-next-steps",
  asyncHandler(async (req, res) => {
    const note = await db
      .select()
      .from(meetingNotes)
      .where(eq(meetingNotes.id, paramId(req)))
      .then((rows) => rows[0]);
    if (!note) return notFound(res, "meeting note");
    const agenda = note.developmentWeek ? await db.select().from(developmentAgenda)
      .where(eq(developmentAgenda.meetingId, note.id)).orderBy(developmentAgenda.position) : [];
    const savedText = [
      ...agenda.filter((item) => item.notes.trim() || item.decision.trim())
        .map((item) => [item.title, item.notes, item.decision].filter(Boolean).join("\n")),
      savedMeetingSource(note),
    ]
      .filter(Boolean)
      .join("\n\n");
    let proposals;
    try {
      proposals = await generateMeetingTaskProposals(
        savedText,
        await meetingRelationshipContext(note, note.meetingDate, note.id),
      );
    } catch (error) {
      res.status(503).json({
        error: "task_generation_unavailable",
        message:
          error instanceof Error
            ? error.message
            : "Task suggestions are unavailable.",
      });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const user = getAppUser(req);
    res.json({
      proposals: proposals.map((proposal) => ({
        ...proposal,
        assigneeUserId: user?.id ?? null,
        assigneeName: user?.displayName ?? user?.email ?? null,
        assignmentDate: today,
      })),
    });
  }),
);

router.post(
  "/meeting-notes/:id/draft-follow-up",
  asyncHandler(async (req, res) => {
    const note = await db
      .select()
      .from(meetingNotes)
      .where(eq(meetingNotes.id, paramId(req)))
      .then((rows) => rows[0]);
    if (!note) return notFound(res, "meeting note");
    const artifacts = (note.artifacts ?? []) as MeetingArtifact[];
    const actionItems = (note.actionItems ?? []) as MeetingActionItem[];
    const savedContent = [
      note.manualNotes ? `Staff notes:\n${note.manualNotes}` : "",
      note.aiSummary ? `Summary:\n${note.aiSummary}` : "",
      note.rawTranscript ? `Transcript:\n${note.rawTranscript}` : "",
      ...artifacts.map((artifact) =>
        artifact.transcript
          ? `${meetingArtifactSourceLabel(artifact.kind)}:\n${artifact.transcript}`
          : "",
      ),
      actionItems.length
        ? `Next steps:\n${actionItems.map((item) => `- ${item.title}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      const draft = await draftMeetingFollowUp({
        meetingTitle: note.title?.trim() || "our meeting",
        meetingDate: note.meetingDate.toISOString().slice(0, 10),
        notes: savedContent,
      });
      const internalEmails = new Set(
        (await db.select({ email: users.email }).from(users))
          .map((row) => row.email?.trim().toLowerCase())
          .filter((email): email is string => Boolean(email)),
      );
      const recipients = Array.from(
        new Set(
          (note.attendees ?? [])
            .map((value) => value.trim().toLowerCase())
            .filter(
              (email) =>
                /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
                !internalEmails.has(email) &&
                !email.endsWith("@wildflowerschools.org"),
            ),
        ),
      );
      res.json({ recipients, ...draft });
    } catch (error) {
      res.status(503).json({
        error: "openai_unavailable",
        message:
          error instanceof Error ? error.message : "OpenAI is unavailable.",
      });
    }
  }),
);

router.post(
  "/meeting-media/process",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(ProcessMeetingMediaBody, req.body, res);
    if (!body) return;
    if (!body.objectPath.startsWith("/objects/uploads/")) {
      res.status(400).json({
        error: "validation_error",
        message: "Meeting source files must use private object storage.",
      });
      return;
    }
    try {
      const file = await objectStorage.getObjectEntityFile(body.objectPath);
      const rawTranscript =
        body.kind === "handwritten_notes"
          ? await ocrHandwrittenNotes({
              file,
              mimeType: body.mimeType,
              sizeBytes: body.sizeBytes,
            })
          : await transcribeMeetingAudio({
              file,
              fileName: body.fileName,
              mimeType: body.mimeType,
              sizeBytes: body.sizeBytes,
            });
      const transcript =
        body.kind === "voice_dictation"
          ? await cleanDictatedMeetingNotes(rawTranscript)
          : rawTranscript;
      const artifact: MeetingArtifact = {
        id: newId(),
        kind: body.kind,
        objectPath: body.objectPath,
        fileName: body.fileName,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
        transcript,
        createdAt: new Date().toISOString(),
      };
      res.json(artifact);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The source file could not be processed.";
      const status = message.startsWith("OpenAI") ? 503 : 400;
      res.status(status).json({
        error: status === 503 ? "openai_unavailable" : "validation_error",
        message,
      });
    }
  }),
);

export default router;
