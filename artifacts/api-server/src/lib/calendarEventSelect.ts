import { calendarEvents } from "@workspace/db/schema";
import { getTableColumns, or, eq, sql, type SQL } from "drizzle-orm";

export function calendarEventVisibleToCaller(callerId: string): SQL {
  return or(
    eq(calendarEvents.isPrivate, false),
    eq(calendarEvents.calendarUserId, callerId),
  )!;
}

/** Shared calendar-event response projection, including note-derived facts. */
export function calendarEventSelection() {
  return {
    ...getTableColumns(calendarEvents),
    meetingNoteId: sql<string | null>`(
      select mn.id
      from meeting_notes mn
      join calendar_events linked_ce on linked_ce.id = mn.calendar_event_id
      where linked_ce.gcal_event_id = ${calendarEvents.gcalEventId}
      order by mn.meeting_date desc
      limit 1
    )`.as("meetingNoteId"),
    linkedNoteCount: sql<number>`(
      select count(*)::int
      from notes n
      join calendar_events linked_ce on linked_ce.id = n.calendar_event_id
      where linked_ce.gcal_event_id = ${calendarEvents.gcalEventId}
    )`.as("linkedNoteCount"),
    hasMeetingNotes: sql<boolean>`(
      exists (
        select 1
        from meeting_notes mn
        join calendar_events linked_ce on linked_ce.id = mn.calendar_event_id
        where linked_ce.gcal_event_id = ${calendarEvents.gcalEventId}
      ) or exists (
        select 1
        from notes n
        join calendar_events linked_ce on linked_ce.id = n.calendar_event_id
        where linked_ce.gcal_event_id = ${calendarEvents.gcalEventId}
      )
    )`.as("hasMeetingNotes"),
    hasNextSteps: sql<boolean>`exists (
      select 1
      from meeting_notes mn
      join calendar_events linked_ce on linked_ce.id = mn.calendar_event_id
      where linked_ce.gcal_event_id = ${calendarEvents.gcalEventId}
        and jsonb_typeof(mn.action_items) = 'array'
        and jsonb_array_length(mn.action_items) > 0
    )`.as("hasNextSteps"),
  };
}
