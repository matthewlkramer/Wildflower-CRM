import { db } from "@workspace/db";
import {
  calendarEvents,
  giftsAndPayments,
  households,
  opportunitiesAndPledges,
  organizations,
  people,
  peopleEntityRoles,
  type CalendarEvent,
} from "@workspace/db/schema";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { matchEmails } from "./emailMatcher";
import { listEvents, type GCalEvent } from "./gcal";
import { getValidGoogleAccessTokenForUser } from "./googleTokenStore";
import {
  ZOOM_START_WINDOW_MS,
  zoomMeetingIdFromInvite,
} from "./zoomMeetingIdentity";

export async function matchZoomDonors(
  addresses: string[],
  ownerEmail: string,
  date: Date,
) {
  const match = await matchEmails(addresses, ownerEmail, date, {
    exactAddressOnly: true,
  });
  const [contacts, roles] = match.personIds.length
    ? await Promise.all([
        db
          .select({ id: people.id, householdId: people.primaryHouseholdId })
          .from(people)
          .where(
            and(inArray(people.id, match.personIds), isNull(people.archivedAt)),
          ),
        db
          .select({
            personId: peopleEntityRoles.personId,
            organizationId: peopleEntityRoles.organizationId,
          })
          .from(peopleEntityRoles)
          .where(
            and(
              inArray(peopleEntityRoles.personId, match.personIds),
              eq(peopleEntityRoles.current, "current"),
            ),
          ),
      ])
    : [[], []];
  const activePeople = new Set(contacts.map(({ id }) => id));
  const organizationIds = [
    ...new Set([
      ...match.organizationIds,
      ...roles.flatMap((r) =>
        r.organizationId && activePeople.has(r.personId)
          ? [r.organizationId]
          : [],
      ),
    ]),
  ];
  const householdIds = [
    ...new Set([
      ...match.householdIds,
      ...contacts.flatMap((r) => (r.householdId ? [r.householdId] : [])),
    ]),
  ];
  const [donors, funders, families] = await Promise.all([
    contacts.length
      ? db
          .select({ id: people.id })
          .from(people)
          .where(
            and(
              inArray(people.id, [...activePeople]),
              or(
                sql`exists (select 1 from ${giftsAndPayments} where ${giftsAndPayments.individualGiverPersonId} = ${people.id} and ${giftsAndPayments.archivedAt} is null)`,
                sql`exists (select 1 from ${opportunitiesAndPledges} where ${opportunitiesAndPledges.individualGiverPersonId} = ${people.id} and ${opportunitiesAndPledges.archivedAt} is null)`,
              ),
            ),
          )
      : [],
    organizationIds.length
      ? db
          .select({ id: organizations.id })
          .from(organizations)
          .where(
            and(
              inArray(organizations.id, organizationIds),
              isNull(organizations.archivedAt),
              or(
                eq(organizations.issuesGrants, true),
                sql`exists (select 1 from ${giftsAndPayments} where ${giftsAndPayments.organizationId} = ${organizations.id} and ${giftsAndPayments.archivedAt} is null)`,
                sql`exists (select 1 from ${opportunitiesAndPledges} where ${opportunitiesAndPledges.organizationId} = ${organizations.id} and ${opportunitiesAndPledges.archivedAt} is null)`,
              ),
            ),
          )
      : [],
    householdIds.length
      ? db
          .select({ id: households.id })
          .from(households)
          .where(
            and(
              inArray(households.id, householdIds),
              isNull(households.archivedAt),
              or(
                sql`exists (select 1 from ${giftsAndPayments} where ${giftsAndPayments.householdId} = ${households.id} and ${giftsAndPayments.archivedAt} is null)`,
                sql`exists (select 1 from ${opportunitiesAndPledges} where ${opportunitiesAndPledges.householdId} = ${households.id} and ${opportunitiesAndPledges.archivedAt} is null)`,
              ),
            ),
          )
      : [],
  ]);
  const confirmedOrganizations = new Set(funders.map(({ id }) => id));
  const confirmedHouseholds = new Set(families.map(({ id }) => id));
  const peopleToLink = new Set(donors.map(({ id }) => id));
  for (const role of roles) {
    if (
      activePeople.has(role.personId) &&
      role.organizationId &&
      confirmedOrganizations.has(role.organizationId)
    ) {
      peopleToLink.add(role.personId);
    }
  }
  for (const contact of contacts) {
    if (contact.householdId && confirmedHouseholds.has(contact.householdId))
      peopleToLink.add(contact.id);
  }
  return {
    personIds: [...peopleToLink],
    organizationIds: [...confirmedOrganizations],
    householdIds: [...confirmedHouseholds],
  };
}

type CalendarMatch = {
  event: CalendarEvent | null;
  shareable: boolean;
  attendeeEmails: string[];
};

function isShareable(event: CalendarEvent, latest: GCalEvent | undefined) {
  const status = latest ? latest.status : event.status;
  const visibility = latest ? latest.visibility : event.googleVisibility;
  return (
    status === "confirmed" &&
    !event.isPrivate &&
    visibility !== "private" &&
    visibility !== "confidential"
  );
}

export async function findZoomCalendarEvents(
  ownerUserId: string,
  meetingId: string,
  start: Date,
  checkUnanchored = false,
): Promise<CalendarMatch[]> {
  const earliest = new Date(start.valueOf() - ZOOM_START_WINDOW_MS);
  const latest = new Date(start.valueOf() + ZOOM_START_WINDOW_MS);
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.calendarUserId, ownerUserId),
        gte(calendarEvents.startAt, earliest),
        lte(calendarEvents.startAt, latest),
      ),
    );
  if (!rows.length && !checkUnanchored) return [];
  const grant = await getValidGoogleAccessTokenForUser(ownerUserId);
  if (!grant) {
    return rows
      .filter(
        (event) =>
          zoomMeetingIdFromInvite(event.location, event.description) ===
          meetingId,
      )
      .map((event) => ({
        event,
        shareable: isShareable(event, undefined),
        attendeeEmails: event.attendeeEmails ?? [],
      }));
  }
  // Check the latest invitation and conference entry point. In particular,
  // Google Calendar add-ons can omit the Zoom link from the description.
  const source = await listEvents(grant.accessToken, "primary", {
    timeMin: earliest.toISOString(),
    timeMax: new Date(latest.valueOf() + 1).toISOString(),
    maxResults: 100,
    signal: AbortSignal.timeout(8_000),
  });
  if (source.nextPageToken)
    throw new Error("Too many calendar events to identify the Zoom meeting");
  const matches = source.items.filter(
    (event) =>
      event.start?.dateTime &&
      Date.parse(event.start.dateTime) >= earliest.valueOf() &&
      zoomMeetingIdFromInvite(
        event.location,
        event.description,
        ...(event.conferenceData?.entryPoints
          ?.filter((point) => point.entryPointType === "video")
          .map((point) => point.uri) ?? []),
      ) === meetingId,
  );
  // Keep a negative match for an unanchored event so a personal-room join
  // does not bypass a private or ambiguous invitation.
  return matches.map((latest) => {
    const event = rows.find((row) => row.gcalEventId === latest.id);
    if (!event) return { event: null, shareable: false, attendeeEmails: [] };
    return {
      event,
      shareable: isShareable(event, latest),
      attendeeEmails: (latest.attendees ?? []).flatMap((attendee) =>
        attendee.email &&
        !attendee.resource &&
        attendee.responseStatus !== "declined"
          ? [attendee.email]
          : [],
      ),
    };
  });
}
