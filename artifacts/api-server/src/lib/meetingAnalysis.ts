import type { MeetingArtifact } from "@workspace/db/schema";

export const FOLLOW_UP_RULES = `Reconcile every earlier offer against later conversation and the relevant email thread before proposing a task. An explicit later reference to material or a link in a pre-read that was sent supersedes an earlier offer to send the same material. The recipient not having read it does not make sending it outstanding. Keep a separate task only if there is a specific later request for a distinct missing deliverable or restored access. Do not bundle completed items into another deliverable. Capture the final concrete deliverable and never invent an owner or a date.`;

// The full text fits for ordinary calls. For unusually large combined
// sources, keep the beginning, a middle sample, and especially the close.
export function boundMeetingSource(text: string): string {
  if (text.length <= 240_000) return text;
  const middle = Math.floor((text.length - 60_000) / 2);
  const omission = "\n\n[Some meeting text omitted due to length]\n\n";
  return [
    text.slice(0, 60_000),
    text.slice(middle - 30_000, middle + 30_000),
    text.slice(-120_000),
  ].join(omission);
}

export function savedMeetingSource(note: {
  manualNotes?: string | null;
  rawTranscript?: string | null;
  artifacts?: MeetingArtifact[];
}): string {
  const transcript = note.rawTranscript?.trim() ?? "";
  return [
    note.manualNotes?.trim() ? `Staff notes:\n${note.manualNotes.trim()}` : "",
    transcript ? `Saved transcript:\n${transcript}` : "",
    ...(note.artifacts ?? []).flatMap((artifact) => {
      const source = artifact.transcript.trim();
      return source && !transcript.includes(source)
        ? [`${artifact.kind.replaceAll("_", " ")}:\n${source}`]
        : [];
    }),
  ].filter(Boolean).join("\n\n");
}

export interface MeetingLinks {
  personIds?: readonly string[];
  organizationIds?: readonly string[];
  householdIds?: readonly string[];
}

