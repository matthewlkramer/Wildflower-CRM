import { db } from "@workspace/db";
import {
  people,
  organizations,
  giftsAndPayments,
  opportunitiesAndPledges,
  notes,
  meetingNotes,
  calendarEvents,
  mediaMentions,
  emailMessages,
} from "@workspace/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

/**
 * Read-only relationship snapshot for a single CRM entity (a person or an
 * organization). This is the raw signal bundle the task-intelligence AI
 * reasons over to draft a next-step cultivation task. It is stored on the
 * proposal's `payload` so the rationale stays auditable after the
 * underlying data changes.
 */
export interface TaskSignals {
  entity: {
    kind: "person" | "organization";
    id: string;
    name: string | null;
    priority: string | null;
    capacityRating: string | null;
    connectionStatus: string | null;
    enthusiasm: string | null;
    lastContacted: string | null;
    interactionCount: number | null;
    tags: string | null;
    /** issuesGrants flag for orgs; always false for people. */
    issuesGrants: boolean;
  };
  recentGifts: Array<{
    date: string | null;
    amount: string | null;
    type: string | null;
    name: string | null;
  }>;
  openOpportunities: Array<{
    name: string | null;
    status: string | null;
    stage: string | null;
    askAmount: string | null;
    awardedAmount: string | null;
    projectedCloseDate: string | null;
    applicationDeadline: string | null;
  }>;
  recentNotes: Array<{ date: string | null; body: string }>;
  recentMeetings: Array<{
    date: string | null;
    title: string | null;
    summary: string | null;
  }>;
  recentCalendarEvents: Array<{
    date: string | null;
    summary: string | null;
  }>;
  recentEmails: Array<{ date: string | null; subject: string | null }>;
  recentMediaMentions: Array<{
    date: string | null;
    publication: string;
    title: string | null;
  }>;
}

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d);

/**
 * Load the read-only signal bundle for a person. Caps each list so the
 * prompt stays bounded.
 */
