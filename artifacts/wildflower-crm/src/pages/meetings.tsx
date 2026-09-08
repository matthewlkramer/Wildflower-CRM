import { useMemo, useState } from "react";
import {
  getListCalendarEventsQueryKey,
  getGetMeetingNoteQueryKey,
  getListNotesQueryKey,
  useGetMeetingNote,
  useListCalendarEvents,
  useListNotes,
  useListUsers,
  type CalendarEvent,
} from "@workspace/api-client-react";
import {
  AddMeetingNoteDialog,
  MeetingNoteRow,
} from "@/components/meeting-notes-panel";
import { userDisplayName, useUserNameMap } from "@/components/user-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle,
  CalendarCheck2,
  CheckCircle2,
  ExternalLink,
  NotebookPen,
  StickyNote,
} from "lucide-react";

function localInputDate(value: string): string {
  const date = new Date(value);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function meetingDate(event: CalendarEvent): string {
  const start = new Date(event.startAt);
  const end = event.endAt ? new Date(event.endAt) : null;
  const date = start.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const startTime = start.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const endTime = end?.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} · ${startTime}${endTime ? `–${endTime}` : ""}`;
}

function StatusBadge({
  event,
  future,
}: {
  event: CalendarEvent;
  future: boolean;
}) {
  if (event.hasMeetingNotes && event.hasNextSteps) {
    return (
      <Badge className="gap-1 bg-emerald-700">
        <CheckCircle2 className="h-3 w-3" /> Notes + next steps
      </Badge>
    );
  }
  if (event.hasMeetingNotes) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-amber-400 text-amber-700 dark:text-amber-300"
      >
        <AlertTriangle className="h-3 w-3" /> Next steps missing
      </Badge>
    );
  }
  if (future) return <Badge variant="secondary">Upcoming</Badge>;
  return (
    <Badge variant="destructive" className="gap-1">
      <AlertTriangle className="h-3 w-3" /> Notes missing
    </Badge>
  );
}

function ExistingNoteDialog({
  eventId,
  noteId,
  open,
  onOpenChange,
}: {
  eventId: string;
  noteId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const userMap = useUserNameMap();
  const note = useGetMeetingNote(noteId ?? "", {
    query: {
      enabled: open && Boolean(noteId),
      queryKey: getGetMeetingNoteQueryKey(noteId ?? ""),
    },
  });
  const linkedNotes = useListNotes(
    { calendarEventId: eventId, limit: 100 },
    {
      query: {
        enabled: open,
        queryKey: getListNotesQueryKey({ calendarEventId: eventId, limit: 100 }),
      },
    },
  );
  const loading = (Boolean(noteId) && note.isLoading) || linkedNotes.isLoading;
  const freeFormNotes = linkedNotes.data?.data ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Meeting notes and next steps</DialogTitle>
          <DialogDescription>
            Review structured meeting notes, next steps, and free-form CRM notes
            linked to this meeting.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading notes…</p>
        ) : note.data || freeFormNotes.length > 0 ? (
          <div className="space-y-3">
            {note.data ? (
              <ul>
                <MeetingNoteRow note={note.data} />
              </ul>
            ) : null}
            {freeFormNotes.map((linkedNote) => (
              <div
                key={linkedNote.id}
                className="space-y-2 rounded-md border p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StickyNote className="h-3.5 w-3.5 text-primary" />
                  <Badge variant="secondary">CRM note</Badge>
                  <span className="text-xs text-muted-foreground">
                    {userMap.get(linkedNote.authorUserId) ??
                      linkedNote.authorUserId} · {meetingDateFromIso(linkedNote.createdAt)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap">{linkedNote.body}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-destructive">
            The linked meeting note could not be loaded.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function meetingDateFromIso(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function MeetingRow({
  event,
  future,
  ownerName,
}: {
  event: CalendarEvent;
  future: boolean;
  ownerName: string;
}) {
  const [notesOpen, setNotesOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const title = event.summary?.trim() || "(no title)";
  const prefill = useMemo(
    () => ({
      title,
      meetingDate: localInputDate(event.startAt),
      attendees: (event.attendeeEmails ?? []).join(", "),
      calendarEventId: event.id,
    }),
    [event.attendeeEmails, event.id, event.startAt, title],
  );

  return (
    <div className="flex flex-col gap-3 border-b px-4 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{title}</h3>
          <StatusBadge event={event} future={future} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {meetingDate(event)} · {ownerName}
        </p>
        {event.location ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {event.location}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {event.htmlLink ? (
          <Button asChild variant="outline" size="sm">
            <a href={event.htmlLink} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-1 h-3.5 w-3.5" /> Calendar
            </a>
          </Button>
        ) : null}
        {!event.hasMeetingNotes ? (
          <Button size="sm" onClick={() => setNotesOpen(true)}>
            <NotebookPen className="mr-1 h-3.5 w-3.5" /> Add notes
          </Button>
        ) : (
          <Button size="sm" onClick={() => setReviewOpen(true)}>
            <NotebookPen className="mr-1 h-3.5 w-3.5" /> Review notes
          </Button>
        )}
      </div>
      <AddMeetingNoteDialog
        unpinned
        open={notesOpen}
        onOpenChange={setNotesOpen}
        prefill={prefill}
        trigger={<span className="hidden" />}
      />
      {event.hasMeetingNotes ? (
        <ExistingNoteDialog
          eventId={event.id}
          noteId={event.meetingNoteId}
          open={reviewOpen}
          onOpenChange={setReviewOpen}
        />
      ) : null}
    </div>
  );
}

export default function MeetingsPage() {
  const [tab, setTab] = useState("history");
  const [search, setSearch] = useState("");
  const [ownerId, setOwnerId] = useState("all");
  const now = useMemo(() => new Date().toISOString(), []);
  const { data: users } = useListUsers();
  const userNames = useMemo(
    () =>
      new Map((users ?? []).map((user) => [user.id, userDisplayName(user)])),
    [users],
  );
  const shared = {
    search: search.trim() || undefined,
    calendarUserId: ownerId === "all" ? undefined : ownerId,
    limit: 500,
  };
  const future = useListCalendarEvents(
    { ...shared, startAfter: now, order: "asc" },
    {
      query: {
        queryKey: getListCalendarEventsQueryKey({
          ...shared,
          startAfter: now,
          order: "asc",
        }),
      },
    },
  );
  const history = useListCalendarEvents(
    { ...shared, startBefore: now, order: "desc" },
    {
      query: {
        queryKey: getListCalendarEventsQueryKey({
          ...shared,
          startBefore: now,
          order: "desc",
        }),
      },
    },
  );
  const futureRows = (future.data?.data ?? []).filter(
    (event) => event.status !== "cancelled",
  );
  const historyRows = (history.data?.data ?? []).filter(
    (event) => event.status !== "cancelled",
  );
  const missingNotes = historyRows.filter(
    (event) => !event.hasMeetingNotes,
  ).length;
  const missingNextSteps = historyRows.filter(
    (event) => event.hasMeetingNotes && !event.hasNextSteps,
  ).length;

  const rows = tab === "future" ? futureRows : historyRows;
  const loading = tab === "future" ? future.isLoading : history.isLoading;
  const failed = tab === "future" ? future.isError : history.isError;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <CalendarCheck2 className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-3xl font-serif font-bold">Meetings</h1>
          <p className="text-sm text-muted-foreground">
            Upcoming and past meetings, with follow-up gaps called out clearly.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-5">
            <div className="text-xs uppercase text-muted-foreground">
              Upcoming
            </div>
            <div className="mt-1 text-2xl font-semibold">
              {futureRows.length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="text-xs uppercase text-muted-foreground">
              Past meetings missing notes
            </div>
            <div className="mt-1 text-2xl font-semibold text-destructive">
              {missingNotes}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="text-xs uppercase text-muted-foreground">
              Missing next steps
            </div>
            <div className="mt-1 text-2xl font-semibold text-amber-700 dark:text-amber-300">
              {missingNextSteps}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search meeting title, description, or location…"
          className="min-w-[280px] flex-1"
        />
        <Select value={ownerId} onValueChange={setOwnerId}>
          <SelectTrigger
            className="w-[220px]"
            data-testid="filter-meetings-owner"
          >
            <SelectValue placeholder="Everyone" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone on our team</SelectItem>
            {(users ?? []).map((user) => (
              <SelectItem key={user.id} value={user.id}>
                {userDisplayName(user)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="history">Meeting history</TabsTrigger>
          <TabsTrigger value="future">Future meetings</TabsTrigger>
        </TabsList>
        {(["history", "future"] as const).map((value) => (
          <TabsContent key={value} value={value}>
            <Card>
              <CardContent className="p-0">
                {loading ? (
                  <p className="p-5 text-sm text-muted-foreground">
                    Loading meetings…
                  </p>
                ) : failed ? (
                  <p className="p-5 text-sm text-destructive">
                    Meetings could not be loaded.
                  </p>
                ) : rows.length === 0 ? (
                  <p className="p-5 text-sm text-muted-foreground">
                    No meetings match these filters.
                  </p>
                ) : (
                  rows.map((event) => (
                    <MeetingRow
                      key={event.id}
                      event={event}
                      future={tab === "future"}
                      ownerName={
                        userNames.get(event.calendarUserId) ??
                        "Unknown team member"
                      }
                    />
                  ))
                )}
              </CardContent>
            </Card>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
