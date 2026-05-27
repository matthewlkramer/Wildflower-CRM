import { useState } from "react";
import {
  useListMeetingNotes,
  useCreateMeetingNote,
  useDeleteMeetingNote,
  usePromoteMeetingActionItem,
  useGetCurrentUser,
  getListMeetingNotesQueryKey,
  getListTasksQueryKey,
  type MeetingNote,
  type MeetingActionItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Sparkles,
  Trash2,
  CheckCircle2,
  ListChecks,
  Lock,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useUserNameMap } from "@/components/user-picker";

export interface MeetingContext {
  personId?: string;
  funderId?: string;
  householdId?: string;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function MeetingNotesPanel(ctx: MeetingContext) {
  const { data, isLoading } = useListMeetingNotes({
    personId: ctx.personId,
    funderId: ctx.funderId,
    householdId: ctx.householdId,
    limit: 50,
  });
  const rows: MeetingNote[] = data?.data ?? [];
  return (
    <Card data-testid="meeting-notes-panel">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          Meeting notes
        </CardTitle>
        <AddMeetingNoteDialog ctx={ctx} />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No meeting notes yet. Paste a transcript and we'll summarize it
            and extract action items.
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((m) => (
              <MeetingNoteRow key={m.id} note={m} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function MeetingNoteRow({ note }: { note: MeetingNote }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const userMap = useUserNameMap();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const del = useDeleteMeetingNote({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListMeetingNotesQueryKey(),
        });
        toast({ title: "Meeting note deleted" });
      },
    },
  });
  const promote = usePromoteMeetingActionItem({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getListMeetingNotesQueryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: getListTasksQueryKey(),
          }),
        ]);
        toast({ title: "Task created from action item" });
      },
      onError: (err: unknown) => {
        toast({
          title: "Promote failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });
  const items: MeetingActionItem[] = (note.actionItems ?? []) as MeetingActionItem[];
  return (
    <li
      className="border rounded-md p-3 text-sm space-y-2"
      data-testid={`meeting-note-row-${note.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium truncate">
            {note.title || "(untitled meeting)"}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatWhen(note.meetingDate)} · by{" "}
            {userMap.get(note.creatorUserId) ?? note.creatorUserId}
            {note.summaryOnly ? (
              <>
                {" "}
                ·{" "}
                <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                  <Lock className="h-3 w-3" /> transcript discarded
                </span>
              </>
            ) : null}
          </div>
          {note.attendees && note.attendees.length > 0 ? (
            <div className="text-xs text-muted-foreground mt-0.5">
              Attendees: {note.attendees.join(", ")}
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
          onClick={() => del.mutate({ id: note.id })}
          disabled={del.isPending}
          aria-label="Delete meeting note"
          data-testid={`button-delete-meeting-note-${note.id}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {note.aiSummary ? (
        <p className="whitespace-pre-wrap text-muted-foreground">
          {note.aiSummary}
        </p>
      ) : null}
      {items.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-xs font-medium flex items-center gap-1">
            <ListChecks className="h-3.5 w-3.5" /> Action items
          </div>
          <ul className="space-y-1">
            {items.map((it, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-2 text-xs border-l-2 border-muted pl-2"
                data-testid={`meeting-action-item-${note.id}-${i}`}
              >
                <div className="min-w-0">
                  <div className="truncate">{it.title}</div>
                  <div className="text-muted-foreground">
                    {it.assigneeName ? `${it.assigneeName}` : "Unassigned"}
                    {it.dueDate ? ` · due ${it.dueDate}` : ""}
                  </div>
                </div>
                {it.promotedTaskId ? (
                  <Badge variant="outline" className="gap-1 shrink-0">
                    <CheckCircle2 className="h-3 w-3" /> Task
                  </Badge>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs shrink-0"
                    disabled={promote.isPending}
                    onClick={() =>
                      promote.mutate({
                        id: note.id,
                        data: {
                          index: i,
                          dueDate: it.dueDate ?? undefined,
                        },
                      })
                    }
                    data-testid={`button-promote-action-item-${note.id}-${i}`}
                  >
                    Promote to task
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {note.rawTranscript ? (
        <div>
          <button
            type="button"
            className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:underline"
            onClick={() => setShowTranscript((v) => !v)}
            data-testid={`button-toggle-transcript-${note.id}`}
          >
            {showTranscript ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {showTranscript ? "Hide transcript" : "Show transcript"}
          </button>
          {showTranscript ? (
            <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground bg-muted/40 rounded p-2 max-h-64 overflow-auto">
              {note.rawTranscript}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Paste-transcript dialog. Self-contained — `ctx` pins the contact xor.
 * When `unpinned` is true (global "+ New meeting"), the user must pick a
 * single contact from one of three id inputs. (We keep the global flow
 * simple — a full searchable contact picker is over-scoped for this
 * task; users will land here from the contact detail pages 95% of the
 * time anyway.)
 */
export function AddMeetingNoteDialog({
  ctx,
  unpinned,
  trigger,
}: {
  ctx?: MeetingContext;
  unpinned?: boolean;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [meetingDate, setMeetingDate] = useState("");
  const [attendees, setAttendees] = useState("");
  const [transcript, setTranscript] = useState("");
  const [personId, setPersonId] = useState("");
  const [funderId, setFunderId] = useState("");
  const [householdId, setHouseholdId] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useGetCurrentUser();
  const isSummaryOnly = me?.emailSyncMode === "summary_only";

  const create = useCreateMeetingNote({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListMeetingNotesQueryKey(),
        });
        toast({ title: "Meeting note saved" });
        setOpen(false);
        setTitle("");
        setMeetingDate("");
        setAttendees("");
        setTranscript("");
        setPersonId("");
        setFunderId("");
        setHouseholdId("");
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

  // For pinned panels the contact comes from `ctx`. For unpinned (global
  // "+ New meeting") the user fills exactly one of the three id fields.
  const effectivePerson = ctx?.personId ?? (personId.trim() || undefined);
  const effectiveFunder = ctx?.funderId ?? (funderId.trim() || undefined);
  const effectiveHousehold =
    ctx?.householdId ?? (householdId.trim() || undefined);
  const contactCount =
    (effectivePerson ? 1 : 0) +
    (effectiveFunder ? 1 : 0) +
    (effectiveHousehold ? 1 : 0);
  const canSubmit = transcript.trim().length > 0 && contactCount === 1;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!create.isPending) setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button
            size="sm"
            variant="outline"
            data-testid="button-add-meeting-note"
          >
            <Sparkles className="h-3.5 w-3.5 mr-1" /> New meeting
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New meeting note</DialogTitle>
          <DialogDescription>
            Paste the meeting transcript. We'll generate a summary and
            extract action items you can promote to tasks.
          </DialogDescription>
        </DialogHeader>
        {isSummaryOnly ? (
          <div
            className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900/40 px-3 py-2 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2"
            data-testid="meeting-summary-only-banner"
          >
            <Lock className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              Your account is in <strong>summary-only</strong> mode. The raw
              transcript will be discarded after we extract the summary and
              action items.
            </div>
          </div>
        ) : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            const attendeesList = attendees
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            create.mutate({
              data: {
                transcript: transcript.trim(),
                title: title.trim() || undefined,
                meetingDate: meetingDate
                  ? new Date(meetingDate).toISOString()
                  : undefined,
                attendees: attendeesList.length ? attendeesList : undefined,
                personId: effectivePerson,
                funderId: effectiveFunder,
                householdId: effectiveHousehold,
              },
            });
          }}
          className="space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="mtg-title">Title (optional)</Label>
              <Input
                id="mtg-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Q3 grant check-in"
                data-testid="input-meeting-title"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mtg-date">Meeting date</Label>
              <Input
                id="mtg-date"
                type="datetime-local"
                value={meetingDate}
                onChange={(e) => setMeetingDate(e.target.value)}
                data-testid="input-meeting-date"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mtg-attendees">Attendees (comma-separated)</Label>
            <Input
              id="mtg-attendees"
              value={attendees}
              onChange={(e) => setAttendees(e.target.value)}
              placeholder="Alex Lee, Sam Patel"
              data-testid="input-meeting-attendees"
            />
          </div>
          {unpinned ? (
            <div className="space-y-1.5">
              <Label>Contact (exactly one)</Label>
              <div className="grid grid-cols-3 gap-2">
                <Input
                  value={personId}
                  onChange={(e) => setPersonId(e.target.value)}
                  placeholder="Person id"
                  data-testid="input-meeting-person-id"
                />
                <Input
                  value={funderId}
                  onChange={(e) => setFunderId(e.target.value)}
                  placeholder="Funder id"
                  data-testid="input-meeting-funder-id"
                />
                <Input
                  value={householdId}
                  onChange={(e) => setHouseholdId(e.target.value)}
                  placeholder="Household id"
                  data-testid="input-meeting-household-id"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Tip: open this dialog from the person / household / funding
                entity detail page to skip this step.
              </p>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="mtg-transcript">Transcript</Label>
            <Textarea
              id="mtg-transcript"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              rows={10}
              placeholder="Paste the full meeting transcript here…"
              autoFocus
              data-testid="input-meeting-transcript"
            />
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
              data-testid="button-save-meeting-note"
            >
              {create.isPending ? "Summarizing…" : "Save & summarize"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