async function gatherPersonSignals(personId: string): Promise<TaskSignals | null> {
  const [p] = await db
    .select()
    .from(people)
    .where(eq(people.id, personId))
    .limit(1);
  if (!p) return null;

  const [gifts, opps, noteRows, meetingRows, calRows, emailRows, mediaRows] =
    await Promise.all([
      db
        .select({
          date: giftsAndPayments.dateReceived,
          amount: giftsAndPayments.amount,
          type: giftsAndPayments.type,
          name: giftsAndPayments.name,
        })
        .from(giftsAndPayments)
        .where(eq(giftsAndPayments.individualGiverPersonId, personId))
        .orderBy(sql`${giftsAndPayments.dateReceived} DESC NULLS LAST`)
        .limit(5),
      db
        .select({
          name: opportunitiesAndPledges.name,
          status: opportunitiesAndPledges.status,
          stage: opportunitiesAndPledges.stage,
          askAmount: opportunitiesAndPledges.askAmount,
          awardedAmount: opportunitiesAndPledges.awardedAmount,
          projectedCloseDate: opportunitiesAndPledges.projectedCloseDate,
          applicationDeadline: opportunitiesAndPledges.applicationDeadline,
        })
        .from(opportunitiesAndPledges)
        .where(
          and(
            eq(opportunitiesAndPledges.individualGiverPersonId, personId),
            inArray(opportunitiesAndPledges.status, ["open", "pledge", "cash_in"]),
          ),
        )
        .orderBy(sql`${opportunitiesAndPledges.projectedCloseDate} ASC NULLS LAST`)
        .limit(5),
      db
        .select({ date: notes.createdAt, body: notes.body })
        .from(notes)
        .where(sql`${notes.personIds} @> ARRAY[${personId}]::text[]`)
        .orderBy(desc(notes.createdAt))
        .limit(3),
      db
        .select({
          date: meetingNotes.meetingDate,
          title: meetingNotes.title,
          summary: meetingNotes.aiSummary,
        })
        .from(meetingNotes)
        .where(eq(meetingNotes.personId, personId))
        .orderBy(desc(meetingNotes.meetingDate))
        .limit(2),
      db
        .select({ date: calendarEvents.startAt, summary: calendarEvents.summary })
        .from(calendarEvents)
        .where(sql`${calendarEvents.matchedPersonIds} @> ARRAY[${personId}]::text[]`)
        .orderBy(desc(calendarEvents.startAt))
        .limit(3),
      db
        .select({ date: emailMessages.sentAt, subject: emailMessages.subject })
        .from(emailMessages)
        .where(sql`${emailMessages.matchedPersonIds} @> ARRAY[${personId}]::text[]`)
        .orderBy(desc(emailMessages.sentAt))
        .limit(3),
      db
        .select({
          date: mediaMentions.publicationDate,
          publication: mediaMentions.publicationName,
          title: mediaMentions.title,
        })
        .from(mediaMentions)
        .where(sql`${mediaMentions.personIds} @> ARRAY[${personId}]::text[]`)
        .orderBy(sql`${mediaMentions.publicationDate} DESC NULLS LAST`)
        .limit(3),
    ]);

  return {
    entity: {
      kind: "person",
      id: p.id,
      name: p.fullName,
      priority: p.priority,
      capacityRating: p.capacityRating,
      connectionStatus: p.connectionStatus,
      enthusiasm: p.enthusiasm,
      lastContacted: iso(p.lastContacted),
      interactionCount: p.interactionCount,
      tags: p.tags,
      issuesGrants: false,
    },
    recentGifts: gifts.map((g) => ({
      date: iso(g.date),
      amount: g.amount,
      type: g.type,
      name: g.name,
    })),
    openOpportunities: opps.map((o) => ({
      name: o.name,
      status: o.status,
      stage: o.stage,
      askAmount: o.askAmount,
      awardedAmount: o.awardedAmount,
      projectedCloseDate: iso(o.projectedCloseDate),
      applicationDeadline: iso(o.applicationDeadline),
    })),
    recentNotes: noteRows.map((n) => ({
      date: iso(n.date),
      body: n.body.slice(0, 600),
    })),
    recentMeetings: meetingRows.map((m) => ({
      date: iso(m.date),
      title: m.title,
      summary: m.summary ? m.summary.slice(0, 600) : null,
    })),
    recentCalendarEvents: calRows.map((c) => ({
      date: iso(c.date),
      summary: c.summary,
    })),
    recentEmails: emailRows.map((e) => ({
      date: iso(e.date as Date | null),
      subject: e.subject as string | null,
    })),
    recentMediaMentions: mediaRows.map((m) => ({
      date: iso(m.date),
      publication: m.publication,
      title: m.title,
    })),
  };
}

/**
 * Load the read-only signal bundle for an organization. Same shape as the
 * person path but keyed off the org-side donor / match columns.
 */
