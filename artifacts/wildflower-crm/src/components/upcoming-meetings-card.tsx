import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  getListCalendarEventsQueryKey,
  type CalendarEvent,
  useGetCurrentUser,
  useListCalendarEvents,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DashboardScopeToggle,
  type DashboardScope,
} from "@/components/dashboard-scope-toggle";
import { useUserNameMap } from "@/components/user-picker";
import { Calendar, NotebookPen, Video } from "lucide-react";

function extractJoinUrl(
  event: Pick<CalendarEvent, "location" | "description">,
): { url: string; kind: "Zoom" | "Meet" | "Teams" } | null {
  const haystacks = [event.location ?? "", event.description ?? ""];
  const patterns: Array<{
    kind: "Zoom" | "Meet" | "Teams";
    pattern: RegExp;
  }> = [
    {
      kind: "Zoom",
      pattern: /https?:\/\/[a-z0-9.-]*zoom(?:gov)?\.us\/[^\s<>"']+/i,
    },
    { kind: "Meet", pattern: /https?:\/\/meet\.google\.com\/[^\s<>"']+/i },
    {
      kind: "Teams",
      pattern: /https?:\/\/teams\.microsoft\.com\/[^\s<>"']+/i,
    },
  ];
  for (const text of haystacks) {
    for (const { kind, pattern } of patterns) {
      const match = text.match(pattern);
      if (match) {
        return {
          url: match[0].replace(/[)\].,;!?]+$/, ""),
          kind,
        };
      }
    }
  }
  return null;
}

function formatWhen(startIso: string, endIso?: string | null) {
  const start = new Date(startIso);
  const end = endIso ? new Date(endIso) : null;
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(start);
  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const startTime = timeFormatter.format(start);
  const endTime = end ? timeFormatter.format(end) : null;
  return endTime ? `${day} · ${startTime}–${endTime}` : `${day} · ${startTime}`;
}

function useWeekWindow() {
  return useMemo(() => {
    const now = new Date();
    const week = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return { startAfter: now.toISOString(), startBefore: week.toISOString() };
  }, []);
}

export default function UpcomingMeetingsCard() {
  const [scope, setScope] = useState<DashboardScope>("mine");
  const { data: currentUser } = useGetCurrentUser();
  const userId = currentUser?.id;
  const userNames = useUserNameMap();
  const { startAfter, startBefore } = useWeekWindow();
  const myParams = userId
    ? {
        calendarUserId: userId,
        startAfter,
        startBefore,
        order: "asc" as const,
        limit: 20,
      }
    : undefined;
  const teamParams = {
    startAfter,
    startBefore,
    order: "asc" as const,
    limit: 50,
  };
  const myQuery = useListCalendarEvents(myParams ?? {}, {
    query: {
      enabled: scope === "mine" && Boolean(userId),
      queryKey: getListCalendarEventsQueryKey(myParams),
    },
  });
  const teamQuery = useListCalendarEvents(teamParams, {
    query: {
      enabled: scope === "team",
      queryKey: getListCalendarEventsQueryKey(teamParams),
    },
  });
  const activeQuery = scope === "mine" ? myQuery : teamQuery;
  const events = (activeQuery.data?.data ?? []).filter(
    (event) => event.status !== "cancelled",
  );

  return (
    <Card data-testid="card-upcoming-meetings">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-lg">Upcoming meetings</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Calendar meetings scheduled during the next seven days.
          </p>
        </div>
        <DashboardScopeToggle
          value={scope}
          onValueChange={setScope}
          testId="meetings-scope-toggle"
        />
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-48 pl-6">When</TableHead>
              <TableHead>Meeting</TableHead>
              <TableHead className="w-44">Owner</TableHead>
              <TableHead className="w-32 pr-6 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {activeQuery.isLoading || (scope === "mine" && !userId) ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-8 text-center text-muted-foreground"
                >
                  Loading meetings…
                </TableCell>
              </TableRow>
            ) : activeQuery.isError ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-8 text-center text-muted-foreground"
                >
                  Couldn't load {scope === "mine" ? "your" : "the team"}{" "}
                  calendar.
                </TableCell>
              </TableRow>
            ) : events.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-8 text-center text-muted-foreground"
                >
                  Nothing scheduled{" "}
                  {scope === "mine" ? "for you" : "for the team"} in the next
                  seven days.
                </TableCell>
              </TableRow>
            ) : (
              events.map((event) => (
                <TableRow
                  key={event.id}
                  data-testid={`upcoming-meeting-${event.id}`}
                >
                  <TableCell className="pl-6 text-sm text-muted-foreground">
                    {formatWhen(event.startAt, event.endAt)}
                  </TableCell>
                  <TableCell className="font-medium">
                    {event.summary?.trim() || "(no title)"}
                  </TableCell>
                  <TableCell>
                    {userNames.get(event.calendarUserId) ??
                      (event.calendarUserId === userId ? "Me" : "—")}
                  </TableCell>
                  <TableCell className="pr-6">
                    <MeetingActions event={event} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function MeetingActions({ event }: { event: CalendarEvent }) {
  const join = extractJoinUrl(event);
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center justify-end gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            {event.htmlLink ? (
              <Button
                asChild
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                data-testid={`button-open-gcal-${event.id}`}
              >
                <a
                  href={event.htmlLink}
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
                data-testid={`button-open-gcal-${event.id}`}
              >
                <Calendar className="h-4 w-4" />
              </Button>
            )}
          </TooltipTrigger>
          <TooltipContent>
            {event.htmlLink
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
                data-testid={`button-join-${event.id}`}
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
                data-testid={`button-join-${event.id}`}
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
              asChild
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0"
              data-testid={`button-notes-${event.id}`}
            >
              <Link
                href={`/meetings/${event.id}`}
                aria-label="Open meeting workspace"
              >
                <NotebookPen className="h-4 w-4" />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open meeting workspace</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
