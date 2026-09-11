import { calendarEvents } from "@workspace/db/schema";
import { getTableColumns, or, eq, sql, type SQL } from "drizzle-orm";

export function calendarEventVisibleToCaller(callerId: string): SQL {
  return or(
    eq(calendarEvents.isPrivate, false),
    eq(calendarEvents.calendarUserId, callerId),
  )!;
}

/**
 * Stable key for one physical meeting.
 *
 * A Google id is shared by copies synced into different staff calendars, but
 * some historical/imported rows carry an empty id. Empty ids must NEVER be
 * treated as equal: doing so makes every such calendar row look like the same
 * meeting. Those rows deliberately fall back to their CRM row id instead.
 */
export function calendarEventPhysicalKeySql(): SQL<string> {
  return sql<string>`CASE
    WHEN NULLIF(BTRIM(${calendarEvents.gcalEventId}), '') IS NOT NULL
      THEN BTRIM(${calendarEvents.gcalEventId})
    ELSE 'crm:' || ${calendarEvents.id}
  END`;
}

export function calendarEventDismissalKey(event: {
  id: string;
  gcalEventId: string;
}): string {
  const googleId = event.gcalEventId.trim();
  return googleId || `crm:${event.id}`;
}

/** Shared calendar-event response projection, including note-derived facts. */
export function calendarEventSelection() {
  // `linked_ce.id = current.id` preserves an exact CRM link. Cross-mailbox
  // copies match only when BOTH sides have the same non-empty Google id.
  // This predicate is intentionally shared by all four note-derived fields.
  const linkedEventMatchesCurrent = sql`(
    linked_ce.id = ${calendarEvents.id}
    OR (
      NULLIF(BTRIM(${calendarEvents.gcalEventId}), '') IS NOT NULL
      AND NULLIF(BTRIM(linked_ce.gcal_event_id), '') = NULLIF(BTRIM(${calendarEvents.gcalEventId}), '')
    )
  )`;

  return {
    ...getTableColumns(calendarEvents),
    meetingNoteId: sql<string | null>`(
      select mn.id
      from meeting_notes mn
      join calendar_events linked_ce on linked_ce.id = mn.calendar_event_id
      where ${linkedEventMatchesCurrent}
      order by mn.meeting_date desc
      limit 1
    )`.as("meetingNoteId"),
    linkedNoteCount: sql<number>`(
      select count(*)::int
      from notes n
      join calendar_events linked_ce on linked_ce.id = n.calendar_event_id
      where ${linkedEventMatchesCurrent}
    )`.as("linkedNoteCount"),
    hasMeetingNotes: sql<boolean>`(
      exists (
        select 1
        from meeting_notes mn
        join calendar_events linked_ce on linked_ce.id = mn.calendar_event_id
        where ${linkedEventMatchesCurrent}
      ) or exists (
        select 1
        from notes n
        join calendar_events linked_ce on linked_ce.id = n.calendar_event_id
        where ${linkedEventMatchesCurrent}
      )
    )`.as("hasMeetingNotes"),
    hasNextSteps: sql<boolean>`exists (
      select 1
      from meeting_notes mn
      join calendar_events linked_ce on linked_ce.id = mn.calendar_event_id
      where ${linkedEventMatchesCurrent}
        and jsonb_typeof(mn.action_items) = 'array'
        and jsonb_array_length(mn.action_items) > 0
    )`.as("hasNextSteps"),
  };
}
