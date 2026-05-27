import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListMeetingNotes,
  useCreateMeetingNote,
  useUpdateMeetingNote,
  useDeleteMeetingNote,
  usePromoteMeetingActionItem,
  useGetCurrentUser,
  useListPeople,
  useListFunders,
  useListHouseholds,
  getListMeetingNotesQueryKey,
  getListPeopleQueryKey,
  getListFundersQueryKey,
  getListHouseholdsQueryKey,
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
  Pencil,
  Plus,
  Upload,
  X,
  Check,
  Building2,
  Home,
  Users as UsersIcon,
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

/**
 * Standalone panel kept for backwards compatibility, but the canonical
 * surface for meeting notes is now the activity timeline (which renders
 * `MeetingNoteRow` directly alongside emails/calendar/interactions).
 * Detail pages should prefer the timeline; this panel remains for any
 * future page that wants a meeting-notes-only view.
 */
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

/**
 * Renders a single meeting note row. Exported so the activity timeline
 * can drop it inline alongside the other timeline sources.
 *
 * Editing model: a single "Edit" button toggles the whole row into edit
 * mode where the summary becomes a textarea, action items become
 * editable inputs with add/remove controls, and Save/Cancel commit or
 * revert via PATCH. Promote-to-task is hidden in edit mode (you can't
 * promote a stale draft).
 */