export async function meetingRelationshipContext(
  links: MeetingLinks,
  before: Date,
  noteId?: string,
  includeFollowUp = false,
): Promise<string> {
  const people = links.personIds ?? [];
  const organizations = links.organizationIds ?? [];
  const households = links.householdIds ?? [];
  if (!people.length && !organizations.length && !households.length) return "";

  const [{ db }, { emailMessages, interactions, meetingNotes, notes, opportunityFollowUps, opportunitiesAndPledges }, { and, asc, desc, eq, gte, isNull, lt, ne, or, sql }, { organizationActivityArrayScope }] = await Promise.all([
    import("@workspace/db"), import("@workspace/db/schema"), import("drizzle-orm"), import("./organizationActivityScope"),
  ]);
  const scope = (person: ReturnType<typeof sql>, organization: ReturnType<typeof sql>, household: ReturnType<typeof sql>) =>
    or(
      ...people.map((id) => sql`${person} @> ARRAY[${id}]::text[]`),
      ...organizations.map((id) => organizationActivityArrayScope(id, organization, person)),
      ...households.map((id) => sql`${household} @> ARRAY[${id}]::text[]`),
    );
  const [emails, meetings, loggedInteractions, staffNotes, recordedSharedItems] = await Promise.all([
    db.select({
      date: emailMessages.sentAt,
      id: emailMessages.id,
      mailbox: emailMessages.mailboxUserId,
      thread: emailMessages.gmailThreadId,
      direction: emailMessages.direction,
      from: emailMessages.fromEmail,
      subject: emailMessages.subject,
      excerpt: sql<string | null>`left(coalesce(nullif(${emailMessages.bodyText}, ''), ${emailMessages.aiSummary}, ${emailMessages.snippet}), 3200)`,
    }).from(emailMessages).where(and(
      eq(emailMessages.isPrivate, false),
      lt(emailMessages.sentAt, before),
      scope(sql`${emailMessages.matchedPersonIds}`, sql`${emailMessages.matchedOrganizationIds}`, sql`${emailMessages.matchedHouseholdIds}`),
    )).orderBy(desc(emailMessages.sentAt), emailMessages.id).limit(36),
    db.select({
      date: meetingNotes.meetingDate,
      title: meetingNotes.title,
      excerpt: sql<string | null>`left(concat_ws(E'\\n', ${meetingNotes.manualNotes}, ${meetingNotes.aiSummary}), 1500)`,
    }).from(meetingNotes).where(and(
      lt(meetingNotes.meetingDate, before),
      noteId ? ne(meetingNotes.id, noteId) : undefined,
      // A linked private calendar event is not shared relationship context.
      sql`not exists (select 1 from calendar_events ce
        where ce.id = ${meetingNotes.calendarEventId} and ce.is_private)`,
      scope(sql`${meetingNotes.personIds}`, sql`${meetingNotes.organizationIds}`, sql`${meetingNotes.householdIds}`),
    )).orderBy(desc(meetingNotes.meetingDate), meetingNotes.id).limit(5),
    db.select({
      date: interactions.occurredAt,
      title: interactions.summary,
      excerpt: sql<string | null>`left(${interactions.notes}, 1000)`,
    }).from(interactions).where(and(
      isNull(interactions.archivedAt),
      lt(interactions.occurredAt, before),
      scope(sql`${interactions.personIds}`, sql`${interactions.organizationIds}`, sql`${interactions.householdIds}`),
    )).orderBy(desc(interactions.occurredAt), interactions.id).limit(5),
    db.select({
      date: notes.createdAt,
      excerpt: sql<string>`left(${notes.body}, 1000)`,
    }).from(notes).where(and(
      isNull(notes.archivedAt),
      lt(notes.createdAt, before),
      sql`not exists (select 1 from calendar_events ce
        where ce.id = ${notes.calendarEventId} and ce.is_private)`,
      scope(sql`${notes.personIds}`, sql`${notes.organizationIds}`, sql`${notes.householdIds}`),
    )).orderBy(desc(notes.createdAt), notes.id).limit(5),
    db.select({
      title: opportunityFollowUps.title,
      sentOn: opportunityFollowUps.sentOn,
      readStatus: opportunityFollowUps.readStatus,
    }).from(opportunityFollowUps).innerJoin(opportunitiesAndPledges, eq(opportunitiesAndPledges.id, opportunityFollowUps.opportunityId))
      .where(and(eq(opportunityFollowUps.kind, "shared"), isNull(opportunitiesAndPledges.archivedAt),
        or(...people.map((id) => eq(opportunitiesAndPledges.individualGiverPersonId, id)),
          ...organizations.map((id) => eq(opportunitiesAndPledges.organizationId, id)),
          ...households.map((id) => eq(opportunitiesAndPledges.householdId, id)))))
      .orderBy(desc(opportunityFollowUps.updatedAt)).limit(12),
  ]);
  const seen = new Set<string>();
  const dedupe = (email: typeof emails[number]) => {
    const key = JSON.stringify([email.date.toISOString(), email.from, email.subject]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const sharedEmails = emails.filter(dedupe).slice(0, 12);
  const subjects = [...new Set(sharedEmails.flatMap(({ subject }) => subject?.replace(/^(?:(?:re|fwd?):\s*)+/i, "").trim().toLowerCase() || []))];
  const threads = sharedEmails.filter((item) => item.thread);
  const subsequent = includeFollowUp && (threads.length || subjects.length) ? await db.select({
    date: emailMessages.sentAt,
    id: emailMessages.id,
    mailbox: emailMessages.mailboxUserId,
    thread: emailMessages.gmailThreadId,
    direction: emailMessages.direction,
    from: emailMessages.fromEmail,
    subject: emailMessages.subject,
    excerpt: sql<string | null>`left(coalesce(nullif(${emailMessages.bodyText}, ''), ${emailMessages.aiSummary}, ${emailMessages.snippet}), 3200)`,
  }).from(emailMessages).where(and(
    eq(emailMessages.isPrivate, false),
    gte(emailMessages.sentAt, before),
    or(...threads.map((item) => and(eq(emailMessages.gmailThreadId, item.thread!), eq(emailMessages.mailboxUserId, item.mailbox))),
      subjects.length ? sql`lower(trim(regexp_replace(${emailMessages.subject}, '^(?:(?:re|fw|fwd):[[:space:]]*)+', '', 'i'))) in (${sql.join(subjects.map((s) => sql`${s}`), sql`, `)})` : undefined),
    scope(sql`${emailMessages.matchedPersonIds}`, sql`${emailMessages.matchedOrganizationIds}`, sql`${emailMessages.matchedHouseholdIds}`),
  )).orderBy(asc(emailMessages.sentAt), emailMessages.id).limit(24) : [];
  const subsequentThreadEmails = subsequent.filter(dedupe).slice(0, 8);
  if (!sharedEmails.length && !subsequentThreadEmails.length && !meetings.length && !loggedInteractions.length && !staffNotes.length && !recordedSharedItems.length) return "";
  const withoutMailbox = ({ mailbox: _mailbox, ...rest }: typeof emails[number]) => rest;
  return JSON.stringify({ sharedEmails: sharedEmails.map(withoutMailbox), subsequentThreadEmails: subsequentThreadEmails.map(withoutMailbox),
    priorMeetings: meetings, loggedInteractions, staffNotes, recordedSharedItems });
}
