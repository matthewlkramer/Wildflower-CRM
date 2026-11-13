import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  developmentAgenda,
  developmentAgendaTasks,
  funderScanState,
  fundraisingFindingReviews,
  households,
  meetingNotes,
  organizations,
  people,
  tasks,
  users,
  type MeetingActionItem,
} from "@workspace/db/schema";
import {
  AddDevelopmentAgendaItemBody,
  AssignDevelopmentActionBody,
  CreateDevelopmentMeetingBody,
  ListDevelopmentMeetingsQueryParams,
  ReviewFundraisingFindingBody,
  SummarizeDevelopmentTranscriptBody,
  UpdateDevelopmentAgendaItemBody,
} from "@workspace/api-zod";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parseBoolQuery,
  parseOrBadRequest,
} from "../lib/helpers";
import {
  loadFundraisingBrief,
  resolveFundraisingFinding,
} from "../lib/fundraisingBrief";
import {
  createDevelopmentMeeting,
  loadDevelopmentDonorSuggestions,
  loadDevelopmentMeetings,
  lockDevelopmentMeeting,
  refreshDevelopmentDonorLinks,
} from "../lib/developmentMeetings";
import { hasUsableMeetingSummary, mergeTranscriptActionItems, summarizeMeeting } from "../lib/summarizeMeeting";
import { meetingRelationshipContext, savedMeetingSource } from "../lib/meetingAnalysis";

const router: IRouter = Router();
router.use(requireAuth);
router.use(["/fundraising", "/development-meetings"], (req, res, next) => {
  const user = getAppUser(req);
  if (!user) return notFound(res, "user");
  if (
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    user.role === "read_only"
  ) {
    res
      .status(403)
      .json({
        error: "forbidden",
        message: "This CRM account has read-only access.",
      });
    return;
  }
  next();
});

function invalid(res: Response, message: string) {
  res.status(400).json({ error: "validation_error", message });
}
function conflict(res: Response, message: string) {
  res.status(409).json({ error: "conflict", message });
}
function itemId(req: Request) {
  return String(req.params.itemId);
}
async function respondMeeting(res: Response, id: string) {
  const [meeting] = await loadDevelopmentMeetings({ id });
  if (!meeting) return notFound(res, "development meeting");
  res.json(meeting);
}

router.get(
  "/fundraising/brief",
  asyncHandler(async (req, res) => {
    res.json(await loadFundraisingBrief(parseBoolQuery(req, "all") === true));
  }),
);

router.put(
  "/fundraising/findings/:id/review",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(ReviewFundraisingFindingBody, req.body, res);
    if (!body) return;
    const findingId = paramId(req);
    if (!(await resolveFundraisingFinding(body.kind, findingId)))
      return notFound(res, "fundraising finding");
    if (body.review === "unreviewed") {
      await db
        .delete(fundraisingFindingReviews)
        .where(
          and(
            eq(fundraisingFindingReviews.kind, body.kind),
            eq(fundraisingFindingReviews.findingId, findingId),
          ),
        );
    } else {
      const values = {
        review: body.review,
        reviewedByUserId: getAppUser(req)!.id,
      };
      await db
        .insert(fundraisingFindingReviews)
        .values({ kind: body.kind, findingId, ...values })
        .onConflictDoUpdate({
          target: [
            fundraisingFindingReviews.kind,
            fundraisingFindingReviews.findingId,
          ],
          set: values,
        });
    }
    res.status(204).end();
  }),
);

router.post(
  "/fundraising/funders/:id/request-scan",
  asyncHandler(async (req, res) => {
    if (
      process.env.DISABLE_SYNC_SCHEDULER === "1" ||
      process.env.DISABLE_MEDIA_INGEST === "1" ||
      process.env.DISABLE_FUNDER_SCAN === "1"
    ) {
      res
        .status(503)
        .json({
          error: "scan_disabled",
          message: "Public funder checks are currently paused.",
        });
      return;
    }
    const id = paramId(req);
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, id),
          isNull(organizations.archivedAt),
          eq(organizations.anonymous, false),
          sql`${organizations.activeStatus} IS DISTINCT FROM 'defunct'`,
        ),
      );
    if (!org) return notFound(res, "funder");
    const requestedAt = new Date();
    await db
      .insert(funderScanState)
      .values({ organizationId: id, status: "pending", requestedAt })
      .onConflictDoUpdate({
        target: funderScanState.organizationId,
        set: {
          requestedAt: sql`COALESCE(${funderScanState.requestedAt}, ${requestedAt.toISOString()}::timestamptz)`,
        },
      });
    res.status(204).end();
  }),
);

