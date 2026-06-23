import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListInteractions,
  useListEmailMessages,
  useListCalendarEvents,
  useListEmailProposals,
  useListMeetingNotes,
  useListNotes,
  useListTasks,
  useListMediaMentions,
  useCreateNote,
  useDeleteNote,
  useUpdateTask,
  useDeleteTask,
  getListInteractionsQueryKey,
  getListEmailMessagesQueryKey,
  getListCalendarEventsQueryKey,
  getListEmailProposalsQueryKey,
  getListMeetingNotesQueryKey,
  getListNotesQueryKey,
  getListTasksQueryKey,
  getListMediaMentionsQueryKey,
  type Interaction,
  type EmailMessage,
  type CalendarEvent,
  type EmailProposal,
  type EmailProposalKind,
  type InteractionKind,
  type MeetingNote,
  type Note,
  type Task,
  type TaskStatus,
  type MediaMention,
} from "@workspace/api-client-react";
import {
  AddMeetingNoteDialog,
  MeetingNoteRow,
  type MeetingContext,
} from "@/components/meeting-notes-panel";
import { AddNoteDialog } from "@/components/notes-panel";
import { AddTaskDialog } from "@/components/tasks-panel";
import { type EntityLinks } from "@/components/entity-links-editor";
import { MediaMentionRow } from "@/components/media-mentions-panel";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LogInteractionDialog } from "@/components/log-interaction-dialog";
import { EmailDetailDialog } from "@/components/email-detail-dialog";
import { useUserNameMap } from "@/components/user-picker";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { decodeHtmlEntities } from "@/lib/format";
import {
  Calendar as CalendarIcon,
  Mail,
  MessageSquare,
  Phone,
  Users as UsersIcon,
  Video,
  Lock,
  Paperclip,
  Eye,
  EyeOff,
  ExternalLink,
  Sparkles,
  StickyNote,
  CheckSquare,
  Trash2,
  Check,
} from "lucide-react";

interface NotesContext {
  personId?: string;
  organizationId?: string;
  householdId?: string;
  opportunityId?: string;
  giftId?: string;
  /** Additional IDs to pre-fill (checked but removable) in Add note / Add task dialogs. */
  defaultLinks?: Partial<EntityLinks>;
}

interface Props {
  // Relationship scope for interactions / emails / calendar / meetings /
  // intel — these sources only link to a person, funder, or household.
  personId?: string;
  organizationId?: string;
  householdId?: string;
  // Scope for notes & tasks. Defaults to the relationship scope, but pages
  // like opportunity/gift override it: their activity is the donor's, while
  // notes/tasks link to the opportunity/gift itself. API list filters AND
  // together, so the two scopes must be kept separate.
  notesContext?: NotesContext;
  // When true, tasks are excluded from the feed entirely (source, chip,
  // count, composer button, and query). Used by pages that surface tasks in
  // their own dedicated card instead.
  hideTasks?: boolean;
}

// Discriminated union of every event we can put on the feed. `source`
// drives both the filter chips and the per-source counter; `at` is the
// timestamp used for the merged sort.
type Item =
  | { source: "note"; at: string; row: Note }
  | { source: "task"; at: string; row: Task }
  | { source: "interaction"; at: string; row: Interaction }
  | { source: "email"; at: string; row: EmailMessage }
  | { source: "calendar"; at: string; row: CalendarEvent }
  | { source: "intel"; at: string; row: EmailProposal }
  | { source: "meeting"; at: string; row: MeetingNote }
  | { source: "media"; at: string; row: MediaMention };

type Source = Item["source"];

const SOURCE_LABEL: Record<Source, string> = {
  note: "Notes",
  task: "Tasks",
  interaction: "Interactions",
  email: "Email",
  calendar: "Calendar",
  intel: "Intel",
  meeting: "Meetings",
  media: "Media",
};

const INTERACTION_LABEL: Record<InteractionKind, string> = {
  meeting: "Meeting",
  phone_call: "Phone call",
  video_call: "Video call",
  conference: "Conference",
  other: "Note",
};

const PROPOSAL_KIND_LABEL: Record<EmailProposalKind, string> = {
  linkedin_job_change: "LinkedIn job change",
  bounce_invalid: "Hard bounce",
  bounce_soft: "Soft bounce",
  auto_responder_move: "Auto-responder · moved",
  signature_update: "Signature drift",
  grant_opportunity: "Grant opportunity",
  thank_you_acknowledgment: "Thank-you acknowledgment",
  wildflower_update: "Wildflower update",
};

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  waiting: "Waiting",
  done: "Done",
  cancelled: "Cancelled",
};

