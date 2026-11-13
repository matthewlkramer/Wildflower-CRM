import { Router } from "express";
import { db } from "@workspace/db";
import { calendarEvents, emailMessages, meetingNotes, opportunitiesAndPledges as opportunities, opportunityFollowUps as followUps, users, type MeetingActionItem, type MeetingFollowUpSuggestion, type OpportunityFollowUpRow } from "@workspace/db/schema";
import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { CreateOpportunityFollowUpBody, UpdateOpportunityFollowUpBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { asyncHandler, newId, notFound, paramId, parseOrBadRequest } from "../lib/helpers";
import { chicagoToday } from "../lib/effectiveProjectedCloseDate";
import { checkInAfter, followUpKey, followUpStatus, reviewWaitingReply, safeEvidenceUrl, validFollowUpDate } from "../lib/opportunityFollowUps";
import type { z } from "zod";

const router = Router();
router.use(requireAuth);
const scope = (opp: typeof opportunities.$inferSelect) => or(
  opp.organizationId ? sql`${meetingNotes.organizationIds} @> ARRAY[${opp.organizationId}]::text[]` : undefined,
  opp.individualGiverPersonId ? sql`${meetingNotes.personIds} @> ARRAY[${opp.individualGiverPersonId}]::text[]` : undefined,
  opp.householdId ? sql`${meetingNotes.householdIds} @> ARRAY[${opp.householdId}]::text[]` : undefined,
)!;
const sharedMeeting = sql`not exists (select 1 from ${calendarEvents}
  where ${calendarEvents.id} = ${meetingNotes.calendarEventId} and ${calendarEvents.isPrivate})`;
const loadOpp = (id: string) => db.select().from(opportunities)
  .where(and(eq(opportunities.id, id), isNull(opportunities.archivedAt))).then(([row]) => row);

function suggestionsFor(note: typeof meetingNotes.$inferSelect): MeetingFollowUpSuggestion[] {
  return [
    ...((note.actionItems ?? []) as MeetingActionItem[]).filter((item) => item.evidence && !item.promotedTaskId)
      .map((item): MeetingFollowUpSuggestion => ({ kind: "ours", title: item.title, ownerName: item.assigneeName, evidence: item.evidence! })),
    ...(note.followUpSuggestions ?? []),
  ];
}

const serialize = (row: OpportunityFollowUpRow) => ({ ...row, status: followUpStatus(row) });

router.get("/opportunity-follow-ups/due", asyncHandler(async (req, res) => {
  const user = getAppUser(req)!;
  const items = await db.select({ row: followUps, opportunityName: opportunities.name }).from(followUps)
    .innerJoin(opportunities, eq(opportunities.id, followUps.opportunityId))
    .where(and(eq(followUps.kind, "waiting"), isNull(followUps.resolvedOn), lte(followUps.checkInOn, chicagoToday()),
      eq(followUps.pointPersonId, user.id), isNull(opportunities.archivedAt)))
    .orderBy(asc(followUps.checkInOn), followUps.id).limit(50);
  const reviewed = await Promise.all(items.map(async ({ row, opportunityName }) => ({
    ...serialize(await reviewWaitingReply(row)), opportunityName,
  })));
  res.json(reviewed.filter((row) => row.status === "due"));
}));

router.get("/opportunities-and-pledges/:id/follow-ups", asyncHandler(async (req, res) => {
  const opp = await loadOpp(paramId(req));
  if (!opp) return notFound(res, "opportunity");
  const [rows, notes] = await Promise.all([
    db.select().from(followUps).where(eq(followUps.opportunityId, opp.id)).orderBy(desc(followUps.updatedAt)),
    db.select().from(meetingNotes).where(and(scope(opp), sharedMeeting, isNull(meetingNotes.developmentWeek)))
      .orderBy(desc(meetingNotes.meetingDate)).limit(6),
  ]);
  const used = new Set(rows.map((row) => followUpKey(row.kind, row.title)));
  const suggestions = notes.flatMap((note) => suggestionsFor(note).flatMap((suggestion) => {
    const key = followUpKey(suggestion.kind, suggestion.title);
    if (used.has(key) || rows.some((row) => row.meetingNoteId === note.id && row.suggestionKey === key)) return [];
    used.add(key);
    return [{ ...suggestion, key, meetingNoteId: note.id, meetingTitle: note.title }];
  }));
  const reviewed = await Promise.all(rows.map(async (row) =>
    serialize(followUpStatus(row) === "due" ? await reviewWaitingReply(row) : row)));
  res.json({ items: reviewed, suggestions });
}));

type Input = z.infer<typeof CreateOpportunityFollowUpBody>;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function writeFields(tx: Tx, opp: typeof opportunities.$inferSelect, input: Input, editorId: string, prior?: OpportunityFollowUpRow) {
  const title = input.title.trim();
  const checkInDays = input.checkInDays ?? prior?.checkInDays ?? 14;
  const ownerName = input.ownerName?.trim() || null;
  const today = chicagoToday();
  if (!title) throw new Error("Enter a follow-up.");
  for (const date of [input.checkInOn, input.externalDueDate, input.sentOn]) {
    if (date && !validFollowUpDate(date)) throw new Error("Enter a valid date.");
  }
  if (input.sentOn && input.sentOn > today) throw new Error("A sent date cannot be in the future.");
  if (input.kind === "waiting" && !ownerName) throw new Error("Enter who owns the next step at the funder.");
  if (prior && input.kind !== prior.kind) throw new Error("The follow-up type cannot be changed.");
  const evidenceUrl = safeEvidenceUrl(input.evidenceUrl);
  if (input.evidenceUrl && !evidenceUrl) throw new Error("Use a secure HTTPS link for evidence.");
  const meetingNoteId = prior?.meetingNoteId ?? input.meetingNoteId ?? null;
  const suggestionKey = prior?.suggestionKey ?? input.suggestionKey ?? null;
  if (meetingNoteId && !prior) {
    const [meeting] = await tx.select().from(meetingNotes).where(and(eq(meetingNotes.id, meetingNoteId), scope(opp), sharedMeeting));
    if (!meeting || (suggestionKey && !suggestionsFor(meeting).some((item) =>
      item.kind === input.kind && followUpKey(item.kind, item.title) === suggestionKey))) {
      throw new Error("This meeting suggestion is unavailable. Refresh the opportunity.");
    }
  }
  if (suggestionKey && !meetingNoteId) throw new Error("Select the source meeting.");
  const pointPersonId = input.kind === "shared" ? null : input.pointPersonId ?? opp.ownerUserId ?? editorId;
  if (pointPersonId) {
    const [user] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, pointPersonId), isNull(users.archivedAt)));
    if (!user) throw new Error("Choose an active Wildflower point person.");
  }
  const evidenceEmailId = input.evidenceEmailId ?? null;
  if (evidenceEmailId && evidenceEmailId !== prior?.evidenceEmailId) {
    const [email] = await tx.select({ id: emailMessages.id }).from(emailMessages).where(and(
      eq(emailMessages.id, evidenceEmailId), eq(emailMessages.isPrivate, false),
      or(
        opp.organizationId ? sql`(${emailMessages.matchedOrganizationIds} @> ARRAY[${opp.organizationId}]::text[] OR
          ${emailMessages.matchedPersonIds} && ARRAY(select person_id from people_entity_roles where organization_id = ${opp.organizationId} and current = 'current')::text[])` : undefined,
        opp.individualGiverPersonId ? sql`${emailMessages.matchedPersonIds} @> ARRAY[${opp.individualGiverPersonId}]::text[]` : undefined,
        opp.householdId ? sql`${emailMessages.matchedHouseholdIds} @> ARRAY[${opp.householdId}]::text[]` : undefined,
      ),
    ));
    if (!email) throw new Error("Choose a shared email linked to this funder.");
  }
  const dependencyId = input.kind === "waiting" ? input.dependencyId ?? null : null;
  let dependency: OpportunityFollowUpRow | undefined;
  if (dependencyId) {
    [dependency] = await tx.select().from(followUps).where(and(
      eq(followUps.id, dependencyId), eq(followUps.opportunityId, opp.id), eq(followUps.kind, "ours"),
    ));
    if (!dependency) throw new Error("Choose a Wildflower deliverable from this opportunity.");
  }
  if (input.checkInOn && dependency?.sentOn && input.checkInOn < dependency.sentOn) {
    throw new Error("The check-in must be on or after the deliverable was sent.");
  }
  const checkInOn = input.kind !== "waiting" || (dependency && !dependency.sentOn) ? null :
    input.checkInOn ?? (dependency?.sentOn ? checkInAfter(dependency.sentOn, checkInDays) : checkInAfter(today, checkInDays));
  return {
    kind: input.kind, title, ownerName, pointPersonId, meetingNoteId, suggestionKey,
    evidenceEmailId, evidenceUrl, evidenceNote: input.evidenceNote?.trim() || null,
    readStatus: input.kind === "shared" ? input.readStatus ?? "unknown" : null,
    externalDueDate: input.kind === "waiting" ? input.externalDueDate ?? null : null,
    dependencyId, checkInDays, checkInOn,
    sentOn: input.kind === "waiting" ? null : input.sentOn ?? prior?.sentOn ?? null,
    reviewedEmailsThrough: evidenceEmailId === prior?.evidenceEmailId ? prior?.reviewedEmailsThrough : null,
    updatedAt: new Date(),
  };
}

