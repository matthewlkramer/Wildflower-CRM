import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  getListCalendarEventsQueryKey,
  useListCalendarEvents,
  type CalendarEvent,
} from "@workspace/api-client-react";
import { CalendarDays, NotebookPen, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ContactPicker,
  type PickedContact,
} from "@/components/meeting-notes-panel";

function formatMeetingTime(startAt: string) {
  return new Date(startAt).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function newMeetingWorkspaceHref(contact: PickedContact) {
  const params = new URLSearchParams({
    contactKind: contact.kind,
    contactId: contact.id,
  });
  return `/meetings/new?${params.toString()}`;
}

function meetingDistance(event: CalendarEvent, now: number) {
  return Math.abs(new Date(event.startAt).getTime() - now);
}

export function MeetingLauncherDialog() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [contact, setContact] = useState<PickedContact | null>(null);
  const params = {
    search: search.trim() || undefined,
    order: "desc" as const,
    limit: 100,
  };
  const meetings = useListCalendarEvents(params, {
    query: {
      enabled: open,
      queryKey: getListCalendarEventsQueryKey(params),
    },
  });
  const rows = useMemo(() => {
    const now = Date.now();
    return [...(meetings.data?.data ?? [])]
      .filter((event) => event.status !== "cancelled")
      .sort((a, b) => meetingDistance(a, now) - meetingDistance(b, now));
  }, [meetings.data]);

  function goToMeeting(href: string) {
    setOpen(false);
    setSearch("");
    setContact(null);
    navigate(href);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="button-new-meeting">
          <NotebookPen className="mr-1 h-3.5 w-3.5" /> New meeting
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Open a meeting workspace</DialogTitle>
          <DialogDescription>
            Choose a calendar meeting already in the CRM, or start a meeting
            with a person, funder, or household now.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="existing" className="space-y-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="existing">Choose a meeting</TabsTrigger>
            <TabsTrigger value="new">Start one now</TabsTrigger>
          </TabsList>
          <TabsContent value="existing" className="space-y-3">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search meeting title, description, or location…"
              aria-label="Search meetings"
              autoFocus
            />
            <div className="max-h-[420px] overflow-y-auto rounded-md border">
              {meetings.isLoading ? (
                <p className="p-4 text-sm text-muted-foreground">
                  Loading meetings…
                </p>
              ) : meetings.isError ? (
                <p className="p-4 text-sm text-destructive">
                  Meetings could not be loaded.
                </p>
              ) : rows.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No meetings match this search.
                </p>
              ) : (
                <ul className="divide-y">
                  {rows.map((event) => (
                    <li key={event.id}>
                      <button
                        type="button"
                        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/50"
                        onClick={() => goToMeeting(`/meetings/${event.id}`)}
                        data-testid={`choose-meeting-${event.id}`}
                      >
                        <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {event.summary?.trim() || "(no title)"}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {formatMeetingTime(event.startAt)}
                            {event.location ? ` · ${event.location}` : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </TabsContent>
          <TabsContent value="new" className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">Who is the meeting with?</p>
              <ContactPicker value={contact} onChange={setContact} />
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                disabled={!contact}
                onClick={() => {
                  if (contact) goToMeeting(newMeetingWorkspaceHref(contact));
                }}
                data-testid="button-start-new-meeting"
              >
                <Plus className="mr-1 h-4 w-4" /> Start meeting
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