const TASK_STATUS_VARIANT: Record<
  TaskStatus,
  "default" | "secondary" | "outline"
> = {
  open: "default",
  waiting: "secondary",
  done: "outline",
  cancelled: "outline",
};

function InteractionIcon({ kind }: { kind: InteractionKind }) {
  const cls = "h-4 w-4";
  switch (kind) {
    case "phone_call":
      return <Phone className={cls} />;
    case "video_call":
      return <Video className={cls} />;
    case "conference":
      return <UsersIcon className={cls} />;
    case "meeting":
      return <UsersIcon className={cls} />;
    default:
      return <MessageSquare className={cls} />;
  }
}

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

const PAGE_SIZE = 50;

export function UnifiedActivityFeed({
  personId,
  organizationId,
  householdId,
  notesContext,
  hideTasks = false,
}: Props) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [activeSource, setActiveSource] = useState<Source | null>(null);
  const [openEmailId, setOpenEmailId] = useState<string | null>(null);

  // Notes/tasks scope — falls back to the relationship scope when no
  // explicit context is given (the common funder/person/household case).
  const nt: NotesContext = notesContext ?? { personId, organizationId, householdId };

  // Interactions / emails / calendar / meetings are only linkable to a
  // person, funder, or household — never to an opportunity or gift. Gate
  // those queries so opportunity/gift pages don't fetch global lists.
  const relationScoped = !!(personId || organizationId || householdId);
  const relParams = { personId, organizationId, householdId, limit };

  const ints = useListInteractions(relParams, {
    query: {
      enabled: relationScoped,
      queryKey: getListInteractionsQueryKey(relParams),
    },
  });
  const emails = useListEmailMessages(relParams, {
    query: {
      enabled: relationScoped,
      queryKey: getListEmailMessagesQueryKey(relParams),
    },
  });
  const cals = useListCalendarEvents(relParams, {
    query: {
      enabled: relationScoped,
      queryKey: getListCalendarEventsQueryKey(relParams),
    },
  });
  const meetings = useListMeetingNotes(relParams, {
    query: {
      enabled: relationScoped,
      queryKey: getListMeetingNotesQueryKey(relParams),
    },
  });

  // Email-intelligence proposals target a single person or funder.
  const proposalsEnabled = !!(personId || organizationId);
  const proposalParams = {
    personId,
    organizationId,
    limit,
    status: "pending" as const,
  };
  const proposals = useListEmailProposals(proposalParams, {
    query: {
      enabled: proposalsEnabled,
      queryKey: getListEmailProposalsQueryKey(proposalParams),
    },
  });

  // Notes + tasks support every context (person/funder/household/opp/gift).
  const noteTaskParams = {
    personId: nt.personId,
    organizationId: nt.organizationId,
    householdId: nt.householdId,
    opportunityId: nt.opportunityId,
    giftId: nt.giftId,
    limit,
  };
  const notes = useListNotes(noteTaskParams, {
    query: { queryKey: getListNotesQueryKey(noteTaskParams) },
  });
  const tasks = useListTasks(noteTaskParams, {
    query: {
      enabled: !hideTasks,
      queryKey: getListTasksQueryKey(noteTaskParams),
    },
  });

  // Media mentions only ever link to a person or funder.
  const mediaEnabled = !!(personId || organizationId);
  const mediaParams = { personId, organizationId, limit };
  const media = useListMediaMentions(mediaParams, {
    query: {
      enabled: mediaEnabled,
      queryKey: getListMediaMentionsQueryKey(mediaParams),
    },
  });

  const userMap = useUserNameMap();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // ---- Inline composer (quick note) -------------------------------
  const [draft, setDraft] = useState("");
  const createNote = useCreateNote({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListNotesQueryKey(),
        });
        toast({ title: "Note saved" });
        setDraft("");
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
  const pinnedIds = (xs: (string | undefined)[]) => {
    const v = xs.filter(Boolean) as string[];
    return v.length ? v : undefined;
  };
  const saveQuickNote = () => {
    const body = draft.trim();
    if (!body) return;
    createNote.mutate({
      data: {
        body,
        personIds: pinnedIds([nt.personId]),
        organizationIds: pinnedIds([nt.organizationId]),
        householdIds: pinnedIds([nt.householdId]),
        opportunityIds: pinnedIds([nt.opportunityId]),
        giftIds: pinnedIds([nt.giftId]),
      },
    });
  };

  // ---- Note / task row mutations ----------------------------------
  const deleteNote = useDeleteNote({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListNotesQueryKey(),
        });
        toast({ title: "Note deleted" });
      },
    },
  });
  const updateTask = useUpdateTask({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListTasksQueryKey(),
        });
      },
    },
  });
  const deleteTask = useDeleteTask({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListTasksQueryKey(),
        });
        toast({ title: "Task deleted" });
      },
    },
  });

  // ---- Merge + sort newest-first ----------------------------------
  const allItems: Item[] = useMemo(() => {
    const merged: Item[] = [
      ...(notes.data?.data ?? []).map<Item>((r) => ({
        source: "note",
        at: r.createdAt,
        row: r,
      })),
      ...(hideTasks
        ? []
        : (tasks.data?.data ?? []).map<Item>((r) => ({
            source: "task" as const,
            at: r.createdAt,
            row: r,
          }))),
      ...(ints.data?.data ?? []).map<Item>((r) => ({
        source: "interaction",
        at: r.occurredAt,
        row: r,
      })),
      ...(emails.data?.data ?? []).map<Item>((r) => ({
        source: "email",
        at: r.sentAt,
        row: r,
      })),
      ...(cals.data?.data ?? []).map<Item>((r) => ({
        source: "calendar",
        at: r.startAt,
        row: r,
      })),
      ...(proposals.data?.data ?? []).map<Item>((r) => ({
        source: "intel",
        at: r.createdAt,
        row: r,
      })),
      ...(meetings.data?.data ?? []).map<Item>((r) => ({
        source: "meeting",
        at: r.meetingDate,
        row: r,
      })),
      ...(media.data?.data ?? []).map<Item>((r) => ({
        source: "media",
        at: r.publicationDate ?? r.createdAt,
        row: r,
      })),
    ];
    merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return merged;
  }, [
    notes.data,
    tasks.data,
    ints.data,
    emails.data,
    cals.data,
    proposals.data,
    meetings.data,
    media.data,
    hideTasks,
  ]);

  const items = useMemo(
    () =>
      activeSource
        ? allItems.filter((it) => it.source === activeSource)
        : allItems,
    [allItems, activeSource],
  );

  const loading =
    notes.isLoading ||
    tasks.isLoading ||
    (relationScoped &&
      (ints.isLoading ||
        emails.isLoading ||
        cals.isLoading ||
        meetings.isLoading)) ||
    (proposalsEnabled && proposals.isLoading) ||
    (mediaEnabled && media.isLoading);

  const counts = useMemo(() => {
    const c: Record<Source, number> = {
      note: notes.data?.pagination.total ?? 0,
      task: hideTasks ? 0 : (tasks.data?.pagination.total ?? 0),
      interaction: relationScoped ? (ints.data?.pagination.total ?? 0) : 0,
      email: relationScoped ? (emails.data?.pagination.total ?? 0) : 0,
      calendar: relationScoped ? (cals.data?.pagination.total ?? 0) : 0,
      intel: proposalsEnabled ? (proposals.data?.pagination.total ?? 0) : 0,
      meeting: relationScoped ? (meetings.data?.pagination.total ?? 0) : 0,
      media: mediaEnabled ? (media.data?.pagination.total ?? 0) : 0,
    };
    return c;
  }, [
    notes.data,
    tasks.data,
    ints.data,
    emails.data,
    cals.data,
    proposals.data,
    meetings.data,
    media.data,
    relationScoped,
    proposalsEnabled,
    mediaEnabled,
    hideTasks,
  ]);

  const totalAll =
    counts.note +
    counts.task +
    counts.interaction +
    counts.email +
    counts.calendar +
    counts.intel +
    counts.meeting +
    counts.media;

  const hasMore = (() => {
    const overCap = (n: number) => n > limit;
    if (activeSource) return overCap(counts[activeSource]);
    return (Object.keys(counts) as Source[]).some((k) => overCap(counts[k]));
  })();

  const chips: { key: Source | "all"; label: string; count: number }[] = [
    { key: "all", label: "All", count: totalAll },
    { key: "note", label: SOURCE_LABEL.note, count: counts.note },
    ...(hideTasks
      ? []
      : [{ key: "task" as const, label: SOURCE_LABEL.task, count: counts.task }]),
    ...(relationScoped
      ? [
          {
            key: "interaction" as const,
            label: SOURCE_LABEL.interaction,
            count: counts.interaction,
          },
          { key: "email" as const, label: SOURCE_LABEL.email, count: counts.email },
          {
            key: "calendar" as const,
            label: SOURCE_LABEL.calendar,
            count: counts.calendar,
          },
          {
            key: "meeting" as const,
            label: SOURCE_LABEL.meeting,
            count: counts.meeting,
          },
        ]
      : []),
    ...(proposalsEnabled
      ? [{ key: "intel" as const, label: SOURCE_LABEL.intel, count: counts.intel }]
      : []),
    ...(mediaEnabled
      ? [{ key: "media" as const, label: SOURCE_LABEL.media, count: counts.media }]
      : []),
  ];

  return (
    <Card data-testid="activity-timeline">
      <CardHeader className="space-y-3">
        <div className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg">Activity</CardTitle>
        </div>

        {/* Pinned composer — quick note box plus quick-action triggers
            that reuse the existing dialogs (no functionality dropped). */}
        <div
          className="rounded-lg border bg-background p-3"
          data-testid="activity-composer"
        >
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note or log an activity…"
            rows={2}
            className="resize-none"
            data-testid="composer-note-input"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <AddNoteDialog ctx={nt} />
              {hideTasks ? null : <AddTaskDialog ctx={nt} />}
              {relationScoped ? (
                <>
                  <LogInteractionDialog
                    prefillPersonId={personId}
                    prefillFunderId={organizationId}
                    prefillHouseholdId={householdId}
                    compact
                  />
                  <AddMeetingNoteDialog
                    ctx={{ personId, organizationId, householdId } as MeetingContext}
                    trigger={
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid="button-take-meeting-notes"
                      >
                        <Sparkles className="mr-1.5 h-4 w-4" />
                        Take meeting notes
                      </Button>
                    }
                  />
                </>
              ) : null}
            </div>
            <Button
              type="button"
              size="sm"
              onClick={saveQuickNote}
              disabled={!draft.trim() || createNote.isPending}
              data-testid="composer-save-note"
            >
              {createNote.isPending ? "Saving…" : "Save note"}
            </Button>
          </div>
        </div>

        {/* Source filter chips. */}
        <div
          className="flex flex-wrap gap-2"
          data-testid="activity-source-chips"
        >
          {chips.map((c) => {
            const isActive =
              (c.key === "all" && activeSource === null) ||
              c.key === activeSource;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() =>
                  setActiveSource(c.key === "all" ? null : (c.key as Source))
                }
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                  isActive
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
                data-testid={`activity-source-${c.key}`}
                data-active={isActive ? "true" : "false"}
              >
                <span>{c.label}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[10px] tabular-nums",
                    isActive ? "bg-primary-foreground/20" : "bg-muted",
                  )}
                >
                  {c.count}
                </span>
              </button>
            );
          })}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {activeSource
              ? `No ${SOURCE_LABEL[activeSource].toLowerCase()} on this record yet.`
              : "No activity yet. Add a note, log an interaction, or connect Gmail / Calendar in Settings."}
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((it) => {
              if (it.source === "note") {
                const r = it.row;
                return (
                  <li
                    key={`note-${r.id}`}
                    className="space-y-1 rounded-md border p-3 text-sm"
                    data-testid={`note-row-${r.id}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <StickyNote className="h-4 w-4 text-muted-foreground" />
                        <Badge variant="secondary">Note</Badge>
                        <span className="text-xs text-muted-foreground">
                          {userMap.get(r.authorUserId) ?? r.authorUserId} ·{" "}
                          {fmtWhen(r.createdAt)}
                        </span>
                      </div>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteNote.mutate({ id: r.id })}
                        disabled={deleteNote.isPending}
                        aria-label="Delete note"
                        data-testid={`button-delete-note-${r.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <p className="whitespace-pre-wrap">{r.body}</p>
                    {r.mentionUserIds && r.mentionUserIds.length > 0 ? (
                      <div className="text-xs text-muted-foreground">
                        Mentions:{" "}
                        {r.mentionUserIds
                          .map((id) => `@${userMap.get(id) ?? id}`)
                          .join(", ")}
                      </div>
                    ) : null}
                  </li>
                );
              }
              if (it.source === "task") {
                const r = it.row;
                return (
                  <li
                    key={`task-${r.id}`}
                    className="space-y-1 rounded-md border p-3 text-sm"
                    data-testid={`task-row-${r.id}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <CheckSquare className="h-4 w-4 text-muted-foreground" />
                        <Badge variant={TASK_STATUS_VARIANT[r.status]}>
                          {TASK_STATUS_LABEL[r.status]}
                        </Badge>
                        <span className="truncate font-medium">{r.title}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Select
                          value={r.status}
                          onValueChange={(v) =>
                            updateTask.mutate({
                              id: r.id,
                              data: { status: v as TaskStatus },
                            })
                          }
                        >
                          <SelectTrigger
                            className="h-7 w-[110px] text-xs"
                            data-testid={`select-task-status-${r.id}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map(
                              (s) => (
                                <SelectItem key={s} value={s}>
                                  {TASK_STATUS_LABEL[s]}
                                </SelectItem>
                              ),
                            )}
                          </SelectContent>
                        </Select>
                        {r.status !== "done" ? (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-muted-foreground hover:text-primary"
                            onClick={() =>
                              updateTask.mutate({
                                id: r.id,
                                data: { status: "done" },
                              })
                            }
                            aria-label="Mark done"
                            data-testid={`button-task-done-${r.id}`}
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => deleteTask.mutate({ id: r.id })}
                          aria-label="Delete task"
                          data-testid={`button-delete-task-${r.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Due {fmtDate(r.dueDate)}
                      {r.assigneeUserId ? (
                        <>
                          {" "}
                          · Assigned to{" "}
                          {userMap.get(r.assigneeUserId) ?? r.assigneeUserId}
                        </>
                      ) : null}
                    </div>
                    {r.description ? (
                      <p className="whitespace-pre-wrap text-muted-foreground">
                        {r.description}
                      </p>
                    ) : null}
                    {r.mentionUserIds && r.mentionUserIds.length > 0 ? (
                      <div className="text-xs text-muted-foreground">
                        Mentions:{" "}
                        {r.mentionUserIds
                          .map((id) => `@${userMap.get(id) ?? id}`)
                          .join(", ")}
                      </div>
                    ) : null}
                  </li>
                );
              }
              if (it.source === "interaction") {
                const r = it.row;
                return (
                  <li
                    key={`int-${r.id}`}
                    className="space-y-1 rounded-md border p-3 text-sm"
                    data-testid={`activity-interaction-${r.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <InteractionIcon kind={r.kind} />
                      <Badge variant="secondary">
                        {INTERACTION_LABEL[r.kind]}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {fmtWhen(r.occurredAt)}
                      </span>
                      {r.durationMinutes ? (
                        <span className="text-xs text-muted-foreground">
                          · {r.durationMinutes} min
                        </span>
                      ) : null}
                    </div>
                    <div className="font-medium">
                      {decodeHtmlEntities(r.summary)}
                    </div>
                    {r.location ? (
                      <div className="text-xs text-muted-foreground">
                        {decodeHtmlEntities(r.location)}
                      </div>
                    ) : null}
                    {r.notes ? (
                      <p className="whitespace-pre-wrap text-muted-foreground">
                        {decodeHtmlEntities(r.notes)}
                      </p>
                    ) : null}
                  </li>
                );
              }
              if (it.source === "email") {
                const r = it.row;
                return (
                  <li
                    key={`email-${r.id}`}
                    className="cursor-pointer space-y-1 rounded-md border p-3 text-sm hover:bg-muted/40"
                    data-testid={`activity-email-${r.id}`}
                    onClick={() => setOpenEmailId(r.id)}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Mail className="h-4 w-4" />
                      <Badge variant="outline">Email · {r.direction}</Badge>
                      {r.isPrivate ? (
                        <Badge variant="secondary" className="gap-1">
                          <Lock className="h-3 w-3" /> Private
                        </Badge>
                      ) : null}
                      {r.hasAttachments ? (
                        <Paperclip className="h-3 w-3 text-muted-foreground" />
                      ) : null}
                      {r.isTracked ? (
                        r.trackingTotalViews && r.trackingTotalViews > 0 ? (
                          <Badge
                            variant="default"
                            className="gap-1"
                            title={
                              r.trackingLastOpenedAt
                                ? `Last opened ${fmtWhen(r.trackingLastOpenedAt)}`
                                : undefined
                            }
                          >
                            <Eye className="h-3 w-3" /> Opened
                            {r.trackingTotalViews > 1
                              ? ` ${r.trackingTotalViews}\u00d7`
                              : ""}
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1">
                            <EyeOff className="h-3 w-3" /> Not opened yet
                          </Badge>
                        )
                      ) : null}
                      <span className="text-xs text-muted-foreground">
                        {fmtWhen(r.sentAt)}
                      </span>
                    </div>
                    <div className="truncate font-medium">
                      {r.subject ? decodeHtmlEntities(r.subject) : "(no subject)"}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {r.fromEmail ?? "(unknown)"}
                      {r.toEmails?.length
                        ? ` → ${r.toEmails.join(", ")}`
                        : ""}
                    </div>
                    {r.snippet ? (
                      <p className="line-clamp-2 text-sm text-muted-foreground">
                        {decodeHtmlEntities(r.snippet)}
                      </p>
                    ) : null}
                  </li>
                );
              }
              if (it.source === "calendar") {
                const r = it.row;
                return (
                  <li
                    key={`cal-${r.id}`}
                    className="space-y-1 rounded-md border p-3 text-sm"
                    data-testid={`activity-calendar-${r.id}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <CalendarIcon className="h-4 w-4" />
                      <Badge variant="outline">Calendar</Badge>
                      {r.isPrivate ? (
                        <Badge variant="secondary" className="gap-1">
                          <Lock className="h-3 w-3" /> Private
                        </Badge>
                      ) : null}
                      {r.status === "cancelled" ? (
                        <Badge variant="destructive">Cancelled</Badge>
                      ) : null}
                      <span className="text-xs text-muted-foreground">
                        {fmtWhen(r.startAt)}
                      </span>
                      {r.htmlLink ? (
                        <a
                          href={r.htmlLink}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-auto inline-flex items-center gap-1 text-xs hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Open <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null}
                    </div>
                    <div className="font-medium">
                      {r.summary ? decodeHtmlEntities(r.summary) : "(no title)"}
                    </div>
                    {r.location ? (
                      <div className="text-xs text-muted-foreground">
                        {decodeHtmlEntities(r.location)}
                      </div>
                    ) : null}
                    {r.attendeeEmails?.length ? (
                      <div className="truncate text-xs text-muted-foreground">
                        {r.attendeeEmails.join(", ")}
                      </div>
                    ) : null}
                    {r.description ? (
                      <p className="line-clamp-2 whitespace-pre-wrap text-muted-foreground">
                        {decodeHtmlEntities(r.description)}
                      </p>
                    ) : null}
                  </li>
                );
              }
              if (it.source === "meeting") {
                return (
                  <MeetingNoteRow key={`mtg-${it.row.id}`} note={it.row} />
                );
              }
              if (it.source === "media") {
                const r = it.row;
                return (
                  <li
                    key={`media-${r.id}`}
                    className="rounded-md border p-3"
                    data-testid={`media-row-${r.id}`}
                  >
                    <MediaMentionRow row={r} />
                  </li>
                );
              }
              // source === "intel"
              const r = it.row;
              return (
                <li
                  key={`intel-${r.id}`}
                  className="space-y-1 rounded-md border bg-amber-50/40 p-3 text-sm dark:bg-amber-950/10"
                  data-testid={`activity-proposal-${r.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Sparkles className="h-4 w-4 text-amber-600" />
                    <Badge variant="outline">
                      {PROPOSAL_KIND_LABEL[r.kind] ?? r.kind}
                    </Badge>
                    <Badge variant="secondary">Pending review</Badge>
                    <span className="text-xs text-muted-foreground">
                      {fmtWhen(r.createdAt)}
                    </span>
                    <Link
                      href="/email-intelligence"
                      className="ml-auto inline-flex items-center gap-1 text-xs hover:underline"
                    >
                      Review <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                  {r.subjectName || r.subjectEmail ? (
                    <div className="truncate font-medium">
                      {r.subjectName ?? r.subjectEmail}
                    </div>
                  ) : null}
                  {r.subjectEmail && r.subjectName ? (
                    <div className="truncate text-xs text-muted-foreground">
                      {r.subjectEmail}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {hasMore ? (
          <div className="flex justify-center pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLimit((l) => l + PAGE_SIZE)}
              data-testid="activity-load-more"
            >
              Load more
            </Button>
          </div>
        ) : null}
      </CardContent>
      <EmailDetailDialog
        emailId={openEmailId}
        onClose={() => setOpenEmailId(null)}
      />
    </Card>
  );
}