router.get(
  "/development-meetings",
  asyncHandler(async (req, res) => {
    const query = parseOrBadRequest(
      ListDevelopmentMeetingsQueryParams,
      req.query,
      res,
    );
    if (!query) return;
    res.json(await loadDevelopmentMeetings(query));
  }),
);

router.post(
  "/development-meetings",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateDevelopmentMeetingBody, req.body, res);
    if (!body) return;
    const user = getAppUser(req)!;
    const id = await createDevelopmentMeeting(
      body.date,
      user.id,
      user.emailSyncMode === "summary_only",
    );
    await respondMeeting(res, id);
  }),
);

router.get(
  "/development-meetings/suggested-donors",
  asyncHandler(async (_req, res) => {
    res.json(await loadDevelopmentDonorSuggestions());
  }),
);

router.get(
  "/development-meetings/:id",
  asyncHandler(async (req, res) => {
    await respondMeeting(res, paramId(req));
  }),
);

router.post(
  "/development-meetings/:id/agenda",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(AddDevelopmentAgendaItemBody, req.body, res);
    if (!body) return;
    if (Boolean(body.findingKind) !== Boolean(body.findingId))
      return invalid(res, "Choose a complete finding.");
    if (
      [body.organizationId, body.personId, body.householdId].filter(Boolean)
        .length > 1
    ) {
      return invalid(res, "Choose one donor for each agenda item.");
    }
    const finding =
      body.findingKind && body.findingId
        ? await resolveFundraisingFinding(body.findingKind, body.findingId)
        : null;
    if (body.findingId && !finding) return notFound(res, "fundraising finding");
    const organizationId = finding
      ? finding.organizationId
      : body.organizationId;
    const [org, person, household] = await Promise.all([
      organizationId
        ? db
            .select()
            .from(organizations)
            .where(
              and(
                eq(organizations.id, organizationId),
                isNull(organizations.archivedAt),
                eq(organizations.anonymous, false),
              ),
            )
            .then((rows) => rows[0])
        : null,
      body.personId
        ? db
            .select()
            .from(people)
            .where(
              and(
                eq(people.id, body.personId),
                isNull(people.archivedAt),
                eq(people.anonymous, false),
              ),
            )
            .then((rows) => rows[0])
        : null,
      body.householdId
        ? db
            .select()
            .from(households)
            .where(
              and(
                eq(households.id, body.householdId),
                isNull(households.archivedAt),
              ),
            )
            .then((rows) => rows[0])
        : null,
    ]);
    if (
      (organizationId && !org) ||
      (body.personId && !person) ||
      (body.householdId && !household)
    ) {
      return invalid(res, "Choose an accessible, active donor.");
    }
    if (finding && (body.personId || body.householdId || body.organizationId))
      return invalid(res, "A finding uses its linked donor.");
    const title =
      body.title?.trim() ||
      finding?.title ||
      org?.name ||
      (person &&
        [person.firstName, person.lastName].filter(Boolean).join(" ")) ||
      household?.name;
    if (!title)
      return invalid(res, "Enter a title or choose a donor or finding.");
    const id = paramId(req);
    const result = await db.transaction(async (tx) => {
      if (!(await lockDevelopmentMeeting(tx, id))) return "missing";
      const agenda = await tx
        .select()
        .from(developmentAgenda)
        .where(eq(developmentAgenda.meetingId, id))
        .orderBy(asc(developmentAgenda.position));
      if (
        !body.findingId &&
        !body.title &&
        agenda.some(
          (item) =>
            !item.findingId &&
            (organizationId
              ? item.organizationId === organizationId
              : body.personId
                ? item.personId === body.personId
                : body.householdId && item.householdId === body.householdId),
        )
      )
        return "ok";
      const lastPosition = agenda.at(-1)?.position ?? -1;
      await tx
        .insert(developmentAgenda)
        .values({
          id: newId(),
          meetingId: id,
          position: lastPosition + 1,
          title: title.slice(0, 300),
          organizationId,
          personId: body.personId,
          householdId: body.householdId,
          findingKind: body.findingKind,
          findingId: body.findingId,
        })
        .onConflictDoNothing();
      await refreshDevelopmentDonorLinks(tx, id);
      return "ok";
    });
    if (result === "missing") return notFound(res, "development meeting");
    await respondMeeting(res, id);
  }),
);

