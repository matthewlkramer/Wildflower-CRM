import { useState, type ReactNode } from "react";
import {
  useListTasks,
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
  getListTasksQueryKey,
  useGetTaskProposal,
  useRefreshTaskProposal,
  useAcceptTaskProposal,
  useDismissTaskProposal,
  useReviseTaskProposal,
  getGetTaskProposalQueryKey,
  type Task,
  type TaskStatus,
  type TaskProposal,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Trash2,
  Check,
  ChevronsUpDown,
  Sparkles,
  RefreshCw,
  X,
  MessageSquarePlus,
  Lightbulb,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  EntityLinksEditor,
  EMPTY_LINKS,
  MentionsPicker,
  type EntityLinks,
} from "@/components/entity-links-editor";
import {
  useListUsers,
  getListUsersQueryKey,
} from "@workspace/api-client-react";
import { useUserNameMap, userDisplayName } from "@/components/user-picker";

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  waiting: "Waiting",
  done: "Done",
  cancelled: "Cancelled",
};

const STATUS_VARIANT: Record<TaskStatus, "default" | "secondary" | "outline"> = {
  open: "default",
  waiting: "secondary",
  done: "outline",
  cancelled: "outline",
};

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

interface PanelContext {
  personId?: string;
  organizationId?: string;
  householdId?: string;
  opportunityId?: string;
  giftId?: string;
  grantLeadId?: string;
  /** Additional IDs to pre-fill (checked but removable) when the dialog opens. */
  defaultLinks?: Partial<EntityLinks>;
}

