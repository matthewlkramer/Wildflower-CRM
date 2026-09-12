import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  calendarEvents,
  meetingNotes,
  tasks,
  users,
} from "@workspace/db/schema";
import type { MeetingActionItem } from "@workspace/db/schema";
import { and, desc, count, eq, or, sql, type SQL } from "drizzle-orm";
import {
  ListMeetingNotesQueryParams,
  CreateMeetingNoteBodyRefined,
  UpdateMeetingNoteBody,
  PromoteMeetingActionItemBody,
  validateMeetingContactInvariants,
  MEETING_CONTACT_XOR_MESSAGE,
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
import { summarizeMeeting } from "../lib/summarizeMeeting";
import { generateMeetingNextSteps } from "../lib/generateMeetingNextSteps";
import { organizationActivityScalarScope } from "../lib/organizationActivityScope";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/meeting-notes",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListMeetingNotesQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.personId) filters.push(eq(meetingNotes.personId, q.personId));
    if (q.organizationId) {
      filters.push(
        parseBoolQuery(req, "includeLinkedPeople") === true
          ? organizationActivityScalarScope(
              q.organizationId,
              sql`${meetingNotes.organizationId}`,
              sql`${meetingNotes.personId}`,
            )
          : eq(meetingNotes.organizationId, q.organizationId),
      );
    }
    if (q.householdId)
      filters.push(eq(meetingNotes.householdId, q.householdId));
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
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
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
    res.json(row);
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
      const contactMatches =
        (!!body.personId && event.matchedPersonIds?.includes(body.personId)) ||
        (!!body.organizationId &&
          event.matchedOrganizationIds?.includes(body.organizationId)) ||
        (!!body.householdId &&
          event.matchedHouseholdIds?.includes(body.householdId));
      if (!contactMatches) {
        res.status(400).json({
          error: "validation_error",
          message: "Choose a contact that is linked to this calendar event.",
        });
        return;
      }
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
    const isTranscriptPath =
      typeof body.transcript === "string" && body.transcript.trim().length > 0;
    const ai = isTranscriptPath
      ? await summarizeMeeting(body.transcript!)
      : {
          summary: body.summary!.trim(),
          actionItems: [] as MeetingActionItem[],
        };

    const [row] = await db
      .insert(meetingNotes)
      .values({
        id: newId(),
        title: body.title ?? null,
        meetingDate: body.meetingDate ? new Date(body.meetingDate) : new Date(),
        attendees: body.attendees ?? null,
        // Privacy split mirrors the Gmail sync path: in summary_only
        // mode we drop the transcript here, BEFORE the insert, so the
        // raw bytes never reach postgres in the first place. The
        // hand-typed-notes path never has a transcript to begin with.
        rawTranscript:
          !isTranscriptPath || summaryOnly ? null : body.transcript!,
        summaryOnly,
        aiSummary: ai.summary,
        actionItems: ai.actionItems as unknown as MeetingActionItem[],
        creatorUserId: user.id,
        personId: body.personId ?? null,
        organizationId: body.organizationId ?? null,
        householdId: body.householdId ?? null,
        calendarEventId: body.calendarEventId ?? null,
      })
      .returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/meeting-notes/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateMeetingNoteBody, req.body, res);
    if (!body) return;
    const existing = await db
      .select()
      .from(meetingNotes)
      .where(eq(meetingNotes.id, paramId(req)))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "meeting note");
    // Merge-then-validate so a partial PATCH can't bypass the contact xor.
    const merged = {
      personId: body.personId !== undefined ? body.personId : existing.personId,
      organizationId:
        body.organizationId !== undefined
          ? body.organizationId
          : existing.organizationId,
      householdId:
        body.householdId !== undefined
          ? body.householdId
          : existing.householdId,
    };
    const issues = validateMeetingContactInvariants(merged);
    if (issues.length > 0) {
      res.status(400).json({
        error: "validation_error",
        message: MEETING_CONTACT_XOR_MESSAGE,
        details: { issues },
      });
      return;
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) patch.title = body.title;
    if (body.meetingDate !== undefined)
      patch.meetingDate = new Date(body.meetingDate);
    if (body.attendees !== undefined) patch.attendees = body.attendees;
    if (body.aiSummary !== undefined) patch.aiSummary = body.aiSummary;
    if (body.actionItems !== undefined) patch.actionItems = body.actionItems;
    if (body.personId !== undefined) patch.personId = body.personId;
    if (body.organizationId !== undefined)
      patch.organizationId = body.organizationId;
    if (body.householdId !== undefined) patch.householdId = body.householdId;
    const [row] = await db
      .update(meetingNotes)
      .set(patch)
      .where(eq(meetingNotes.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "meeting note");
    res.json(row);
  }),
);

router.delete(
  "/meeting-notes/:id",
  asyncHandler(async (req, res) => {
    await db.delete(meetingNotes).where(eq(meetingNotes.id, paramId(req)));
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
          personIds: existing.personId ? [existing.personId] : null,
          organizationIds: existing.organizationId
            ? [existing.organizationId]
            : null,
          householdIds: existing.householdId ? [existing.householdId] : null,
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
  "/meeting-notes/:id/generate-next-steps",
  asyncHandler(async (req, res) => {
    const note = await db
      .select()
      .from(meetingNotes)
      .where(eq(meetingNotes.id, paramId(req)))
      .then((rows) => rows[0]);
    if (!note) return notFound(res, "meeting note");
    const savedText = [
      note.title ? `Title: ${note.title}` : "",
      note.aiSummary ? `Summary:\n${note.aiSummary}` : "",
      (note.actionItems as MeetingActionItem[] | null)?.length
        ? `Existing action items:\n${(note.actionItems as MeetingActionItem[]).map((item) => `- ${item.title}`).join("\n")}`
        : "",
    ].filter(Boolean).join("\n\n");
    const proposals = await generateMeetingNextSteps(savedText);
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

export default router;
