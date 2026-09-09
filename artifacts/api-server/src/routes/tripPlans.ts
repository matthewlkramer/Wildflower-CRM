import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import {
  addresses,
  calendarEvents,
  calendarSyncState,
  emailMessages,
  emails,
  people,
  tripPlans,
  tripVisitCandidates,
  users,
  type TripPlan,
} from "@workspace/db/schema";
import {
  AddTripVisitBody,
  CreateTripPlanBody,
  ListTripPlansQueryParams,
  UpdateTripPlanBody,
  UpdateTripVisitBody,
} from "@workspace/api-zod";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNull,
  inArray,
  lt,
  lte,
  max,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
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
  calendarEventSelection,
  calendarEventVisibleToCaller,
} from "../lib/calendarEventSelect";
import { getViewer, maskName } from "../lib/identityVisibility";
import { looksLikeTripInvitation, tripAvailability } from "../lib/tripPlanner";

const router: IRouter = Router();
router.use(requireAuth);

type TripInput = {
  travelerUserId?: string;
  title?: string | null;
  destinationCity?: string | null;
  destinationState?: string | null;
  travelStartsAt?: string;
  travelEndsAt?: string;
  meetingWindowStartsAt?: string | null;
  meetingWindowEndsAt?: string | null;
  outboundTravelMinutes?: number | null;
  returnTravelMinutes?: number | null;
  notes?: string | null;
};

function canMutate(req: Parameters<typeof getAppUser>[0], res: Response) {
  const user = getAppUser(req);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  if (user.role === "read_only") {
    res.status(403).json({ error: "read_only" });
    return null;
  }
  return user;
}

function nullableText(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mergedText(
  value: string | null | undefined,
  current: string | null | undefined,
): string | null {
  return value === undefined
    ? (current ?? null)
    : (nullableText(value) ?? null);
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function badTrip(res: Response, message: string) {
  res.status(400).json({ error: "invalid_trip", message });
  return null;
}

async function requestCalendarRefresh(userIds: string[]) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  await db
    .update(calendarSyncState)
    .set({ lastSyncedAt: null, updatedAt: new Date() })
    .where(inArray(calendarSyncState.calendarUserId, ids));
}

async function tripValues(body: TripInput, res: Response, current?: TripPlan) {
  const travelerUserId = body.travelerUserId ?? current?.travelerUserId;
  const travelStartsAt = body.travelStartsAt
    ? new Date(body.travelStartsAt)
    : current?.travelStartsAt;
  const travelEndsAt = body.travelEndsAt
    ? new Date(body.travelEndsAt)
    : current?.travelEndsAt;
  const meetingWindowStartsAt =
    body.meetingWindowStartsAt === undefined
      ? current?.meetingWindowStartsAt
      : body.meetingWindowStartsAt
        ? new Date(body.meetingWindowStartsAt)
        : null;
  const meetingWindowEndsAt =
    body.meetingWindowEndsAt === undefined
      ? current?.meetingWindowEndsAt
      : body.meetingWindowEndsAt
        ? new Date(body.meetingWindowEndsAt)
        : null;

  if (!travelerUserId || !travelStartsAt || !travelEndsAt) {
    return badTrip(res, "Traveler, start, and end are required.");
  }
  if (
    !Number.isFinite(travelStartsAt.getTime()) ||
    !Number.isFinite(travelEndsAt.getTime()) ||
    travelEndsAt <= travelStartsAt
  ) {
    return badTrip(res, "Trip end must be after trip start.");
  }
  if ((meetingWindowStartsAt == null) !== (meetingWindowEndsAt == null)) {
    return badTrip(res, "Enter both meeting-window times or leave both blank.");
  }
  if (
    meetingWindowStartsAt &&
    meetingWindowEndsAt &&
    (meetingWindowStartsAt < travelStartsAt ||
      meetingWindowEndsAt > travelEndsAt ||
      meetingWindowEndsAt <= meetingWindowStartsAt)
  ) {
    return badTrip(res, "The meeting window must fall within the trip.");
  }
  const traveler = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, travelerUserId), isNull(users.archivedAt)))
    .then((rows) => rows[0]);
  if (!traveler) return badTrip(res, "Choose an active team member.");

  return {
    travelerUserId,
    travelStartsAt,
    travelEndsAt,
    meetingWindowStartsAt,
    meetingWindowEndsAt,
    title: mergedText(body.title, current?.title),
    destinationCity: mergedText(body.destinationCity, current?.destinationCity),
    destinationState: mergedText(
      body.destinationState,
      current?.destinationState,
    ),
    outboundTravelMinutes:
      body.outboundTravelMinutes === undefined
        ? (current?.outboundTravelMinutes ?? null)
        : body.outboundTravelMinutes,
    returnTravelMinutes:
      body.returnTravelMinutes === undefined
        ? (current?.returnTravelMinutes ?? null)
        : body.returnTravelMinutes,
    notes: mergedText(body.notes, current?.notes),
  };
}