router.patch(
  "/development-meetings/:id/agenda/:itemId",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(
      UpdateDevelopmentAgendaItemBody,
      req.body,
      res,
    );
    if (!body) return;
    if (body.title !== undefined && !body.title.trim())
      return invalid(res, "Enter an agenda title.");
    const id = paramId(req);
    const result = await db.transaction(async (tx) => {
      if (!(await lockDevelopmentMeeting(tx, id))) return "missing";
      const items = await tx
        .select()
        .from(developmentAgenda)
        .where(eq(developmentAgenda.meetingId, id))
        .orderBy(asc(developmentAgenda.position), asc(developmentAgenda.id));
      const index = items.findIndex((row) => row.id === itemId(req));
      const item = items[index];
      if (!item) return "missing";
      if (item.revision !== body.revision) return "conflict";
      if (body.status === "discussing") {
        for (const active of items.filter(
          (row) => row.status === "discussing" && row.id !== item.id,
        )) {
          await tx
            .update(developmentAgenda)
            .set({ status: "pending", revision: active.revision + 1 })
            .where(eq(developmentAgenda.id, active.id));
        }
      }
      const swap = body.move
        ? items[index + (body.move === "up" ? -1 : 1)]
        : undefined;
      if (swap)
        await tx
          .update(developmentAgenda)
          .set({ position: item.position, revision: swap.revision + 1 })
          .where(eq(developmentAgenda.id, swap.id));
      await tx
        .update(developmentAgenda)
        .set({
          title: body.title?.trim(),
          notes: body.notes,
          decision: body.decision,
          status: body.status,
          position: swap?.position,
          revision: item.revision + 1,
        })
        .where(eq(developmentAgenda.id, item.id));
      return "ok";
    });
    if (result === "missing") return notFound(res, "agenda item");
    if (result === "conflict")
      return conflict(
        res,
        "Someone updated this item. Review their changes before saving.",
      );
    await respondMeeting(res, id);
  }),
);

router.delete(
  "/development-meetings/:id/agenda/:itemId",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const result = await db.transaction(async (tx) => {
      if (!(await lockDevelopmentMeeting(tx, id))) return "missing";
      const [item] = await tx
        .select()
        .from(developmentAgenda)
        .where(
          and(
            eq(developmentAgenda.meetingId, id),
            eq(developmentAgenda.id, itemId(req)),
          ),
        );
      if (!item) return "missing";
      const [action] = await tx
        .select()
        .from(developmentAgendaTasks)
        .where(eq(developmentAgendaTasks.agendaItemId, item.id))
        .limit(1);
      if (
        action ||
        item.notes.trim() ||
        item.decision.trim() ||
        item.status === "done"
      )
        return "has_history";
      await tx
        .delete(developmentAgenda)
        .where(eq(developmentAgenda.id, item.id));
      await refreshDevelopmentDonorLinks(tx, id);
      return "ok";
    });
    if (result === "missing") return notFound(res, "agenda item");
    if (result === "has_history")
      return conflict(
        res,
        "This item has meeting history. Defer it or mark it discussed.",
      );
    await respondMeeting(res, id);
  }),
);