async function gatherOrganizationSignals(
  organizationId: string,
): Promise<TaskSignals | null> {
  const [o] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!o) return null;

  const [gifts, opps, noteRows, meetingRows, calRows, emailRows, mediaRows] =
    await Promise.all([
      db
        .select({
          date: giftsAndPayments.dateReceived,
          amount: giftsAndPayments.amount,
          type: giftsAndPayments.type,
          name: giftsAndPayments.name,
        })
        .from(giftsAndPayments)
        .where(eq(giftsAndPayments.organizationId, organizationId))
        .orderBy(sql`${giftsAndPayments.dateReceived} DESC NULLS LAST`)
        .limit(5),
      db
        .select({
          name: opportunitiesAndPledges.name,
          status: opportunitiesAndPledges.status,
          stage: opportunitiesAndPledges.stage,
          askAmount: opportunitiesAndPledges.askAmount,
          awardedAmount: opportunitiesAndPledges.awardedAmount,
          projectedCloseDate: opportunitiesAndPledges.projectedCloseDate,
          applicationDeadline: opportunitiesAndPledges.applicationDeadline,
        })
        .from(opportunitiesAndPledges)
        .where(
          and(
            eq(opportunitiesAndPledges.organizationId, organizationId),
            inArray(opportunitiesAndPledges.status, ["open", "pledge", "cash_in"]),
          ),
        )
        .orderBy(sql`${opportunitiesAndPledges.projectedCloseDate} ASC NULLS LAST`)
        .limit(5),
      db
        .select({ date: notes.createdAt, body: notes.body })
        .from(notes)
        .where(sql`${notes.organizationIds} @> ARRAY[${organizationId}]::text[]`)
        .orderBy(desc(notes.createdAt))
        .limit(3),
      db
        .select({
          date: meetingNotes.meetingDate,
          title: meetingNotes.title,
          summary: meetingNotes.aiSummary,
        })
        .from(meetingNotes)
        .where(eq(meetingNotes.organizationId, organizationId))
        .orderBy(desc(meetingNotes.meetingDate))
        .limit(2),
      db
        .select({ date: calendarEvents.startAt, summary: calendarEvents.summary })
        .from(calendarEvents)
        .where(
          sql`${calendarEvents.matchedOrganizationIds} @> ARRAY[${organizationId}]::text[]`,
        )
        .orderBy(desc(calendarEvents.startAt))
        .limit(3),
      db
        .select({ date: emailMessages.sentAt, subject: emailMessages.subject })
        .from(emailMessages)
        .where(
          sql`${emailMessages.matchedOrganizationIds} @> ARRAY[${organizationId}]::text[]`,
        )
        .orderBy(desc(emailMessages.sentAt))
        .limit(3),
      db
        .select({
          date: mediaMentions.publicationDate,
          publication: mediaMentions.publicationName,
          title: mediaMentions.title,
        })
        .from(mediaMentions)
        .where(
          sql`${mediaMentions.organizationIds} @> ARRAY[${organizationId}]::text[]`,
        )
        .orderBy(sql`${mediaMentions.publicationDate} DESC NULLS LAST`)
        .limit(3),
    ]);

  return {
    entity: {
      kind: "organization",
      id: o.id,
      name: o.name,
      priority: o.priority,
      capacityRating: o.capacityRating,
      connectionStatus: o.connectionStatus,
      enthusiasm: o.enthusiasm,
      lastContacted: iso(o.lastContacted),
      interactionCount: o.interactionCount,
      tags: o.tags,
      issuesGrants: o.issuesGrants,
    },
    recentGifts: gifts.map((g) => ({
      date: iso(g.date),
      amount: g.amount,
      type: g.type,
      name: g.name,
    })),
    openOpportunities: opps.map((o2) => ({
      name: o2.name,
      status: o2.status,
      stage: o2.stage,
      askAmount: o2.askAmount,
      awardedAmount: o2.awardedAmount,
      projectedCloseDate: iso(o2.projectedCloseDate),
      applicationDeadline: iso(o2.applicationDeadline),
    })),
    recentNotes: noteRows.map((n) => ({
      date: iso(n.date),
      body: n.body.slice(0, 600),
    })),
    recentMeetings: meetingRows.map((m) => ({
      date: iso(m.date),
      title: m.title,
      summary: m.summary ? m.summary.slice(0, 600) : null,
    })),
    recentCalendarEvents: calRows.map((c) => ({
      date: iso(c.date),
      summary: c.summary,
    })),
    recentEmails: emailRows.map((e) => ({
      date: iso(e.date as Date | null),
      subject: e.subject as string | null,
    })),
    recentMediaMentions: mediaRows.map((m) => ({
      date: iso(m.date),
      publication: m.publication,
      title: m.title,
    })),
  };
}

/**
 * Entry point: gather the signal bundle for whichever entity is set.
 * Exactly one of personId / organizationId should be provided.
 */
export async function gatherTaskSignals(args: {
  personId?: string | null;
  organizationId?: string | null;
}): Promise<TaskSignals | null> {
  if (args.personId) return gatherPersonSignals(args.personId);
  if (args.organizationId) return gatherOrganizationSignals(args.organizationId);
  return null;
}