export function MeetingNoteRow({ note }: { note: MeetingNote }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [editing, setEditing] = useState(false);
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
  const update = useUpdateMeetingNote({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListMeetingNotesQueryKey(),
        });
        toast({ title: "Meeting note updated" });
        setEditing(false);
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

  if (editing) {
    return (
      <MeetingNoteEditor
        note={note}
        onCancel={() => setEditing(false)}
        onSave={(patch) => update.mutate({ id: note.id, data: patch })}
        saving={update.isPending}
      />
    );
  }

  return (
    <li
      className="border rounded-md p-3 text-sm space-y-2"
      data-testid={`meeting-note-row-${note.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
            <Badge variant="secondary">Meeting</Badge>
            <span className="text-xs text-muted-foreground">
              {formatWhen(note.meetingDate)}
            </span>
            {note.summaryOnly ? (
              <Badge
                variant="outline"
                className="gap-1 text-amber-700 border-amber-300 dark:text-amber-400 dark:border-amber-900/60"
              >
                <Lock className="h-3 w-3" /> Summary-only
              </Badge>
            ) : null}
          </div>
          <div className="font-medium truncate mt-1">
            {note.title || "(untitled meeting)"}
          </div>
          <div className="text-xs text-muted-foreground">
            by {userMap.get(note.creatorUserId) ?? note.creatorUserId}
          </div>
          {note.attendees && note.attendees.length > 0 ? (
            <div className="text-xs text-muted-foreground mt-0.5">
              Attendees: {note.attendees.join(", ")}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-primary"
            onClick={() => setEditing(true)}
            aria-label="Edit meeting note"
            data-testid={`button-edit-meeting-note-${note.id}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={() => {
              if (confirm("Delete this meeting note?")) del.mutate({ id: note.id });
            }}
            disabled={del.isPending}
            aria-label="Delete meeting note"
            data-testid={`button-delete-meeting-note-${note.id}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
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
 * In-place editor for a saved meeting note. Local draft state so the
 * Cancel button can revert without a refetch round-trip.
 */
function MeetingNoteEditor({
  note,
  onCancel,
  onSave,
  saving,
}: {
  note: MeetingNote;
  onCancel: () => void;
  onSave: (patch: {
    title?: string | null;
    aiSummary?: string | null;
    actionItems?: MeetingActionItem[];
  }) => void;
  saving: boolean;
}) {
  const [title, setTitle] = useState(note.title ?? "");
  const [summary, setSummary] = useState(note.aiSummary ?? "");
  const [items, setItems] = useState<MeetingActionItem[]>(
    (note.actionItems ?? []) as MeetingActionItem[],
  );

  function setItem(i: number, patch: Partial<MeetingActionItem>) {
    setItems((arr) => arr.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  function addItem() {
    setItems((arr) => [...arr, { title: "" }]);
  }
  function removeItem(i: number) {
    setItems((arr) => arr.filter((_, idx) => idx !== i));
  }

  return (
    <li
      className="border rounded-md p-3 text-sm space-y-3 bg-muted/20"
      data-testid={`meeting-note-editor-${note.id}`}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`edit-title-${note.id}`} className="text-xs">
          Title
        </Label>
        <Input
          id={`edit-title-${note.id}`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          data-testid={`input-edit-meeting-title-${note.id}`}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`edit-summary-${note.id}`} className="text-xs">
          Summary
        </Label>
        <Textarea
          id={`edit-summary-${note.id}`}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={5}
          data-testid={`input-edit-meeting-summary-${note.id}`}
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Action items</Label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={addItem}
            data-testid={`button-add-action-item-${note.id}`}
          >
            <Plus className="h-3 w-3 mr-1" /> Add
          </Button>
        </div>
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">No action items.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((it, i) => (
              <li
                key={i}
                className="grid grid-cols-[1fr_140px_120px_auto] gap-2 items-start"
                data-testid={`edit-action-item-${note.id}-${i}`}
              >
                <Input
                  value={it.title}
                  onChange={(e) => setItem(i, { title: e.target.value })}
                  placeholder="Action item"
                  data-testid={`input-action-title-${note.id}-${i}`}
                />
                <Input
                  value={it.assigneeName ?? ""}
                  onChange={(e) =>
                    setItem(i, { assigneeName: e.target.value || undefined })
                  }
                  placeholder="Assignee"
                  data-testid={`input-action-assignee-${note.id}-${i}`}
                />
                <Input
                  type="date"
                  value={it.dueDate ?? ""}
                  onChange={(e) =>
                    setItem(i, { dueDate: e.target.value || undefined })
                  }
                  data-testid={`input-action-due-${note.id}-${i}`}
                  disabled={!!it.promotedTaskId}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-9 w-9 text-muted-foreground hover:text-destructive"
                  onClick={() => removeItem(i)}
                  disabled={!!it.promotedTaskId}
                  aria-label="Remove action item"
                  title={
                    it.promotedTaskId
                      ? "Already promoted to a task — can't remove"
                      : "Remove"
                  }
                  data-testid={`button-remove-action-item-${note.id}-${i}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
          data-testid={`button-cancel-edit-meeting-${note.id}`}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() =>
            // Drop empty-title action items on save so users don't have to
            // manually delete a row they just clicked Add on.
            onSave({
              title: title.trim() || null,
              aiSummary: summary.trim() || null,
              actionItems: items
                .map((it) => ({ ...it, title: it.title.trim() }))
                .filter((it) => it.title.length > 0),
            })
          }
          disabled={saving}
          data-testid={`button-save-edit-meeting-${note.id}`}
        >
          <Check className="h-3.5 w-3.5 mr-1" />
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </li>
  );
}

/**
 * Paste-or-upload-transcript dialog. Self-contained — `ctx` pins the
 * contact xor. When `unpinned` (global "+ New meeting"), the user picks
 * the contact via a searchable picker that spans people, funders, and
 * households.
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
  const [picked, setPicked] = useState<PickedContact | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
        setPicked(null);
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

  // Pinned ctx wins over the in-dialog picker. The picker is only shown
  // (and only matters) in unpinned mode.
  const effectivePerson = ctx?.personId ?? (picked?.kind === "person" ? picked.id : undefined);
  const effectiveFunder = ctx?.funderId ?? (picked?.kind === "funder" ? picked.id : undefined);
  const effectiveHousehold = ctx?.householdId ?? (picked?.kind === "household" ? picked.id : undefined);
  const contactCount =
    (effectivePerson ? 1 : 0) +
    (effectiveFunder ? 1 : 0) +
    (effectiveHousehold ? 1 : 0);
  const canSubmit = transcript.trim().length > 0 && contactCount === 1;

  // File upload: accept text-shaped transcript files and read them
  // client-side into the textarea so the user can still tweak before
  // submitting. We deliberately don't try to parse VTT cue timestamps —
  // the model handles raw VTT fine, and it preserves speaker labels.
  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    const ext = file.name.toLowerCase().split(".").pop() ?? "";
    const okExt = ["txt", "vtt", "md", "markdown", "srt"].includes(ext);
    const okMime = /^(text\/|application\/(json|x-subrip)$)/i.test(file.type);
    if (!okExt && !okMime) {
      toast({
        title: "Unsupported file type",
        description: "Upload a .txt, .vtt, .srt, or .md transcript.",
        variant: "destructive",
      });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Transcript files must be under 2 MB.",
        variant: "destructive",
      });
      return;
    }
    const text = await file.text();
    setTranscript(text);
    if (!title.trim()) {
      // Use the filename (sans extension) as a sensible default title.
      setTitle(file.name.replace(/\.[^.]+$/, ""));
    }
  }

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
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New meeting note</DialogTitle>
          <DialogDescription>
            Paste the meeting transcript or upload a .txt/.vtt/.md file.
            We'll generate a summary and extract action items you can
            promote to tasks.
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
              <Label>Contact</Label>
              <ContactPicker value={picked} onChange={setPicked} />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="mtg-transcript">Transcript</Label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-upload-transcript"
              >
                <Upload className="h-3.5 w-3.5 mr-1" />
                Upload file
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.vtt,.srt,.md,.markdown,text/plain,text/vtt,text/markdown"
                className="hidden"
                onChange={(e) => {
                  void handleFile(e.target.files?.[0]);
                  // Reset so re-selecting the same file fires onChange.
                  e.target.value = "";
                }}
                data-testid="input-transcript-file"
              />
            </div>
            <Textarea
              id="mtg-transcript"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              rows={10}
              placeholder="Paste the full meeting transcript here, or upload a .txt / .vtt / .md file…"
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

/** Debounced cross-entity contact picker for the unpinned dialog. */
type PickedContact =
  | { kind: "person"; id: string; label: string }
  | { kind: "funder"; id: string; label: string }
  | { kind: "household"; id: string; label: string };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function ContactPicker({
  value,
  onChange,
}: {
  value: PickedContact | null;
  onChange: (v: PickedContact | null) => void;
}) {
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim(), 180);
  const enabled = !value && debounced.length >= 2;
  const params = { search: debounced, limit: 5 };
  const people = useListPeople(params, {
    query: { enabled, queryKey: getListPeopleQueryKey(params) },
  });
  const funders = useListFunders(params, {
    query: { enabled, queryKey: getListFundersQueryKey(params) },
  });
  const households = useListHouseholds(params, {
    query: { enabled, queryKey: getListHouseholdsQueryKey(params) },
  });

  const results = useMemo<PickedContact[]>(() => {
    if (!enabled) return [];
    const out: PickedContact[] = [];
    for (const p of people.data?.data ?? []) {
      out.push({
        kind: "person",
        id: p.id,
        label:
          p.fullName ??
          [p.firstName, p.lastName].filter(Boolean).join(" ") ??
          p.id,
      });
    }
    for (const f of funders.data?.data ?? []) {
      out.push({ kind: "funder", id: f.id, label: f.name });
    }
    for (const h of households.data?.data ?? []) {
      out.push({ kind: "household", id: h.id, label: h.name });
    }
    return out;
  }, [enabled, people.data, funders.data, households.data]);

  if (value) {
    return (
      <div
        className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-sm"
        data-testid="picked-contact"
      >
        <div className="flex items-center gap-2 min-w-0">
          <ContactKindIcon kind={value.kind} />
          <span className="truncate">{value.label}</span>
          <Badge variant="outline" className="text-[10px]">
            {value.kind}
          </Badge>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          onClick={() => onChange(null)}
          aria-label="Clear selected contact"
          data-testid="button-clear-contact"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search people, funders, or households…"
        data-testid="input-contact-search"
      />
      {enabled ? (
        results.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {people.isFetching || funders.isFetching || households.isFetching
              ? "Searching…"
              : "No matches."}
          </p>
        ) : (
          <ul
            className="max-h-48 overflow-y-auto rounded-md border divide-y"
            data-testid="contact-search-results"
          >
            {results.map((r) => (
              <li key={`${r.kind}-${r.id}`}>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-muted text-left"
                  onClick={() => onChange(r)}
                  data-testid={`pick-${r.kind}-${r.id}`}
                >
                  <ContactKindIcon kind={r.kind} />
                  <span className="truncate flex-1">{r.label}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {r.kind}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="text-xs text-muted-foreground">
          Type at least 2 characters.
        </p>
      )}
    </div>
  );
}

function ContactKindIcon({ kind }: { kind: PickedContact["kind"] }) {
  const cls = "h-3.5 w-3.5 shrink-0 text-muted-foreground";
  if (kind === "funder") return <Building2 className={cls} />;
  if (kind === "household") return <Home className={cls} />;
  return <UsersIcon className={cls} />;
}