export function TasksPanel(ctx: PanelContext) {
  const { data, isLoading } = useListTasks({
    personId: ctx.personId,
    organizationId: ctx.organizationId,
    householdId: ctx.householdId,
    opportunityId: ctx.opportunityId,
    giftId: ctx.giftId,
    grantLeadId: ctx.grantLeadId,
    limit: 50,
  });
  const rows: Task[] = data?.data ?? [];
  const userMap = useUserNameMap();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateTask({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
      },
    },
  });
  const del = useDeleteTask({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
        toast({ title: "Task deleted" });
      },
    },
  });
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">Tasks</CardTitle>
        <AddTaskDialog ctx={ctx} />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks yet.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((t) => (
              <li
                key={t.id}
                className="border rounded-md p-3 text-sm space-y-1"
                data-testid={`task-row-${t.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant={STATUS_VARIANT[t.status]}>
                      {STATUS_LABEL[t.status]}
                    </Badge>
                    <span className="font-medium truncate">{t.title}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Select
                      value={t.status}
                      onValueChange={(v) =>
                        update.mutate({ id: t.id, data: { status: v as TaskStatus } })
                      }
                    >
                      <SelectTrigger
                        className="h-7 w-[110px] text-xs"
                        data-testid={`select-task-status-${t.id}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
                          <SelectItem key={s} value={s}>
                            {STATUS_LABEL[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {t.status !== "done" ? (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                        onClick={() => update.mutate({ id: t.id, data: { status: "done" } })}
                        aria-label="Mark done"
                        data-testid={`button-task-done-${t.id}`}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => del.mutate({ id: t.id })}
                      aria-label="Delete task"
                      data-testid={`button-delete-task-${t.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  Due {formatDate(t.dueDate)}
                  {t.assigneeUserId ? (
                    <> · Assigned to {userMap.get(t.assigneeUserId) ?? t.assigneeUserId}</>
                  ) : null}
                </div>
                {t.description ? (
                  <p className="whitespace-pre-wrap text-muted-foreground">{t.description}</p>
                ) : null}
                {t.mentionUserIds && t.mentionUserIds.length > 0 ? (
                  <div className="text-xs text-muted-foreground">
                    Mentions:{" "}
                    {t.mentionUserIds
                      .map((id) => `@${userMap.get(id) ?? id}`)
                      .join(", ")}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {(ctx.personId || ctx.organizationId) ? (
          <TaskSuggestion
            personId={ctx.personId}
            organizationId={ctx.organizationId}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * AI-suggested next-step cultivation task, surfaced below the real task list.
 *
 * On-demand hybrid: the GET generates + caches one pending suggestion per
 * entity on first view, so this renders instantly on later visits. Accepting
 * spins up a real task (which then shows in the list above); dismissing files
 * the suggestion away with an optional note. Low-priority entities return
 * `data: null` and we render nothing.
 */
function TaskSuggestion({
  personId,
  organizationId,
}: {
  personId?: string;
  organizationId?: string;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Accept-with-note / dismiss-with-note share one dialog, keyed by mode.
  const [noteMode, setNoteMode] = useState<"accept" | "dismiss" | null>(null);
  const [reviewerNote, setReviewerNote] = useState("");
  // "Propose alternative" dialog state.
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposeText, setProposeText] = useState("");

  const proposalParams = { personId, organizationId };
  const { data, isLoading } = useGetTaskProposal(proposalParams);
  const proposal: TaskProposal | null = data?.data ?? null;

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: getGetTaskProposalQueryKey(proposalParams),
      }),
      queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() }),
    ]);
  };

  const refresh = useRefreshTaskProposal({
    mutation: {
      onSuccess: async () => {
        await invalidate();
      },
      onError: (err: unknown) =>
        toast({
          title: "Couldn't refresh suggestion",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });
  const accept = useAcceptTaskProposal({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        setNoteMode(null);
        setReviewerNote("");
        toast({ title: "Task created from suggestion" });
      },
      onError: (err: unknown) =>
        toast({
          title: "Couldn't accept suggestion",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });
  const dismiss = useDismissTaskProposal({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        setNoteMode(null);
        setReviewerNote("");
        toast({ title: "Suggestion dismissed" });
      },
      onError: (err: unknown) =>
        toast({
          title: "Couldn't dismiss suggestion",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });
  // "Propose alternative": re-runs the AI with the reviewer's plain-English
  // guidance folded in; the suggestion stays pending and refreshes in place.
  const revise = useReviseTaskProposal({
    mutation: {
      onSuccess: async (res) => {
        await invalidate();
        setProposeOpen(false);
        setProposeText("");
        if (res?.data?.error && !res.data.title) {
          toast({
            title: "Re-analysis failed",
            description:
              "Your note was saved, but the AI couldn't refresh the suggestion. Try again shortly.",
            variant: "destructive",
          });
        } else {
          toast({ title: "Suggestion updated" });
        }
      },
      onError: (err: unknown) =>
        toast({
          title: "Couldn't update suggestion",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  const busy =
    refresh.isPending ||
    accept.isPending ||
    dismiss.isPending ||
    revise.isPending;

  const [expanded, setExpanded] = useState(false);

  // Nothing cached yet, still generating the very first one.
  if (isLoading) {
    return (
      <div className="mb-3 rounded-md border border-dashed p-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Sparkles className="h-4 w-4 animate-pulse text-primary" />
          Generating suggested next step…
        </div>
      </div>
    );
  }

  // Low-priority entity (skipped) or no suggestion available.
  if (!proposal) return null;

  // Suggestion row exists but the AI call hasn't finished writing it yet.
  const generating = !proposal.analyzedAt;
  // The AI ran but judged no action warranted, or the call errored.
  const noAction = proposal.error === "no_action_warranted";
  const hadError = !!proposal.error && !noAction && !proposal.title;

  // Real suggestion with title: collapse to one line by default.
  const hasRealSuggestion = !generating && !noAction && !hadError;
  const showBody = !hasRealSuggestion || expanded;

  return (
    <div
      className="mb-3 rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2"
      data-testid="task-suggestion"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Badge variant="secondary" className="gap-1 shrink-0">
            <Sparkles className="h-3 w-3" />
            Suggested
          </Badge>
          {hasRealSuggestion ? (
            <button
              type="button"
              className="flex items-center gap-1 min-w-0 flex-1 text-left"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              data-testid="button-expand-suggestion"
            >
              <span className="font-medium truncate" data-testid="text-suggestion-title">
                {proposal.title}
              </span>
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                  expanded && "rotate-180",
                )}
              />
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-primary"
            onClick={() =>
              refresh.mutate({ data: { personId, organizationId } })
            }
            disabled={busy}
            aria-label="Refresh suggestion"
            data-testid="button-refresh-suggestion"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refresh.isPending && "animate-spin")} />
          </Button>
        </div>
      </div>

      {showBody && (generating ? (
        <p className="text-sm text-muted-foreground">Thinking through the next best step…</p>
      ) : noAction ? (
        <p className="text-sm text-muted-foreground">
          No next step recommended right now.
          {proposal.rationale ? ` ${proposal.rationale}` : ""}
        </p>
      ) : hadError ? (
        <p className="text-sm text-muted-foreground">
          Couldn't generate a suggestion. Try refreshing.
        </p>
      ) : (
        <>
          {proposal.description ? (
            <p className="text-sm whitespace-pre-wrap text-foreground/90">
              {proposal.description}
            </p>
          ) : null}
          <div className="text-xs text-muted-foreground">
            {proposal.suggestedDueDate ? (
              <>Suggested due {formatDate(proposal.suggestedDueDate)}</>
            ) : (
              <>No suggested due date</>
            )}
          </div>
          {proposal.rationale ? (
            <p className="text-xs italic text-muted-foreground" data-testid="text-suggestion-rationale">
              Why: {proposal.rationale}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              onClick={() => accept.mutate({ id: proposal.id, data: {} })}
              disabled={busy}
              data-testid="button-accept-suggestion"
            >
              <Check className="mr-1 h-3.5 w-3.5" />
              {accept.isPending ? "Adding…" : "Accept"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setReviewerNote("");
                setNoteMode("accept");
              }}
              data-testid="button-accept-note-suggestion"
            >
              <MessageSquarePlus className="mr-1 h-3.5 w-3.5" />
              Accept + note
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setProposeText("");
                setProposeOpen(true);
              }}
              data-testid="button-propose-alt-suggestion"
            >
              <Lightbulb
                className={cn("mr-1 h-3.5 w-3.5", revise.isPending && "animate-pulse")}
              />
              {revise.isPending ? "Re-analyzing…" : "Propose alternative"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setReviewerNote("");
                setNoteMode("dismiss");
              }}
              data-testid="button-dismiss-suggestion"
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Dismiss
            </Button>
          </div>
        </>
      ))}

      {/* Accept-with-note / dismiss-with-note share one dialog. */}
      <Dialog
        open={noteMode !== null}
        onOpenChange={(open) => {
          if (!open && !accept.isPending && !dismiss.isPending) setNoteMode(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {noteMode === "accept" ? "Accept suggestion" : "Dismiss suggestion"}
            </DialogTitle>
            <DialogDescription>
              {noteMode === "accept"
                ? "Optional — anything notable about why this next step was right? It's saved for tuning future suggestions. Leave blank to accept without a note."
                : "Optional — tell us why this suggestion wasn't right. It's saved for tuning future suggestions. Leave blank to dismiss without a note."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="task-reviewer-note">Reviewer note</Label>
            <Textarea
              id="task-reviewer-note"
              value={reviewerNote}
              onChange={(e) => setReviewerNote(e.target.value)}
              rows={4}
              placeholder={
                noteMode === "accept"
                  ? "e.g. Good timing — they just closed a related gift"
                  : "e.g. Already handled, or not a priority right now"
              }
              data-testid="input-task-reviewer-note"
              className="w-full resize-y"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNoteMode(null)}
              disabled={accept.isPending || dismiss.isPending}
            >
              Cancel
            </Button>
            <Button
              disabled={accept.isPending || dismiss.isPending}
              onClick={() => {
                if (!noteMode) return;
                const note = reviewerNote.trim() || undefined;
                if (noteMode === "accept") {
                  accept.mutate({ id: proposal.id, data: { reviewerNote: note } });
                } else {
                  dismiss.mutate({ id: proposal.id, data: { reviewerNote: note } });
                }
              }}
              data-testid="button-confirm-note"
            >
              {noteMode === "accept"
                ? accept.isPending
                  ? "Adding…"
                  : "Accept"
                : dismiss.isPending
                  ? "Dismissing…"
                  : "Dismiss"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Propose alternative — re-run the AI with reviewer guidance in place. */}
      <Dialog
        open={proposeOpen}
        onOpenChange={(open) => {
          if (!open && !revise.isPending) setProposeOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Propose alternative</DialogTitle>
            <DialogDescription>
              Tell the AI how to improve its suggestion in plain English — e.g.
              "they already gave this year, suggest a stewardship thank-you
              instead of an ask." It re-runs with your guidance and refreshes the
              suggestion in place. Your comment is saved with the other reviewer
              notes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="task-propose-alt">Your instruction</Label>
            <Textarea
              id="task-propose-alt"
              value={proposeText}
              onChange={(e) => setProposeText(e.target.value)}
              rows={4}
              placeholder="e.g. Focus on re-engaging after the long gap, not a new ask"
              data-testid="input-task-propose-alt"
              className="w-full resize-y"
              disabled={revise.isPending}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setProposeOpen(false)}
              disabled={revise.isPending}
            >
              Cancel
            </Button>
            <Button
              disabled={!proposeText.trim() || revise.isPending}
              onClick={() => {
                const text = proposeText.trim();
                if (!text) return;
                revise.mutate({
                  id: proposal.id,
                  data: { reviewerGuidance: text },
                });
              }}
              data-testid="button-confirm-propose-alt"
            >
              {revise.isPending ? (
                <>
                  <RefreshCw className="mr-1.5 h-4 w-4 animate-spin" />
                  Re-analyzing…
                </>
              ) : (
                "Re-analyze"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function AddTaskDialog({
  ctx,
  trigger,
}: {
  ctx: PanelContext;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [assigneeUserId, setAssigneeUserId] = useState<string>("");
  const [links, setLinks] = useState<EntityLinks>(() => linksFromDefault(ctx.defaultLinks));
  const [mentions, setMentions] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: users } = useListUsers({
    query: { queryKey: getListUsersQueryKey(), staleTime: 60_000 },
  });
  const userOpts = (users ?? []).map((u) => ({ id: u.id, label: userDisplayName(u) }));
  const create = useCreateTask({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
        toast({ title: "Task created" });
        setOpen(false);
        setTitle("");
        setDescription("");
        setDueDate("");
        setAssigneeUserId("");
        setLinks(linksFromDefault(ctx.defaultLinks));
        setMentions([]);
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
  const pinned = pinnedFromCtx(ctx);
  const canSubmit = title.trim().length > 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!create.isPending) {
          if (v) setLinks(linksFromDefault(ctx.defaultLinks));
          setOpen(v);
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" data-testid="button-add-task">
            Add task
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add task</DialogTitle>
          <DialogDescription>
            Create a task and link it to one or more records.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            create.mutate({
              data: {
                title: title.trim(),
                description: description.trim() || undefined,
                dueDate: dueDate || undefined,
                assigneeUserId: assigneeUserId || undefined,
                personIds: mergeLinks(pinned.personIds, links.personIds),
                organizationIds: mergeLinks(pinned.organizationIds, links.organizationIds),
                householdIds: mergeLinks(pinned.householdIds, links.householdIds),
                opportunityIds: mergeLinks(pinned.opportunityIds, links.opportunityIds),
                giftIds: mergeLinks(pinned.giftIds, links.giftIds),
                grantLeadIds: mergeLinks(pinned.grantLeadIds, links.grantLeadIds),
                mentionUserIds: mentions.length > 0 ? mentions : undefined,
              },
            });
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              data-testid="input-task-title"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="task-due">Due date</Label>
              <Input
                id="task-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                data-testid="input-task-due"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-assignee">Assignee</Label>
              <AssigneeCombobox
                value={assigneeUserId}
                onChange={setAssigneeUserId}
                users={userOpts}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-description">Description</Label>
            <Textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              data-testid="input-task-description"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Linked records</Label>
            <EntityLinksEditor value={links} onChange={setLinks} pinned={pinned} />
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
              data-testid="button-save-task"
            >
              {create.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssigneeCombobox({
  value,
  onChange,
  users,
}: {
  value: string;
  onChange: (next: string) => void;
  users: { id: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Reset the search filter whenever the popover closes so reopening starts fresh.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed
    ? users.filter((u) => u.label.toLowerCase().includes(trimmed))
    : users;
  const selected = value ? users.find((u) => u.id === value) : undefined;
  const triggerLabel = value ? (selected?.label ?? value) : "Unassigned";
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id="task-assignee"
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          data-testid="select-task-assignee"
          className="h-9 w-full justify-between font-normal"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[--radix-popover-trigger-width] min-w-[220px]"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search people…"
            data-testid="select-task-assignee-search"
          />
          <CommandList>
            {filtered.length === 0 ? (
              // Plain element, not <CommandEmpty>: cmdk hides CommandEmpty
              // whenever ANY item renders, and the "Unassigned" item below is
              // always rendered, so CommandEmpty never appeared.
              <div className="py-3 text-center text-sm text-muted-foreground">
                No results.
              </div>
            ) : null}
            <CommandGroup>
              <CommandItem
                value="__none__"
                onSelect={() => {
                  onChange("");
                  handleOpenChange(false);
                }}
                data-testid="select-task-assignee-option-none"
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    value === "" ? "opacity-100" : "opacity-0",
                  )}
                />
                Unassigned
              </CommandItem>
              {filtered.map((u) => (
                <CommandItem
                  key={u.id}
                  value={u.id}
                  onSelect={() => {
                    onChange(u.id);
                    handleOpenChange(false);
                  }}
                  data-testid={`select-task-assignee-option-${u.id}`}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === u.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{u.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function pinnedFromCtx(ctx: PanelContext): EntityLinks {
  return {
    personIds: ctx.personId ? [ctx.personId] : [],
    organizationIds: ctx.organizationId ? [ctx.organizationId] : [],
    householdIds: ctx.householdId ? [ctx.householdId] : [],
    opportunityIds: ctx.opportunityId ? [ctx.opportunityId] : [],
    giftIds: ctx.giftId ? [ctx.giftId] : [],
    grantLeadIds: ctx.grantLeadId ? [ctx.grantLeadId] : [],
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