function tripVisibleFilter(req: Parameters<typeof getAppUser>[0]): SQL {
  const user = getAppUser(req);
  return user?.role === "admin" ? sql`true` : isNull(tripPlans.archivedAt);
}

async function loadTrip(req: Parameters<typeof getAppUser>[0], id: string) {
  return db
    .select()
    .from(tripPlans)
    .where(and(eq(tripPlans.id, id), tripVisibleFilter(req)))
    .then((rows) => rows[0]);
}

async function loadTripEvents(trip: TripPlan, callerId: string) {
  return db
    .select(calendarEventSelection())
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.calendarUserId, trip.travelerUserId),
        calendarEventVisibleToCaller(callerId),
        lt(calendarEvents.startAt, trip.travelEndsAt),
        gt(
          sql`coalesce(${calendarEvents.endAt}, ${calendarEvents.startAt})`,
          trip.travelStartsAt,
        ),
      ),
    )
    .orderBy(asc(calendarEvents.startAt));
}

async function tripSummary(trip: TripPlan, callerId: string) {
  const events = (await loadTripEvents(trip, callerId)).filter(
    (event) => event.status !== "cancelled",
  );
  return { ...trip, ...tripAvailability(trip, events) };
}

async function loadTripDetail(
  req: Parameters<typeof getAppUser>[0],
  trip: TripPlan,
) {
  const caller = getAppUser(req)!;
  const viewer = getViewer(req);
  const events = await loadTripEvents(trip, caller.id);
  const rows = await db
    .select({
      id: tripVisitCandidates.id,
      tripId: tripVisitCandidates.tripId,
      personId: tripVisitCandidates.personId,
      rank: tripVisitCandidates.rank,
      rationale: tripVisitCandidates.rationale,
      source: tripVisitCandidates.source,
      notes: tripVisitCandidates.notes,
      archivedAt: tripVisitCandidates.archivedAt,
      createdAt: tripVisitCandidates.createdAt,
      updatedAt: tripVisitCandidates.updatedAt,
      personName: sql<string>`coalesce(nullif(${people.fullName}, ''), nullif(concat_ws(' ', ${people.firstName}, ${people.lastName}), ''), 'Unnamed person')`,
      anonymous: people.anonymous,
      ownerUserId: people.ownerUserId,
      priority: people.priority,
      primaryEmail: sql<string | null>`(
        select e.email from ${emails} e
        where e.person_id = ${people.id}
        order by e.is_preferred desc, e.created_at asc
        limit 1
      )`,
      location: sql<string | null>`(
        select concat_ws(', ', nullif(a.city_name, ''), nullif(a.state_code, ''))
        from ${addresses} a
        where a.person_id = ${people.id}
        order by a.created_at asc
        limit 1
      )`,
    })
    .from(tripVisitCandidates)
    .innerJoin(people, eq(people.id, tripVisitCandidates.personId))
    .where(
      and(
        eq(tripVisitCandidates.tripId, trip.id),
        isNull(tripVisitCandidates.archivedAt),
      ),
    )
    .orderBy(asc(tripVisitCandidates.rank), asc(tripVisitCandidates.createdAt));

  const personIds = rows.map((row) => row.personId);
  const outreachStart = new Date(
    Math.min(
      trip.createdAt.getTime() - 7 * 86_400_000,
      trip.travelStartsAt.getTime() - 180 * 86_400_000,
    ),
  );
  const outreachEnd = new Date(trip.travelEndsAt.getTime() + 86_400_000);
  const messages = personIds.length
    ? await db
        .select({
          id: emailMessages.id,
          gmailThreadId: emailMessages.gmailThreadId,
          direction: emailMessages.direction,
          sentAt: emailMessages.sentAt,
          subject: emailMessages.subject,
          snippet: emailMessages.snippet,
          bodyText: emailMessages.bodyText,
          aiSummary: emailMessages.aiSummary,
          matchedPersonIds: emailMessages.matchedPersonIds,
        })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.mailboxUserId, trip.travelerUserId),
            or(
              eq(emailMessages.isPrivate, false),
              eq(emailMessages.mailboxUserId, caller.id),
            ),
            gte(emailMessages.sentAt, outreachStart),
            lte(emailMessages.sentAt, outreachEnd),
            sql`${emailMessages.matchedPersonIds} && ARRAY[${sql.join(
              personIds.map((id) => sql`${id}`),
              sql`, `,
            )}]::text[]`,
          ),
        )
        .orderBy(asc(emailMessages.sentAt))
    : [];

  const visits = rows.map((row) => {
    const personMessages = messages.filter((message) =>
      message.matchedPersonIds?.includes(row.personId),
    );
    const invitation = personMessages.find(
      (message) =>
        message.direction === "sent" &&
        looksLikeTripInvitation(message, trip.destinationCity),
    );
    const response = invitation?.gmailThreadId
      ? personMessages.find(
          (message) =>
            message.direction === "received" &&
            message.gmailThreadId === invitation.gmailThreadId &&
            message.sentAt > invitation.sentAt,
        )
      : undefined;
    const scheduled = events.find(
      (event) =>
        event.status !== "cancelled" &&
        event.matchedPersonIds?.includes(row.personId),
    );
    return {
      id: row.id,
      tripId: row.tripId,
      personId: row.personId,
      personName:
        maskName(
          row.personName,
          { anonymous: row.anonymous, ownerUserId: row.ownerUserId },
          viewer,
        ) ?? "Unnamed person",
      primaryEmail: row.primaryEmail,
      location: row.location,
      priority: row.priority,
      rank: row.rank,
      rationale: row.rationale,
      source: row.source as "system_draft" | "manual",
      notes: row.notes,
      outreachStatus: response
        ? ("responded" as const)
        : invitation
          ? ("invited" as const)
          : ("not_invited" as const),
      invitationSentAt: invitation?.sentAt ?? null,
      invitationMessageId: invitation?.id ?? null,
      respondedAt: response?.sentAt ?? null,
      responseMessageId: response?.id ?? null,
      scheduledEventId: scheduled?.id ?? null,
      scheduledAt: scheduled?.startAt ?? null,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
  return {
    ...(await tripSummary(trip, caller.id)),
    visits,
    calendarEvents: events,
  };
}

router.get(
  "/trips",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListTripPlansQueryParams, req.query, res);
    if (!q) return;
    const caller = getAppUser(req)!;
    const filters: SQL[] = [];
    if (q.travelerUserId)
      filters.push(eq(tripPlans.travelerUserId, q.travelerUserId));
    if (q.startAfter)
      filters.push(gte(tripPlans.travelEndsAt, new Date(q.startAfter)));
    if (q.startBefore)
      filters.push(lte(tripPlans.travelStartsAt, new Date(q.startBefore)));
    if (
      !(
        caller.role === "admin" &&
        parseBoolQuery(req, "includeArchived") === true
      )
    ) {
      filters.push(isNull(tripPlans.archivedAt));
    }
    const rows = await db
      .select()
      .from(tripPlans)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(tripPlans.travelStartsAt));
    res.json({
      data: await Promise.all(rows.map((row) => tripSummary(row, caller.id))),
    });
  }),
);