router.post(
  "/development-meetings/:id/agenda/:itemId/tasks",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(AssignDevelopmentActionBody, req.body, res);
    if (!body) return;
    if (!body.title.trim()) return invalid(res, "Enter a task title.");
    const id = paramId(req);
    const result = await db.transaction(async (tx) => {
      const meeting = await lockDevelopmentMeeting(tx, id);
      if (!meeting) return "missing";
      const [item] = await tx
        .select()
        .from(developmentAgenda)
        .where(
          and(
            eq(developmentAgenda.meetingId, id),
            eq(developmentAgenda.id, itemId(req)),
          ),
        );
      if (!item) return "missing";
      const [previous] = await tx
        .select({ task: tasks })
        .from(developmentAgendaTasks)
        .innerJoin(tasks, eq(tasks.id, developmentAgendaTasks.taskId))
        .where(
          and(
            eq(developmentAgendaTasks.agendaItemId, item.id),
            eq(developmentAgendaTasks.requestId, body.requestId),
          ),
        );
      if (previous) return previous.task;
      const [assignee] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(eq(users.id, body.assigneeUserId), isNull(users.archivedAt)),
        );
      if (!assignee) return "assignee";
      const [task] = await tx
        .insert(tasks)
        .values({
          id: newId(),
          title: body.title.trim(),
          description:
            "From the weekly development meeting.\nAgenda: " + item.title,
          assigneeUserId: assignee.id,
          dueDate: body.dueDate,
          createdByUserId: getAppUser(req)!.id,
          organizationIds: item.organizationId ? [item.organizationId] : null,
          personIds: item.personId ? [item.personId] : null,
          householdIds: item.householdId ? [item.householdId] : null,
          grantLeadIds:
            item.findingKind === "grant_lead" && item.findingId
              ? [item.findingId]
              : null,
        })
        .returning();
      await tx
        .insert(developmentAgendaTasks)
        .values({
          agendaItemId: item.id,
          requestId: body.requestId,
          taskId: task!.id,
        });
      return task!;
    });
    if (result === "missing") return notFound(res, "agenda item");
    if (result === "assignee")
      return invalid(res, "Choose an active team member.");
    res.json(result);
  }),
);

router.post(
  "/development-meetings/:id/transcript",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(
      SummarizeDevelopmentTranscriptBody,
      req.body,
      res,
    );
    if (!body) return;
    const transcript = body.transcript.trim();
    if (!transcript) return invalid(res, "Paste or upload a transcript first.");
    const id = paramId(req);
    const [note] = await db
      .select()
      .from(meetingNotes)
      .where(
        and(eq(meetingNotes.id, id), isNotNull(meetingNotes.developmentWeek)),
      );
    if (!note) return notFound(res, "development meeting");
    const result = await summarizeMeeting(
      savedMeetingSource({ ...note, rawTranscript: transcript }),
      { relationship: await meetingRelationshipContext(note, note.meetingDate, note.id) },
    );
    if (!hasUsableMeetingSummary(result)) {
      res
        .status(503)
        .json({
          error: "summary_unavailable",
          message: "The transcript could not be summarized. Try again.",
        });
      return;
    }
    const updated = await db.transaction(async (tx) => {
      const current = await lockDevelopmentMeeting(tx, id);
      if (!current || current.updatedAt.valueOf() !== note.updatedAt.valueOf())
        return null;
      const summaryOnly =
        current.summaryOnly ||
        getAppUser(req)!.emailSyncMode === "summary_only";
      const items = (current.actionItems ?? []) as MeetingActionItem[];
      const [row] = await tx
        .update(meetingNotes)
        .set({
          rawTranscript: summaryOnly ? null : transcript,
          summaryOnly,
          aiSummary: result.summary,
          actionItems: mergeTranscriptActionItems(items, result),
          updatedAt: new Date(),
        })
        .where(eq(meetingNotes.id, id))
        .returning();
      return row;
    });
    if (!updated)
      return conflict(
        res,
        "The meeting notes changed while summarizing. Try again.",
      );
    const { rawTranscript, ...shared } = updated;
    res.json({ ...shared, rawTranscript: null });
  }),
);

export default router;
