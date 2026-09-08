import { useMemo, useState } from "react";
import {
  useListNotes,
  useCreateNote,
  useDeleteNote,
  useUpdateNote,
  useListCalendarEvents,
  getListNotesQueryKey,
  getListCalendarEventsQueryKey,
  type Note,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CalendarDays, Trash2 } from "lucide-react";
import {
  EntityLinksEditor,
  EMPTY_LINKS,
  MentionsPicker,
  type EntityLinks,
} from "@/components/entity-links-editor";
import { useUserNameMap, userDisplayName } from "@/components/user-picker";
import {
  useListUsers,
  getListUsersQueryKey,
} from "@workspace/api-client-react";

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

interface PanelContext {
  personId?: string;
  organizationId?: string;
  householdId?: string;
  opportunityId?: string;
  giftId?: string;
  /** Additional IDs to pre-fill (checked but removable) when the dialog opens. */
  defaultLinks?: Partial<EntityLinks>;
}

export function NotesPanel(ctx: PanelContext) {
  const { data, isLoading } = useListNotes({
    personId: ctx.personId,
    organizationId: ctx.organizationId,
    householdId: ctx.householdId,
    opportunityId: ctx.opportunityId,
    giftId: ctx.giftId,
    limit: 50,
  });
  const rows: Note[] = data?.data ?? [];
  const userMap = useUserNameMap();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const del = useDeleteNote({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListNotesQueryKey() });
        toast({ title: "Note deleted" });
      },
    },
  });
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">Notes</CardTitle>
        <AddNoteDialog ctx={ctx} />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notes yet.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((n) => (
              <li
                key={n.id}
                className="border rounded-md p-3 text-sm space-y-1"
                data-testid={`note-row-${n.id}`}
              >
                <div className="flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">
                    {userMap.get(n.authorUserId) ?? n.authorUserId} ·{" "}
                    {formatWhen(n.createdAt)}
                  </div>
                  <div className="flex items-center gap-0.5">
                    <NoteMeetingLinkDialog note={n} ctx={ctx} />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      onClick={() => del.mutate({ id: n.id })}
                      disabled={del.isPending}
                      aria-label="Delete note"
                      data-testid={`button-delete-note-${n.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <p className="whitespace-pre-wrap">{n.body}</p>
                {n.calendarEventId ? (
                  <Badge variant="outline" className="gap-1">
                    <CalendarDays className="h-3 w-3" /> Linked to meeting
                  </Badge>
                ) : null}
                {n.mentionUserIds && n.mentionUserIds.length > 0 ? (
                  <div className="text-xs text-muted-foreground">
                    Mentions:{" "}
                    {n.mentionUserIds
                      .map((id) => `@${userMap.get(id) ?? id}`)
                      .join(", ")}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function NoteMeetingLinkDialog({
  note,
  ctx,
}: {
  note: Note;
  ctx: PanelContext;
}) {
  const [open, setOpen] = useState(false);
  const [calendarEventId, setCalendarEventId] = useState(
    note.calendarEventId ?? "none",
  );
  const personId = ctx.personId ?? note.personIds?.[0];
  const organizationId = personId
    ? undefined
    : ctx.organizationId ?? note.organizationIds?.[0];
  const householdId = personId || organizationId
    ? undefined
    : ctx.householdId ?? note.householdIds?.[0];
  const params = {
    personId,
    organizationId,
    includeLinkedPeople: organizationId ? true : undefined,
    householdId,
    order: "desc" as const,
    limit: 50,
  };
  const hasScope = Boolean(personId || organizationId || householdId);
  const meetings = useListCalendarEvents(params, {
    query: {
      enabled: open && hasScope,
      queryKey: getListCalendarEventsQueryKey(params),
    },
  });
  const options = useMemo(
    () =>
      (meetings.data?.data ?? []).filter(
        (event) => event.status !== "cancelled" && !event.isPrivate,
      ),
    [meetings.data?.data],
  );
  const currentIsOutsideOptions = Boolean(
    note.calendarEventId &&
      !options.some((event) => event.id === note.calendarEventId),
  );
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateNote({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getListNotesQueryKey() }),
          queryClient.invalidateQueries({
            queryKey: getListCalendarEventsQueryKey(),
          }),
        ]);
        toast({ title: "Meeting link updated" });
        setOpen(false);
      },
      onError: (err: unknown) => {
        toast({
          title: "Save failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (update.isPending) return;
        if (nextOpen) setCalendarEventId(note.calendarEventId ?? "none");
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-muted-foreground hover:text-primary"
          aria-label={note.calendarEventId ? "Change linked meeting" : "Link note to meeting"}
          data-testid={`button-link-note-meeting-${note.id}`}
        >
          <CalendarDays className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link note to meeting</DialogTitle>
          <DialogDescription>
            Optionally associate this note with one specific synced meeting.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`note-meeting-${note.id}`}>Meeting</Label>
          <Select
            value={calendarEventId}
            onValueChange={setCalendarEventId}
            disabled={meetings.isLoading}
          >
            <SelectTrigger
              id={`note-meeting-${note.id}`}
              data-testid={`select-note-meeting-${note.id}`}
            >
              <SelectValue placeholder="No meeting selected" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No meeting</SelectItem>
              {currentIsOutsideOptions && note.calendarEventId ? (
                <SelectItem value={note.calendarEventId}>
                  Current linked meeting
                </SelectItem>
              ) : null}
              {options.map((event) => (
                <SelectItem key={event.id} value={event.id}>
                  {(event.summary?.trim() || "Untitled meeting") +
                    ` · ${formatWhen(event.startAt)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!hasScope ? (
            <p className="text-xs text-muted-foreground">
              This note needs a linked person, funder, or household before a
              meeting can be selected.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={update.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() =>
              update.mutate({
                id: note.id,
                data: {
                  calendarEventId:
                    calendarEventId === "none" ? null : calendarEventId,
                },
              })
            }
            disabled={update.isPending}
            data-testid={`button-save-note-meeting-${note.id}`}
          >
            {update.isPending ? "Saving…" : "Save link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AddNoteDialog({ ctx }: { ctx: PanelContext }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [links, setLinks] = useState<EntityLinks>(() => linksFromDefault(ctx.defaultLinks));
  const [mentions, setMentions] = useState<string[]>([]);
  const [calendarEventId, setCalendarEventId] = useState("none");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: users } = useListUsers({
    query: { queryKey: getListUsersQueryKey(), staleTime: 60_000 },
  });
  const userOpts = (users ?? []).map((u) => ({ id: u.id, label: userDisplayName(u) }));
  const pinned = pinnedFromCtx(ctx);
  const meetingPersonId =
    pinned.personIds[0] ?? links.personIds[0] ?? ctx.defaultLinks?.personIds?.[0];
  const meetingOrganizationId = meetingPersonId
    ? undefined
    : pinned.organizationIds[0] ??
      links.organizationIds[0] ??
      ctx.defaultLinks?.organizationIds?.[0];
  const meetingHouseholdId = meetingPersonId || meetingOrganizationId
    ? undefined
    : pinned.householdIds[0] ??
      links.householdIds[0] ??
      ctx.defaultLinks?.householdIds?.[0];
  const meetingParams = {
    personId: meetingPersonId,
    organizationId: meetingOrganizationId,
    includeLinkedPeople: meetingOrganizationId ? true : undefined,
    householdId: meetingHouseholdId,
    order: "desc" as const,
    limit: 50,
  };
  const meetingScopePresent = Boolean(
    meetingPersonId || meetingOrganizationId || meetingHouseholdId,
  );
  const meetings = useListCalendarEvents(meetingParams, {
    query: {
      enabled: open && meetingScopePresent,
      queryKey: getListCalendarEventsQueryKey(meetingParams),
    },
  });
  const meetingOptions = useMemo(
    () =>
      (meetings.data?.data ?? []).filter(
        (event) => event.status !== "cancelled" && !event.isPrivate,
      ),
    [meetings.data?.data],
  );
  const create = useCreateNote({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getListNotesQueryKey() }),
          queryClient.invalidateQueries({
            queryKey: getListCalendarEventsQueryKey(),
          }),
        ]);
        toast({ title: "Note saved" });
        setOpen(false);
        setBody("");
        setLinks(linksFromDefault(ctx.defaultLinks));
        setMentions([]);
        setCalendarEventId("none");
      },
      onError: (err: unknown) => {
        toast({
          title: "Save failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });
  const canSubmit = body.trim().length > 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!create.isPending) {
          if (v) {
            setLinks(linksFromDefault(ctx.defaultLinks));
            setCalendarEventId("none");
          }
          setOpen(v);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="button-add-note">
          Add note
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add note</DialogTitle>
          <DialogDescription>
            Capture a quick note. Link it to one or more records so it shows up
            on each.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            create.mutate({
              data: {
                body: body.trim(),
                personIds: mergeLinks(pinned.personIds, links.personIds),
                organizationIds: mergeLinks(pinned.organizationIds, links.organizationIds),
                householdIds: mergeLinks(pinned.householdIds, links.householdIds),
                opportunityIds: mergeLinks(pinned.opportunityIds, links.opportunityIds),
                giftIds: mergeLinks(pinned.giftIds, links.giftIds),
                mentionUserIds: mentions.length > 0 ? mentions : undefined,
                calendarEventId:
                  calendarEventId === "none" ? undefined : calendarEventId,
              },
            });
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="note-body">Note</Label>
            <Textarea
              id="note-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              autoFocus
              data-testid="input-note-body"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Linked records</Label>
            <EntityLinksEditor value={links} onChange={setLinks} pinned={pinned} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="note-meeting">Meeting (optional)</Label>
            <Select
              value={calendarEventId}
              onValueChange={setCalendarEventId}
              disabled={!meetingScopePresent || meetings.isLoading}
            >
              <SelectTrigger id="note-meeting" data-testid="select-note-meeting">
                <SelectValue placeholder="No meeting selected" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No meeting</SelectItem>
                {meetingOptions.map((event) => (
                  <SelectItem key={event.id} value={event.id}>
                    {(event.summary?.trim() || "Untitled meeting") +
                      ` · ${formatWhen(event.startAt)}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!meetingScopePresent ? (
              <p className="text-xs text-muted-foreground">
                Link a person, funder, or household to choose one of their
                meetings.
              </p>
            ) : !meetings.isLoading && meetingOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No synced meetings found for the linked record.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Choose a meeting only when this note documents that meeting.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Mentions</Label>
            <MentionsPicker value={mentions} onChange={setMentions} users={userOpts} />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit || create.isPending}
              data-testid="button-save-note"
            >
              {create.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function pinnedFromCtx(ctx: PanelContext): EntityLinks {
  return {
    personIds: ctx.personId ? [ctx.personId] : [],
    organizationIds: ctx.organizationId ? [ctx.organizationId] : [],
    householdIds: ctx.householdId ? [ctx.householdId] : [],
    opportunityIds: ctx.opportunityId ? [ctx.opportunityId] : [],
    giftIds: ctx.giftId ? [ctx.giftId] : [],
    grantLeadIds: [],
  };
}

function mergeLinks(pinned: string[], user: string[]): string[] | undefined {
  const merged = Array.from(new Set([...pinned, ...user]));
  return merged.length > 0 ? merged : undefined;
}

function linksFromDefault(defaultLinks?: Partial<EntityLinks>): EntityLinks {
  if (!defaultLinks) return EMPTY_LINKS;
  return {
    personIds: defaultLinks.personIds ?? [],
    organizationIds: defaultLinks.organizationIds ?? [],
    householdIds: defaultLinks.householdIds ?? [],
    opportunityIds: defaultLinks.opportunityIds ?? [],
    giftIds: defaultLinks.giftIds ?? [],
    grantLeadIds: defaultLinks.grantLeadIds ?? [],
  };
}