router.post(
  "/trips",
  asyncHandler(async (req, res) => {
    const user = canMutate(req, res);
    if (!user) return;
    const body = parseOrBadRequest(CreateTripPlanBody, req.body, res);
    if (!body) return;
    const values = await tripValues(body, res);
    if (!values) return;
    const [row] = await db
      .insert(tripPlans)
      .values({ id: newId(), createdByUserId: user.id, ...values })
      .returning();
    await requestCalendarRefresh([row.travelerUserId]);
    res.status(201).json(await tripSummary(row, user.id));
  }),
);

router.get(
  "/trips/:id",
  asyncHandler(async (req, res) => {
    const row = await loadTrip(req, paramId(req));
    if (!row) return notFound(res, "trip");
    res.json(await loadTripDetail(req, row));
  }),
);

router.patch(
  "/trips/:id",
  asyncHandler(async (req, res) => {
    const user = canMutate(req, res);
    if (!user) return;
    const body = parseOrBadRequest(UpdateTripPlanBody, req.body, res);
    if (!body) return;
    const current = await loadTrip(req, paramId(req));
    if (!current) return notFound(res, "trip");
    const values = await tripValues(body, res, current);
    if (!values) return;
    const [row] = await db
      .update(tripPlans)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(tripPlans.id, current.id))
      .returning();
    await requestCalendarRefresh([
      current.travelerUserId,
      row.travelerUserId,
    ]);
    res.json(await tripSummary(row, user.id));
  }),
);