router.post("/opportunities-and-pledges/:id/follow-ups", asyncHandler(async (req, res) => {
  const user = getAppUser(req)!;
  if (user.role === "read_only") { res.status(403).json({ error: "forbidden" }); return; }
  const input = parseOrBadRequest(CreateOpportunityFollowUpBody, req.body, res);
  if (!input) return;
  const opp = await loadOpp(paramId(req));
  if (!opp) return notFound(res, "opportunity");
  try {
    const row = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(opportunities).where(and(eq(opportunities.id, opp.id), isNull(opportunities.archivedAt))).for("update");
      if (!locked) throw new Error("This opportunity is no longer active.");
      const fields = await writeFields(tx, locked, input, user.id);
      const [inserted] = await tx.insert(followUps).values({ id: newId(), opportunityId: opp.id, ...fields })
        .onConflictDoNothing().returning();
      if (inserted) return inserted;
      const [existing] = await tx.select().from(followUps).where(and(eq(followUps.opportunityId, opp.id),
        eq(followUps.meetingNoteId, fields.meetingNoteId!), eq(followUps.suggestionKey, fields.suggestionKey!)));
      return existing;
    });
    res.status(201).json(serialize(row));
  } catch (error) {
    res.status(400).json({ error: "invalid_follow_up", message: error instanceof Error && !("query" in error) ? error.message : "The follow-up could not be saved." });
  }
}));

