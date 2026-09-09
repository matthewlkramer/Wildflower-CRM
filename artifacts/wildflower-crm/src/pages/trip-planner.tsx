import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetTripPlanQueryKey,
  getListTripPlansQueryKey,
  getListPeopleQueryKey,
  useAddTripVisit,
  useArchiveTripPlan,
  useArchiveTripVisit,
  useCreateTripPlan,
  useDraftTripVisits,
  useGetCurrentUser,
  useGetTripPlan,
  useListPeople,
  useListTripPlans,
  useListUsers,
  useUpdateTripPlan,
  useUpdateTripVisit,
  type CreateTripPlanBody,
  type TripPlanDetail,
  type TripPlanSummary,
  type TripVisit,
  type UpdateTripPlanBody,
} from "@workspace/api-client-react";
import {
  CalendarDays,
  Clock3,
  ExternalLink,
  MailCheck,
  MapPin,
  Pencil,
  Plane,
  Plus,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { displayPersonName } from "@/lib/visibility";
import { userDisplayName } from "@/components/user-picker";

function toLocalInput(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toIso(value: string) {
  return new Date(value).toISOString();
}

function minutesLabel(minutes?: number | null) {
  if (minutes == null) return "Not entered";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function whenLabel(start: string, end?: string | null) {
  const format = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${format.format(new Date(start))}${end ? ` – ${format.format(new Date(end))}` : ""}`;
}

function tripLabel(trip: TripPlanSummary) {
  return (
    trip.title?.trim() || trip.destinationCity?.trim() || "Destination TBD"
  );
}

type TripFormState = {
  travelerUserId: string;
  title: string;
  destinationCity: string;
  destinationState: string;
  travelStartsAt: string;
  travelEndsAt: string;
  meetingWindowStartsAt: string;
  meetingWindowEndsAt: string;
  outboundTravelMinutes: string;
  returnTravelMinutes: string;
  notes: string;
};

function initialTripForm(trip?: TripPlanSummary): TripFormState {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  tomorrow.setHours(9, 0, 0, 0);
  const nextDay = new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000);
  nextDay.setHours(18, 0, 0, 0);
  return {
    travelerUserId: trip?.travelerUserId ?? "",
    title: trip?.title ?? "",
    destinationCity: trip?.destinationCity ?? "",
    destinationState: trip?.destinationState ?? "",
    travelStartsAt: trip
      ? toLocalInput(trip.travelStartsAt)
      : toLocalInput(tomorrow.toISOString()),
    travelEndsAt: trip
      ? toLocalInput(trip.travelEndsAt)
      : toLocalInput(nextDay.toISOString()),
    meetingWindowStartsAt: toLocalInput(trip?.meetingWindowStartsAt),
    meetingWindowEndsAt: toLocalInput(trip?.meetingWindowEndsAt),
    outboundTravelMinutes: trip?.outboundTravelMinutes?.toString() ?? "",
    returnTravelMinutes: trip?.returnTravelMinutes?.toString() ?? "",
    notes: trip?.notes ?? "",
  };
}

function TripFormDialog({
  open,
  onOpenChange,
  trip,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trip?: TripPlanSummary;
  onSaved: (trip: TripPlanSummary) => void;
}) {
  const { data: users } = useListUsers();
  const { toast } = useToast();
  const [form, setForm] = useState(() => initialTripForm(trip));
  useEffect(() => {
    if (open) setForm(initialTripForm(trip));
  }, [open, trip]);
  const create = useCreateTripPlan({
    mutation: {
      onSuccess: onSaved,
      onError: () =>
        toast({ title: "Trip could not be created", variant: "destructive" }),
    },
  });
  const update = useUpdateTripPlan({
    mutation: {
      onSuccess: onSaved,
      onError: () =>
        toast({ title: "Trip could not be updated", variant: "destructive" }),
    },
  });
  const save = () => {
    if (!form.travelerUserId || !form.travelStartsAt || !form.travelEndsAt) {
      toast({
        title: "Choose a traveler and enter the trip start and end.",
        variant: "destructive",
      });
      return;
    }
    if (!!form.meetingWindowStartsAt !== !!form.meetingWindowEndsAt) {
      toast({
        title: "Enter both meeting-window times or leave both blank.",
        variant: "destructive",
      });
      return;
    }
    const data: CreateTripPlanBody | UpdateTripPlanBody = {
      travelerUserId: form.travelerUserId,
      title: form.title.trim() || null,
      destinationCity: form.destinationCity.trim() || null,
      destinationState: form.destinationState.trim() || null,
      travelStartsAt: toIso(form.travelStartsAt),
      travelEndsAt: toIso(form.travelEndsAt),
      meetingWindowStartsAt: form.meetingWindowStartsAt
        ? toIso(form.meetingWindowStartsAt)
        : null,
      meetingWindowEndsAt: form.meetingWindowEndsAt
        ? toIso(form.meetingWindowEndsAt)
        : null,
      outboundTravelMinutes: form.outboundTravelMinutes
        ? Number(form.outboundTravelMinutes)
        : null,
      returnTravelMinutes: form.returnTravelMinutes
        ? Number(form.returnTravelMinutes)
        : null,
      notes: form.notes.trim() || null,
    };
    if (trip) update.mutate({ id: trip.id, data });
    else create.mutate({ data: data as CreateTripPlanBody });
  };
  const pending = create.isPending || update.isPending;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{trip ? "Edit trip" : "Add a trip"}</DialogTitle>
          <DialogDescription>
            A destination is optional. Add a meeting window when only part of
            the trip is available for visits.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label>Traveler</Label>
            <Select
              value={form.travelerUserId}
              onValueChange={(value) =>
                setForm({ ...form, travelerUserId: value })
              }
            >
              <SelectTrigger data-testid="trip-traveler">
                <SelectValue placeholder="Choose a team member" />
              </SelectTrigger>
              <SelectContent>
                {(users ?? []).map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {userDisplayName(user)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="trip-title">Trip name (optional)</Label>
            <Input
              id="trip-title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Boston relationship-building trip"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="trip-city">Destination city (optional)</Label>
            <Input
              id="trip-city"
              value={form.destinationCity}
              onChange={(e) =>
                setForm({ ...form, destinationCity: e.target.value })
              }
              placeholder="Boston"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="trip-state">State / region (optional)</Label>
            <Input
              id="trip-state"
              value={form.destinationState}
              onChange={(e) =>
                setForm({ ...form, destinationState: e.target.value })
              }
              placeholder="MA"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="trip-start">Travel starts</Label>
            <Input
              id="trip-start"
              type="datetime-local"
              value={form.travelStartsAt}
              onChange={(e) =>
                setForm({ ...form, travelStartsAt: e.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="trip-end">Travel ends</Label>
            <Input
              id="trip-end"
              type="datetime-local"
              value={form.travelEndsAt}
              onChange={(e) =>
                setForm({ ...form, travelEndsAt: e.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="meeting-start">Available for meetings from</Label>
            <Input
              id="meeting-start"
              type="datetime-local"
              value={form.meetingWindowStartsAt}
              onChange={(e) =>
                setForm({ ...form, meetingWindowStartsAt: e.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="meeting-end">Available for meetings until</Label>
            <Input
              id="meeting-end"
              type="datetime-local"
              value={form.meetingWindowEndsAt}
              onChange={(e) =>
                setForm({ ...form, meetingWindowEndsAt: e.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="outbound-minutes">Outbound travel minutes</Label>
            <Input
              id="outbound-minutes"
              type="number"
              min={0}
              value={form.outboundTravelMinutes}
              onChange={(e) =>
                setForm({ ...form, outboundTravelMinutes: e.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="return-minutes">Return travel minutes</Label>
            <Input
              id="return-minutes"
              type="number"
              min={0}
              value={form.returnTravelMinutes}
              onChange={(e) =>
                setForm({ ...form, returnTravelMinutes: e.target.value })
              }
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="trip-notes">Notes</Label>
            <Textarea
              id="trip-notes"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Travel constraints, goals, lodging, or context…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save trip"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddVisitDialog({
  tripId,
  open,
  onOpenChange,
  onSaved,
}: {
  tripId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [search, setSearch] = useState("");
  const [personId, setPersonId] = useState("");
  const { toast } = useToast();
  const viewer = useGetCurrentUser().data ?? null;
  const peopleParams = {
    search: search.trim() || undefined,
    deceased: false,
    showFoundationPartners: false,
    limit: 50,
  };
  const peopleQuery = useListPeople(peopleParams, {
    query: { enabled: open, queryKey: getListPeopleQueryKey(peopleParams) },
  });
  const add = useAddTripVisit({
    mutation: {
      onSuccess: () => {
        onSaved();
        onOpenChange(false);
        setPersonId("");
      },
      onError: () =>
        toast({
          title: "This person could not be added",
          description: "They may already be on the trip list.",
          variant: "destructive",
        }),
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add someone to visit</DialogTitle>
          <DialogDescription>
            Search CRM people and add one to this trip’s priority list.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search people…"
            autoFocus
          />
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
            {peopleQuery.isLoading ? (
              <p className="p-2 text-sm text-muted-foreground">Loading…</p>
            ) : null}
            {(peopleQuery.data?.data ?? []).map((person) => (
              <button
                key={person.id}
                type="button"
                onClick={() => setPersonId(person.id)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${personId === person.id ? "bg-primary/10 text-primary" : "hover:bg-muted"}`}
              >
                <span>{displayPersonName(person, viewer)}</span>
                {person.priority ? (
                  <Badge variant="outline">{person.priority}</Badge>
                ) : null}
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!personId || add.isPending}
            onClick={() => add.mutate({ id: tripId, data: { personId } })}
          >
            {add.isPending ? "Adding…" : "Add person"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditVisitDialog({
  tripId,
  visit,
  open,
  onOpenChange,
  onSaved,
}: {
  tripId: string;
  visit: TripVisit;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [rank, setRank] = useState(String(visit.rank));
  const [rationale, setRationale] = useState(visit.rationale ?? "");
  const [notes, setNotes] = useState(visit.notes ?? "");
  useEffect(() => {
    if (open) {
      setRank(String(visit.rank));
      setRationale(visit.rationale ?? "");
      setNotes(visit.notes ?? "");
    }
  }, [open, visit]);
  const update = useUpdateTripVisit({
    mutation: {
      onSuccess: () => {
        onSaved();
        onOpenChange(false);
      },
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Refine {visit.personName}</DialogTitle>
          <DialogDescription>
            Change their order or add team judgment to the system draft.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Priority order</Label>
            <Input
              type="number"
              min={1}
              value={rank}
              onChange={(e) => setRank(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Why visit</Label>
            <Textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Planning notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={update.isPending}
            onClick={() =>
              update.mutate({
                id: tripId,
                visitId: visit.id,
                data: {
                  rank: Math.max(1, Number(rank) || 1),
                  rationale: rationale.trim() || null,
                  notes: notes.trim() || null,
                },
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OutreachBadge({ visit }: { visit: TripVisit }) {
  if (visit.outreachStatus === "responded")
    return <Badge className="bg-emerald-700">Responded</Badge>;
  if (visit.outreachStatus === "invited")
    return <Badge variant="secondary">Invitation sent</Badge>;
  return <Badge variant="outline">Not invited</Badge>;
}

function VisitRow({
  tripId,
  visit,
  onChanged,
}: {
  tripId: string;
  visit: TripVisit;
  onChanged: () => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const archive = useArchiveTripVisit({ mutation: { onSuccess: onChanged } });
  return (
    <div
      className="rounded-lg border p-4"
      data-testid={`trip-visit-${visit.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">
              {visit.rank}. {visit.personName}
            </span>
            {visit.priority ? (
              <Badge variant="outline">{visit.priority} priority</Badge>
            ) : null}
            <Badge
              variant={
                visit.source === "system_draft" ? "secondary" : "outline"
              }
            >
              {visit.source === "system_draft" ? "Suggested" : "Added by team"}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {visit.location ||
              visit.primaryEmail ||
              "No city or email recorded"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setEditOpen(true)}
            aria-label={`Edit ${visit.personName}`}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => archive.mutate({ id: tripId, visitId: visit.id })}
            aria-label={`Remove ${visit.personName}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {visit.rationale ? (
        <p className="mt-3 text-sm">{visit.rationale}</p>
      ) : null}
      {visit.notes ? (
        <p className="mt-2 rounded bg-muted px-3 py-2 text-sm">{visit.notes}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <OutreachBadge visit={visit} />
        {visit.invitationSentAt ? (
          <span>
            Sent {new Date(visit.invitationSentAt).toLocaleDateString()}
          </span>
        ) : null}
        {visit.respondedAt ? (
          <span>
            · Reply {new Date(visit.respondedAt).toLocaleDateString()}
          </span>
        ) : null}
        {visit.scheduledAt ? (
          <Badge className="bg-blue-700">
            Scheduled {new Date(visit.scheduledAt).toLocaleString()}
          </Badge>
        ) : null}
      </div>
      <EditVisitDialog
        tripId={tripId}
        visit={visit}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={onChanged}
      />
    </div>
  );
}

function Schedule({ trip }: { trip: TripPlanDetail }) {
  const grouped = useMemo(() => {
    const groups = new Map<string, TripPlanDetail["calendarEvents"]>();
    for (const event of trip.calendarEvents.filter(
      (item) => item.status !== "cancelled",
    )) {
      const key = new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }).format(new Date(event.startAt));
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    return [...groups.entries()];
  }, [trip.calendarEvents]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <CalendarDays className="h-5 w-5" />
          Travel-day calendar
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {grouped.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No synced CRM calendar events fall inside the travel dates yet.
          </p>
        ) : (
          grouped.map(([day, events]) => (
            <div key={day}>
              <h3 className="mb-2 text-sm font-semibold">{day}</h3>
              <div className="space-y-2 border-l-2 border-primary/30 pl-4">
                {events.map((event) => (
                  <div
                    key={event.id}
                    className="rounded-md border bg-background p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">
                          {event.summary || "Untitled event"}
                          {event.transparency === "transparent" ? (
                            <Badge variant="outline" className="ml-2">
                              Free
                            </Badge>
                          ) : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {whenLabel(event.startAt, event.endAt)}
                          {event.location ? ` · ${event.location}` : ""}
                        </p>
                      </div>
                      {event.htmlLink ? (
                        <Button asChild variant="ghost" size="icon">
                          <a
                            href={event.htmlLink}
                            target="_blank"
                            rel="noreferrer"
                            aria-label="Open in Google Calendar"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
        <p className="text-xs text-muted-foreground">
          Trip-date sync includes events from the traveler’s primary calendar.
          Unmatched personal events default to private, and events marked free
          do not reduce estimated availability.
        </p>
      </CardContent>
    </Card>
  );
}

function TripDetailPanel({
  tripId,
  onArchived,
}: {
  tripId: string;
  onArchived: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const detail = useGetTripPlan(tripId);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetTripPlanQueryKey(tripId) });
    queryClient.invalidateQueries({ queryKey: getListTripPlansQueryKey() });
  };
  const draft = useDraftTripVisits({
    mutation: {
      onSuccess: refresh,
      onError: () =>
        toast({
          title: "People could not be drafted",
          description: "Add a destination city first.",
          variant: "destructive",
        }),
    },
  });
  const archive = useArchiveTripPlan({
    mutation: {
      onSuccess: () => {
        refresh();
        onArchived();
      },
    },
  });
  const trip = detail.data;
  if (detail.isLoading)
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Loading trip plan…
        </CardContent>
      </Card>
    );
  if (!trip)
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">
          This trip could not be loaded.
        </CardContent>
      </Card>
    );
  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-2xl font-serif font-bold">
                {tripLabel(trip)}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {whenLabel(trip.travelStartsAt, trip.travelEndsAt)}
              </p>
              <p className="mt-1 flex items-center gap-1 text-sm">
                <MapPin className="h-4 w-4" />
                {[trip.destinationCity, trip.destinationState]
                  .filter(Boolean)
                  .join(", ") || "Destination not planned yet"}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil className="mr-2 h-4 w-4" />
                Edit
              </Button>
              <Button
                variant="ghost"
                onClick={() => archive.mutate({ id: trip.id })}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Archive
              </Button>
            </div>
          </div>
          {trip.notes ? (
            <p className="mt-4 rounded-md bg-muted p-3 text-sm">{trip.notes}</p>
          ) : null}
        </CardContent>
      </Card>
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="flex items-center gap-1 text-xs uppercase text-muted-foreground">
              <Plane className="h-4 w-4" />
              Travel time
            </p>
            <p className="mt-1 text-xl font-semibold">
              {minutesLabel(trip.travelMinutes)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="flex items-center gap-1 text-xs uppercase text-muted-foreground">
              <Clock3 className="h-4 w-4" />
              Meeting window
            </p>
            <p className="mt-1 text-xl font-semibold">
              {minutesLabel(trip.meetingWindowMinutes)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="flex items-center gap-1 text-xs uppercase text-muted-foreground">
              <MailCheck className="h-4 w-4" />
              Estimated available
            </p>
            <p className="mt-1 text-xl font-semibold text-primary">
              {minutesLabel(trip.availableMinutes)}
            </p>
            <p className="text-xs text-muted-foreground">
              after {minutesLabel(trip.scheduledMinutes)} scheduled
            </p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <UserRound className="h-5 w-5" />
                Priority people to visit
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                The system watches synced email and calendar evidence for each
                person.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setAddOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add person
              </Button>
              <Button
                disabled={!trip.destinationCity || draft.isPending}
                onClick={() => draft.mutate({ id: trip.id })}
              >
                <Sparkles className="mr-2 h-4 w-4" />
                {draft.isPending ? "Drafting…" : "Draft from CRM"}
              </Button>
            </div>
          </div>
          {!trip.destinationCity ? (
            <p className="text-xs text-amber-700">
              Add a destination city to enable the system draft.
            </p>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-3">
          {trip.visits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No one is on the visit list yet. Add a person or draft from CRM
              priorities and matching city addresses.
            </p>
          ) : (
            trip.visits.map((visit) => (
              <VisitRow
                key={visit.id}
                tripId={trip.id}
                visit={visit}
                onChanged={refresh}
              />
            ))
          )}
        </CardContent>
      </Card>
      <Schedule trip={trip} />
      <TripFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        trip={trip}
        onSaved={() => {
          setEditOpen(false);
          refresh();
        }}
      />
      <AddVisitDialog
        tripId={trip.id}
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={refresh}
      />
    </div>
  );
}

export default function TripPlannerPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: users } = useListUsers();
  const usersById = useMemo(
    () =>
      new Map((users ?? []).map((user) => [user.id, userDisplayName(user)])),
    [users],
  );
  const trips = useListTripPlans();
  useEffect(() => {
    if (!selectedId && trips.data?.data[0])
      setSelectedId(trips.data.data[0].id);
  }, [selectedId, trips.data?.data]);
  const onSaved = (trip: TripPlanSummary) => {
    setCreateOpen(false);
    setSelectedId(trip.id);
    queryClient.invalidateQueries({ queryKey: getListTripPlansQueryKey() });
  };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Plane className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-3xl font-serif font-bold">Trip Planner</h1>
            <p className="text-sm text-muted-foreground">
              Plan team travel, prioritize visits, monitor outreach, and see the
              synced schedule.
            </p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add trip
        </Button>
      </div>
      <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Trips</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {trips.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : null}
            {(trips.data?.data ?? []).map((trip) => (
              <button
                key={trip.id}
                type="button"
                onClick={() => setSelectedId(trip.id)}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${selectedId === trip.id ? "border-primary bg-primary/5" : "hover:bg-muted"}`}
              >
                <p className="font-medium">{tripLabel(trip)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {usersById.get(trip.travelerUserId) ?? "Team member"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(trip.travelStartsAt).toLocaleDateString()} –{" "}
                  {new Date(trip.travelEndsAt).toLocaleDateString()}
                </p>
              </button>
            ))}
            {!trips.isLoading && (trips.data?.data.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">No trips yet.</p>
            ) : null}
          </CardContent>
        </Card>
        {selectedId ? (
          <TripDetailPanel
            tripId={selectedId}
            onArchived={() => setSelectedId(null)}
          />
        ) : (
          <Card>
            <CardContent className="flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center">
              <Plane className="h-10 w-10 text-muted-foreground" />
              <p className="font-medium">Add a trip to start planning.</p>
              <Button onClick={() => setCreateOpen(true)}>Add trip</Button>
            </CardContent>
          </Card>
        )}
      </div>
      <TripFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={onSaved}
      />
    </div>
  );
}