router.post(
  "/trips/:id/archive",
  asyncHandler(async (req, res) => {
    const user = canMutate(req, res);
    if (!user) return;
    const [row] = await db
      .update(tripPlans)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tripPlans.id, paramId(req)), isNull(tripPlans.archivedAt)))
      .returning();
    if (!row) return notFound(res, "trip");
    await requestCalendarRefresh([row.travelerUserId]);
    res.json(await tripSummary(row, user.id));
  }),
);

router.post(
  "/trips/:id/draft-visits",
  asyncHandler(async (req, res) => {
    if (!canMutate(req, res)) return;
    const trip = await loadTrip(req, paramId(req));
    if (!trip) return notFound(res, "trip");
    if (!trip.destinationCity) {
      res.status(409).json({
        error: "destination_required",
        message: "Add a destination city before drafting people to visit.",
      });
      return;
    }
    const locationFilters: SQL[] = [
      isNull(people.archivedAt),
      eq(people.deceased, false),
      sql`lower(trim(${addresses.cityName})) = lower(trim(${trip.destinationCity}))`,
    ];
    if (trip.destinationState) {
      locationFilters.push(
        sql`lower(trim(${addresses.stateCode})) = lower(trim(${trip.destinationState}))`,
      );
    }
    const matches = await db
      .selectDistinctOn([people.id], {
        personId: people.id,
        priority: people.priority,
        ownerUserId: people.ownerUserId,
      })
      .from(people)
      .innerJoin(addresses, eq(addresses.personId, people.id))
      .where(and(...locationFilters))
      .orderBy(people.id);
    const priorityOrder: Record<string, number> = {
      top: 0,
      high: 1,
      medium: 2,
      low: 3,
    };
    matches.sort(
      (a, b) =>
        (priorityOrder[a.priority ?? ""] ?? 4) -
          (priorityOrder[b.priority ?? ""] ?? 4) ||
        Number(b.ownerUserId === trip.travelerUserId) -
          Number(a.ownerUserId === trip.travelerUserId),
    );
    const [{ value: maxRank } = { value: 0 }] = await db
      .select({ value: max(tripVisitCandidates.rank) })
      .from(tripVisitCandidates)
      .where(eq(tripVisitCandidates.tripId, trip.id));
    const candidates = matches.slice(0, 25).map((match, index) => ({
      id: newId(),
      tripId: trip.id,
      personId: match.personId,
      rank: Number(maxRank ?? 0) + index + 1,
      source: "system_draft",
      rationale: `${match.priority ? `${match.priority} priority; ` : ""}address matches ${trip.destinationCity}${trip.destinationState ? `, ${trip.destinationState}` : ""}.`,
    }));
    if (candidates.length) {
      await db
        .insert(tripVisitCandidates)
        .values(candidates)
        .onConflictDoNothing({
          target: [tripVisitCandidates.tripId, tripVisitCandidates.personId],
        });
    }
    res.json(await loadTripDetail(req, trip));
  }),
);