router.patch("/opportunity-follow-ups/:id", asyncHandler(async (req, res) => {
  const user = getAppUser(req)!;
  if (user.role === "read_only") { res.status(403).json({ error: "forbidden" }); return; }
  const body = parseOrBadRequest(UpdateOpportunityFollowUpBody, req.body, res);
  if (!body) return;
  const id = paramId(req);
  const [existing] = await db.select().from(followUps).where(eq(followUps.id, id));
  const opp = existing && await loadOpp(existing.opportunityId);
  if (!opp) return notFound(res, "opportunity follow-up");
  try {
    const row = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(opportunities).where(and(eq(opportunities.id, opp.id), isNull(opportunities.archivedAt))).for("update");
      if (!locked) throw new Error("This opportunity is no longer active.");
      const [prior] = await tx.select().from(followUps).where(eq(followUps.id, id)).for("update");
      if (!prior) throw new Error("This follow-up no longer exists.");
      const today = chicagoToday();
      const date = body.date ?? today;
      if (!validFollowUpDate(date) || date > today) throw new Error("Use a valid date on or before today.");
      if (Boolean(body.details) === Boolean(body.action)) throw new Error("Choose an edit or one status change.");
      let patch: Partial<OpportunityFollowUpRow> = { updatedAt: new Date() };
      if (body.details) {
        const details = await writeFields(tx, locked, body.details, user.id, prior);
        if (prior.kind === "ours" && details.sentOn !== prior.sentOn) throw new Error("Use Mark sent to record the send date.");
        patch = details;
      } else if (body.action === "sent" && prior.kind === "ours" && !prior.resolvedOn) {
        patch.sentOn = prior.sentOn ?? date;
        if (!prior.sentOn) {
          const dependents = await tx.select().from(followUps).where(and(eq(followUps.dependencyId, id),
            isNull(followUps.checkInOn), isNull(followUps.resolvedOn)));
          for (const dependent of dependents) {
            await tx.update(followUps).set({ checkInOn: checkInAfter(date, dependent.checkInDays), updatedAt: new Date() })
              .where(eq(followUps.id, dependent.id));
          }
        }
      } else if (body.action === "resolved" && prior.kind === "waiting") {
        patch.resolvedOn = prior.resolvedOn ?? date;
      } else if (body.action === "reopen" && prior.kind === "waiting" && prior.resolvedOn) {
        patch.resolvedOn = null;
        patch.updateEmailId = null;
        patch.reviewedEmailsThrough = new Date();
        patch.checkInOn = prior.checkInOn ? checkInAfter(today, prior.checkInDays) : null;
      } else if (body.action === "checked_in" && prior.kind === "waiting" && prior.checkInOn && !prior.resolvedOn) {
        patch.checkInOn = checkInAfter(date, prior.checkInDays);
      } else {
        throw new Error("That status change is unavailable for this follow-up.");
      }
      return (await tx.update(followUps).set(patch).where(eq(followUps.id, id)).returning())[0];
    });
    res.json(serialize(row));
  } catch (error) {
    res.status(400).json({ error: "invalid_follow_up", message: error instanceof Error && !("query" in error) ? error.message : "The follow-up could not be saved." });
  }
}));

export default router;
