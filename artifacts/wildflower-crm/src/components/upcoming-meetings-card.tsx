import { useMemo, useState } from "react";
import {
  useListCalendarEvents,
  useGetCurrentUser,
  getListCalendarEventsQueryKey,
  type CalendarEvent,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Calendar, Video, Circle, NotebookPen } from "lucide-react";
import { AddMeetingNoteDialog } from "@/components/meeting-notes-panel";

/**
 * Extract a join URL for the meeting. Wildflower mostly uses Zoom; we also
 * pick up Google Meet and Microsoft Teams links because they're embedded the
 * same way (no schema change needed — we read from `location` first, then
 * `description`, and grab the first matching URL).
 *
 * Returns `{ url, kind }` so the button label can read "Start Zoom" / "Start
 * Meet" / "Start Teams" based on what actually got matched.
 */
function extractJoinUrl(
  ev: Pick<CalendarEvent, "location" | "description">,
): { url: string; kind: "Zoom" | "Meet" | "Teams" } | null {
  const haystacks = [ev.location ?? "", ev.description ?? ""];
  const patterns: Array<{ kind: "Zoom" | "Meet" | "Teams"; re: RegExp }> = [
    { kind: "Zoom", re: /https?:\/\/[a-z0-9.-]*zoom(?:gov)?\.us\/[^\s<>"']+/i },
    { kind: "Meet", re: /https?:\/\/meet\.google\.com\/[^\s<>"']+/i },
    { kind: "Teams", re: /https?:\/\/teams\.microsoft\.com\/[^\s<>"']+/i },
  ];
  for (const text of haystacks) {
    for (const { kind, re } of patterns) {
      const m = text.match(re);
      if (m) {
        // Strip trailing punctuation that often follows a URL in prose.
        const url = m[0].replace(/[)\].,;!?]+$/, "");
        return { url, kind };
      }
    }
  }
  return null;
}

function formatWhen(startIso: string, endIso?: string | null) {
  const start = new Date(startIso);
  const end = endIso ? new Date(endIso) : null;
  const dayFmt = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const day = dayFmt.format(start);
  const startT = timeFmt.format(start);
  const endT = end ? timeFmt.format(end) : null;
  return endT ? `${day} · ${startT}–${endT}` : `${day} · ${startT}`;
}

/**
 * Dashboard widget: shows the caller's calendar events for the next 7 days
 * (scoped via `calendarUserId = me.id`, which is how the synced events are
 * keyed). Each row has four actions:
 *   - Open in Google Calendar (htmlLink deep-link)
 *   - Start Zoom/Meet/Teams (parsed from location/description)
 *   - Record (disabled placeholder — desktop integration TBD)
 *   - Notes (opens the AddMeetingNoteDialog prefilled from the event)
 */
export default function UpcomingMeetingsCard() {
  const { data: me } = useGetCurrentUser();
  const userId = me?.id;

  // Compute the 7-day window once per render. The query key includes
  // startBefore so react-query will refetch naturally as the window slides
  // (re-mounts on navigation produce a fresh window).
  const { startAfter, startBefore } = useMemo(() => {
    const now = new Date();
    const week = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return { startAfter: now.toISOString(), startBefore: week.toISOString() };
  }, []);

  const params = userId
    ? {
        calendarUserId: userId,
        startAfter,
        startBefore,
        order: "asc" as const,
        limit: 20,
      }
    : undefined;

  const { data, isLoading, isError } = useListCalendarEvents(params ?? {}, {
    query: {
      enabled: !!userId,
      queryKey: getListCalendarEventsQueryKey(params),
    },
  });

  const events = (data?.data ?? []).filter(
    (ev) => ev.status !== "cancelled",
  );

  return (
    <Card data-testid="card-upcoming-meetings">
      <CardHeader>
        <CardTitle className="text-lg">My upcoming meetings</CardTitle>
      </CardHeader>
      <CardContent>
        {!userId || isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">
            Couldn't load your calendar.
          </p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing scheduled in the next 7 days.
          </p>
        ) : (
          <ul className="space-y-2">
            {events.map((ev) => (
              <UpcomingMeetingRow key={ev.id} ev={ev} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function UpcomingMeetingRow({ ev }: { ev: CalendarEvent }) {
  const [notesOpen, setNotesOpen] = useState(false);
  const join = extractJoinUrl(ev);
  const title = ev.summary?.trim() || "(no title)";

  // Prefill for the meeting-notes dialog: title from summary, meetingDate as
  // <input type="datetime-local"> value (local time, no TZ suffix), attendees
  // as a comma-joined string of the synced attendee emails.
  const prefill = useMemo(() => {
    const start = new Date(ev.startAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    const meetingDate = `${start.getFullYear()}-${pad(
      start.getMonth() + 1,
    )}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(
      start.getMinutes(),
    )}`;
    return {
      title,
      meetingDate,
      attendees: (ev.attendeeEmails ?? []).join(", "),
    };
  }, [ev.startAt, ev.attendeeEmails, title]);

  return (
    <li
      className="flex items-center justify-between gap-3 text-sm border rounded-md p-2"
      data-testid={`upcoming-meeting-${ev.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{title}</div>
        <div className="text-xs text-muted-foreground">
          {formatWhen(ev.startAt, ev.endAt)}
        </div>
      </div>
      <TooltipProvider delayDuration={200}>
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              {ev.htmlLink ? (
                <Button
                  asChild
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0"
                  data-testid={`button-open-gcal-${ev.id}`}
                >
                  <a
                    href={ev.htmlLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open in Google Calendar"
                  >
                    <Calendar className="h-4 w-4" />
                  </a>
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0"
                  disabled
                  aria-label="No Google Calendar link available"
                  data-testid={`button-open-gcal-${ev.id}`}
                >
                  <Calendar className="h-4 w-4" />
                </Button>
              )}
            </TooltipTrigger>
            <TooltipContent>
              {ev.htmlLink
                ? "Open in Google Calendar"
                : "No Google Calendar link available"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              {join ? (
                <Button
                  asChild
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0"
                  data-testid={`button-join-${ev.id}`}
                >
                  <a
                    href={join.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Start ${join.kind}`}
                  >
                    <Video className="h-4 w-4" />
                  </a>
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0"
                  disabled
                  aria-label="No video link found"
                  data-testid={`button-join-${ev.id}`}
                >
                  <Video className="h-4 w-4" />
                </Button>
              )}
            </TooltipTrigger>
            <TooltipContent>
              {join ? `Start ${join.kind}` : "No video link on this event"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                disabled
                aria-label="Record meeting (coming soon)"
                data-testid={`button-record-${ev.id}`}
              >
                <Circle className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Record meeting (coming soon)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                onClick={() => setNotesOpen(true)}
                aria-label="Open meeting notes"
                data-testid={`button-notes-${ev.id}`}
              >
                <NotebookPen className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open meeting notes</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
      {/*
        Dialog is rendered (mounted) per row but controlled via `open`, so it
        only actually appears when the user clicks the notes button. The
        dialog is unpinned — the user picks the contact via the in-dialog
        picker (an event can match 0..N people/funders/households).
      */}
      <AddMeetingNoteDialog
        unpinned
        open={notesOpen}
        onOpenChange={setNotesOpen}
        prefill={prefill}
        trigger={<span style={{ display: "none" }} />}
      />
    </li>
  );
}