router.post(
  "/trips/:id/visits",
  asyncHandler(async (req, res) => {
    if (!canMutate(req, res)) return;
    const body = parseOrBadRequest(AddTripVisitBody, req.body, res);
    if (!body) return;
    const trip = await loadTrip(req, paramId(req));
    if (!trip) return notFound(res, "trip");
    const person = await db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.id, body.personId), isNull(people.archivedAt)))
      .then((rows) => rows[0]);
    if (!person) return badTrip(res, "Choose an active person.");
    const existing = await db
      .select()
      .from(tripVisitCandidates)
      .where(
        and(
          eq(tripVisitCandidates.tripId, trip.id),
          eq(tripVisitCandidates.personId, body.personId),
        ),
      )
      .then((rows) => rows[0]);
    if (existing && !existing.archivedAt) {
      res.status(409).json({ error: "person_already_on_trip" });
      return;
    }
    let visitId = existing?.id;
    if (existing) {
      await db
        .update(tripVisitCandidates)
        .set({
          archivedAt: null,
          source: "manual",
          rank: body.rank ?? existing.rank,
          rationale: nullableText(body.rationale) ?? existing.rationale,
          notes: nullableText(body.notes) ?? existing.notes,
          updatedAt: new Date(),
        })
        .where(eq(tripVisitCandidates.id, existing.id));
    } else {
      const [{ value: maxRank } = { value: 0 }] = await db
        .select({ value: max(tripVisitCandidates.rank) })
        .from(tripVisitCandidates)
        .where(eq(tripVisitCandidates.tripId, trip.id));
      visitId = newId();
      await db.insert(tripVisitCandidates).values({
        id: visitId,
        tripId: trip.id,
        personId: body.personId,
        rank: body.rank ?? Number(maxRank ?? 0) + 1,
        source: "manual",
        rationale: nullableText(body.rationale),
        notes: nullableText(body.notes),
      });
    }
    const detail = await loadTripDetail(req, trip);
    res.status(201).json(detail.visits.find((visit) => visit.id === visitId));
  }),
);

router.patch(
  "/trips/:id/visits/:visitId",
  asyncHandler(async (req, res) => {
    if (!canMutate(req, res)) return;
    const body = parseOrBadRequest(UpdateTripVisitBody, req.body, res);
    if (!body) return;
    const trip = await loadTrip(req, paramId(req));
    if (!trip) return notFound(res, "trip");
    const [row] = await db
      .update(tripVisitCandidates)
      .set({
        ...(body.rank === undefined ? {} : { rank: body.rank }),
        ...(body.rationale === undefined
          ? {}
          : { rationale: nullableText(body.rationale) }),
        ...(body.notes === undefined
          ? {}
          : { notes: nullableText(body.notes) }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tripVisitCandidates.id, routeParam(req.params.visitId)),
          eq(tripVisitCandidates.tripId, trip.id),
          isNull(tripVisitCandidates.archivedAt),
        ),
      )
      .returning();
    if (!row) return notFound(res, "trip visit");
    const detail = await loadTripDetail(req, trip);
    res.json(detail.visits.find((visit) => visit.id === row.id));
  }),
);

router.post(
  "/trips/:id/visits/:visitId/archive",
  asyncHandler(async (req, res) => {
    if (!canMutate(req, res)) return;
    const [row] = await db
      .update(tripVisitCandidates)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(tripVisitCandidates.id, routeParam(req.params.visitId)),
          eq(tripVisitCandidates.tripId, paramId(req)),
          isNull(tripVisitCandidates.archivedAt),
        ),
      )
      .returning({ id: tripVisitCandidates.id });
    if (!row) return notFound(res, "trip visit");
    res.status(204).end();
  }),
);

export default router;
