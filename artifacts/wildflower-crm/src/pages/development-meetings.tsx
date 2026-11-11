import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useParams, useSearch } from "wouter";
import {
  addDevelopmentAgendaItem,
  assignDevelopmentAction,
  createDevelopmentMeeting,
  generateMeetingNextSteps,
  getGetDevelopmentMeetingQueryKey,
  getGetOrganizationQueryKey,
  getGetPersonQueryKey,
  getGetHouseholdQueryKey,
  getListDevelopmentMeetingsQueryKey,
  getListTasksQueryKey,
  removeDevelopmentAgendaItem,
  summarizeDevelopmentTranscript,
  updateDevelopmentAgendaItem,
  useGetCurrentUser,
  useGetDevelopmentMeeting,
  useGetHousehold,
  useGetOrganization,
  useGetPerson,
  useListDevelopmentDonorSuggestions,
  useListDevelopmentMeetings,
  useListInteractions,
  useListOpportunitiesAndPledges,
  useListTasks,
  useListUsers,
  type AddDevelopmentAgendaItemBody,
  type DevelopmentAgendaItem,
  type DevelopmentMeeting,
  type MeetingActionItem,
  type UpdateDevelopmentAgendaItemBody,
  type User,
} from "@workspace/api-client-react";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  ContactPicker,
  type PickedContact,
} from "@/components/meeting-notes-panel";
import { developmentDateNow } from "@/components/fundraising-brief";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate } from "@/lib/format";

const STATUS = {
  pending: "To discuss",
  discussing: "Discussing",
  done: "Discussed",
  deferred: "Deferred",
};

function describeError(error: unknown) {
  return error instanceof Error ? error.message : undefined;
}

export function DevelopmentMeetingHistory() {
  const { data: viewer } = useGetCurrentUser();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const searchParams = new URLSearchParams(useSearch());
  const [donor, setDonor] = useState<PickedContact | null>(null);
  const [before, setBefore] = useState<string>();
  const [date, setDate] = useState(developmentDateNow);
  const [saving, setSaving] = useState(false);
  const filter = {
    organizationId:
      donor?.kind === "organization"
        ? donor.id
        : (searchParams.get("organizationId") ?? undefined),
    personId:
      donor?.kind === "person"
        ? donor.id
        : (searchParams.get("personId") ?? undefined),
    householdId:
      donor?.kind === "household"
        ? donor.id
        : (searchParams.get("householdId") ?? undefined),
  };
  const meetings = useListDevelopmentMeetings({ before, ...filter });
  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const meeting = await createDevelopmentMeeting({ date });
      navigate("/meetings/development/" + meeting.note.id);
    } catch (error) {
      toast({
        title: "Could not open meeting",
        description: describeError(error),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-5">
      <Link href="/meetings" className="text-sm text-primary hover:underline">
        All meetings
      </Link>
      <h1 className="text-3xl font-serif font-bold">
        Weekly development meetings
      </h1>
      {viewer && viewer.role !== "read_only" && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => void start(event)}
        >
          <label className="grid gap-1 text-sm">
            Meeting date
            <Input
              type="date"
              required
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={saving || !date}>
            {saving ? "Opening…" : "Open weekly agenda"}
          </Button>
        </form>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Meeting history</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {["organizationId", "personId", "householdId"].some((key) =>
            searchParams.has(key),
          ) ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/meetings/development">
                Show all development meetings
              </Link>
            </Button>
          ) : (
            <div className="max-w-sm">
              <p className="mb-1 text-sm">Filter by donor</p>
              <ContactPicker
                value={donor}
                onChange={(contact) => {
                  setDonor(contact);
                  setBefore(undefined);
                }}
              />
            </div>
          )}
          {meetings.isLoading && (
            <p className="text-sm text-muted-foreground">
              Loading meeting history…
            </p>
          )}
          {meetings.isError && (
            <p className="text-sm text-destructive">
              Meeting history could not be loaded.
            </p>
          )}
          {meetings.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No development meetings found.
            </p>
          )}
          <ul className="divide-y">
            {meetings.data?.map((meeting) => {
              const decisions = meeting.agenda.filter((item) =>
                item.decision.trim(),
              ).length;
              return (
                <li
                  key={meeting.note.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-3"
                >
                  <Link
                    className="text-primary hover:underline"
                    href={"/meetings/development/" + meeting.note.id}
                  >
                    {formatDate(meeting.note.meetingDate.slice(0, 10))}
                  </Link>
                  <span className="text-sm text-muted-foreground">
                    {
                      meeting.agenda.filter((item) => item.status === "done")
                        .length
                    }{" "}
                    of {meeting.agenda.length} discussed
                    {decisions > 0 &&
                      " · " +
                        decisions +
                        (decisions === 1 ? " decision" : " decisions")}
                  </span>
                </li>
              );
            })}
          </ul>
          {before && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setBefore(undefined)}
            >
              Most recent
            </Button>
          )}
          {(meetings.data?.length ?? 0) === 16 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setBefore(meetings.data?.at(-1)?.weekStart)}
            >
              Older meetings
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DonorContext({
  item,
  users,
}: {
  item: DevelopmentAgendaItem;
  users: User[];
}) {
  const org = useGetOrganization(item.organizationId ?? "", {
    query: {
      enabled: !!item.organizationId,
      queryKey: getGetOrganizationQueryKey(item.organizationId ?? ""),
    },
  });
  const person = useGetPerson(item.personId ?? "", {
    query: {
      enabled: !!item.personId,
      queryKey: getGetPersonQueryKey(item.personId ?? ""),
    },
  });
  const household = useGetHousehold(item.householdId ?? "", {
    query: {
      enabled: !!item.householdId,
      queryKey: getGetHouseholdQueryKey(item.householdId ?? ""),
    },
  });
  const scope = {
    organizationId: item.organizationId ?? undefined,
    personId: item.personId ?? undefined,
    householdId: item.householdId ?? undefined,
  };
  const donorLink = item.organizationId
    ? "/organizations/" + item.organizationId
    : item.personId
      ? "/people/" + item.personId
      : "/households/" + item.householdId;
  const opportunities = useListOpportunitiesAndPledges({
    organizationId: scope.organizationId,
    householdId: scope.householdId,
    individualGiverPersonId: scope.personId,
    status: ["open", "pledge"],
    limit: 8,
  });
  const activity = useListInteractions({
    ...scope,
    includeLinkedPeople: !!scope.organizationId,
    limit: 3,
  });
  const tasks = useListTasks({
    ...scope,
    status: ["open", "waiting"],
    limit: 8,
  });
  const ownerId = org.data?.ownerUserId ?? person.data?.ownerUserId;
  const owner = users.find((user) => user.id === ownerId);
  const name = org.data?.name ?? person.data?.fullName ?? household.data?.name;
  return (
    <section
      className="space-y-3 rounded-md border bg-muted/20 p-3 text-sm"
      aria-label="Donor context"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link
          className="font-medium text-primary hover:underline"
          href={donorLink}
        >
          {name || "Open donor record"}
        </Link>
        {owner && (
          <span className="text-muted-foreground">
            · Owner {owner.displayName || owner.email}
          </span>
        )}
        <Link
          className="ml-auto text-primary hover:underline"
          href={
            "/meetings/development?" +
            new URLSearchParams(
              item.organizationId
                ? { organizationId: item.organizationId }
                : item.personId
                  ? { personId: item.personId }
                  : { householdId: item.householdId! },
            )
          }
        >
          Meeting history for this donor
        </Link>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <p className="font-medium">Open asks and pledges</p>
          {opportunities.isError && (
            <p className="text-destructive">Could not load opportunities.</p>
          )}
          {opportunities.data?.data.length === 0 && (
            <p className="text-muted-foreground">None open.</p>
          )}
          <ul className="space-y-1">
            {opportunities.data?.data.map((row) => (
              <li key={row.id}>
                <Link
                  className="text-primary hover:underline"
                  href={"/opportunities/" + row.id}
                >
                  {row.name || "Opportunity"}
                </Link>
                <div className="text-xs text-muted-foreground">
                  {row.status === "pledge" ? "Pledge" : "Open ask"} ·{" "}
                  {formatCurrency(row.awardedAmount ?? row.askAmount)}
                  {row.applicationDeadline &&
                    " · Due " + formatDate(row.applicationDeadline)}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-medium">Recent activity</p>
          {activity.isError && (
            <p className="text-destructive">Could not load activity.</p>
          )}
          {activity.data?.data.length === 0 && (
            <p className="text-muted-foreground">No logged interactions.</p>
          )}
          <ul className="space-y-1">
            {activity.data?.data.map((row) => (
              <li key={row.id} className="line-clamp-2">
                {formatDate(row.occurredAt.slice(0, 10))} · {row.summary}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-medium">Open tasks</p>
          {tasks.isError && (
            <p className="text-destructive">Could not load tasks.</p>
          )}
          {tasks.data?.data.length === 0 && (
            <p className="text-muted-foreground">None open.</p>
          )}
          <ul className="space-y-1">
            {tasks.data?.data.map((task) => (
              <li key={task.id}>
                {task.title}
                {task.dueDate && " · Due " + formatDate(task.dueDate)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function AgendaItemEditor({
  item,
  meetingId,
  users,
  suggestions,
  readOnly,
  first,
  last,
  onUpdate,
  onTask,
}: {
  item: DevelopmentAgendaItem;
  meetingId: string;
  users: User[];
  suggestions: MeetingActionItem[];
  readOnly: boolean;
  first: boolean;
  last: boolean;
  onUpdate: (updated?: DevelopmentMeeting) => Promise<void>;
  onTask: () => void;
}) {
  const { toast } = useToast();
  const [opened, setOpened] = useState(item.status === "discussing");
  useEffect(() => {
    if (item.status === "discussing") setOpened(true);
  }, [item.status]);
  const [draft, setDraft] = useState(() => ({
    title: item.title,
    notes: item.notes,
    decision: item.decision,
    revision: item.revision,
    dirty: false,
  }));
  const [saving, setSaving] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID());
  const changed =
    item.title !== draft.title ||
    item.notes !== draft.notes ||
    item.decision !== draft.decision;
  const stale = changed && item.revision !== draft.revision;

  useEffect(() => {
    setDraft((previous) =>
      previous.revision === item.revision
        ? previous
        : previous.dirty
          ? previous
          : {
              title: item.title,
              notes: item.notes,
              decision: item.decision,
              revision: item.revision,
              dirty: false,
            },
    );
  }, [item.title, item.notes, item.decision, item.revision]);

  async function update(
    fields: Omit<UpdateDevelopmentAgendaItemBody, "revision">,
  ) {
    setSaving(true);
    try {
      const updated = await updateDevelopmentAgendaItem(meetingId, item.id, {
        revision: draft.revision,
        ...fields,
      });
      const saved = updated.agenda.find((row) => row.id === item.id);
      if (saved)
        setDraft({
          title: saved.title,
          notes: saved.notes,
          decision: saved.decision,
          revision: saved.revision,
          dirty: false,
        });
      await onUpdate(updated);
    } catch (error) {
      await onUpdate();
      toast({
        title: "Could not save agenda item",
        description: describeError(error),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    setSaving(true);
    try {
      await onUpdate(await removeDevelopmentAgendaItem(meetingId, item.id));
    } catch (error) {
      toast({
        title: "Could not remove agenda item",
        description: describeError(error),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }
  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await assignDevelopmentAction(meetingId, item.id, {
        requestId,
        title: taskTitle.trim(),
        assigneeUserId: assignee,
        dueDate: dueDate || undefined,
      });
      setTaskTitle("");
      setAssignee("");
      setDueDate("");
      setRequestId(crypto.randomUUID());
      await onUpdate();
      onTask();
    } catch (error) {
      toast({
        title: "Could not assign task",
        description: describeError(error),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }
  const handleDraft = (field: "title" | "notes" | "decision", value: string) =>
    setDraft((current) => ({ ...current, [field]: value, dirty: true }));
  const saveDraft = () => ({
    title: draft.title,
    notes: draft.notes,
    decision: draft.decision,
  });
  return (
    <section
      className={
        item.status === "discussing"
          ? "rounded-md border border-primary"
          : "rounded-md border"
      }
    >
      <button
        className="flex w-full items-center justify-between gap-3 p-3 text-left"
        type="button"
        aria-expanded={opened}
        onClick={() => setOpened(!opened)}
      >
        <span className="font-medium">{item.title}</span>
        <span className="flex flex-wrap items-center justify-end gap-2">
          {item.carriedFromId && (
            <Badge variant="outline">Carried forward</Badge>
          )}
          <Badge
            variant={item.status === "discussing" ? "default" : "secondary"}
          >
            {STATUS[item.status]}
          </Badge>
        </span>
      </button>
      {opened && (
        <div className="space-y-4 border-t p-3">
          {(item.organizationId || item.personId || item.householdId) && (
            <DonorContext item={item} users={users} />
          )}
          {item.findingKind === "grant_lead" && (
            <Link
              className="text-sm text-primary hover:underline"
              href={"/grant-leads?lead=" + item.findingId}
            >
              Open grant lead
            </Link>
          )}
          {item.sourceUrl && (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-primary hover:underline"
            >
              Open public source
            </a>
          )}
          <div className="grid gap-3">
            {!readOnly && (
              <label className="grid gap-1 text-sm">
                Agenda title
                <Input
                  value={draft.title}
                  maxLength={300}
                  onChange={(event) => handleDraft("title", event.target.value)}
                />
              </label>
            )}
            <label className="grid gap-1 text-sm">
              Discussion notes
              <Textarea
                rows={3}
                value={draft.notes}
                maxLength={20000}
                readOnly={readOnly}
                onChange={(event) => handleDraft("notes", event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Decision
              <Textarea
                rows={2}
                value={draft.decision}
                maxLength={20000}
                readOnly={readOnly}
                onChange={(event) =>
                  handleDraft("decision", event.target.value)
                }
              />
            </label>
          </div>
          {stale && (
            <div className="space-y-2 rounded-md border border-amber-400 p-3 text-sm">
              <p>
                A teammate saved a newer version. Review it before saving your
                draft.
              </p>
              <p className="whitespace-pre-wrap">
                {[item.title, item.notes, item.decision]
                  .filter(Boolean)
                  .join("\n")}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDraft({ ...draft, revision: item.revision })}
              >
                Keep my draft
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setDraft({
                    title: item.title,
                    notes: item.notes,
                    decision: item.decision,
                    revision: item.revision,
                    dirty: false,
                  })
                }
              >
                Use saved version
              </Button>
            </div>
          )}
          {!readOnly && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={saving || !changed || !draft.title.trim() || stale}
                onClick={() => void update(saveDraft())}
              >
                Save notes
              </Button>
              {item.status !== "discussing" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving || stale || !draft.title.trim()}
                  onClick={() =>
                    void update({ ...saveDraft(), status: "discussing" })
                  }
                >
                  Start discussion
                </Button>
              )}
              {item.status !== "done" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving || stale || !draft.title.trim()}
                  onClick={() =>
                    void update({ ...saveDraft(), status: "done" })
                  }
                >
                  Mark discussed
                </Button>
              )}
              {item.status !== "deferred" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving || stale || !draft.title.trim()}
                  onClick={() =>
                    void update({ ...saveDraft(), status: "deferred" })
                  }
                >
                  Defer
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                aria-label="Move up"
                disabled={first || saving || changed}
                onClick={() => void update({ move: "up" })}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Move down"
                disabled={last || saving || changed}
                onClick={() => void update({ move: "down" })}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              {!item.tasks.length &&
                !item.notes.trim() &&
                !item.decision.trim() &&
                item.status !== "done" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving || changed}
                    onClick={() => void remove()}
                  >
                    Remove
                  </Button>
                )}
            </div>
          )}
          {item.tasks.length > 0 && (
            <div>
              <h3 className="text-sm font-medium">Assigned next steps</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {item.tasks.map((task) => {
                  const owner = users.find(
                    (user) => user.id === task.assigneeUserId,
                  );
                  return (
                    <li key={task.id}>
                      {task.title} ·{" "}
                      {task.status === "done" ? "Done" : task.status}{" "}
                      {owner && " · " + (owner.displayName || owner.email)}{" "}
                      {task.dueDate && " · Due " + formatDate(task.dueDate)}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {!readOnly && (
            <form
              className="space-y-2 border-t pt-3"
              onSubmit={(event) => void assign(event)}
            >
              <h3 className="text-sm font-medium">Assign a next step</h3>
              {suggestions.length > 0 && (
                <select
                  aria-label="Use a suggested next step"
                  className="w-full rounded-md border bg-background p-2 text-sm"
                  value=""
                  onChange={(event) => {
                    const suggestion = suggestions[Number(event.target.value)];
                    if (!event.target.value || !suggestion) return;
                    setTaskTitle(suggestion.title);
                    setDueDate(suggestion.dueDate?.slice(0, 10) ?? "");
                    const match = users.find(
                      (user) =>
                        user.displayName &&
                        user.displayName === suggestion.assigneeName,
                    );
                    setAssignee(match?.id ?? "");
                    setRequestId(
                      "suggested:" +
                        suggestion.title.toLowerCase().slice(0, 100),
                    );
                  }}
                >
                  <option value="">Use a suggested next step…</option>
                  {suggestions.map((suggestion, index) => (
                    <option key={index} value={index}>
                      {suggestion.title}
                    </option>
                  ))}
                </select>
              )}
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,0.5fr)_auto]">
                <Input
                  required
                  maxLength={300}
                  aria-label="Task title"
                  placeholder="What needs to happen?"
                  value={taskTitle}
                  onChange={(event) => setTaskTitle(event.target.value)}
                />
                <select
                  required
                  aria-label="Assign to"
                  className="rounded-md border bg-background p-2 text-sm"
                  value={assignee}
                  onChange={(event) => setAssignee(event.target.value)}
                >
                  <option value="">Assign to…</option>
                  {users
                    .filter((user) => !user.archivedAt)
                    .map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName || user.email}
                      </option>
                    ))}
                </select>
                <Input
                  type="date"
                  aria-label="Task due date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                />
              </div>
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={saving || !taskTitle.trim() || !assignee}
              >
                Create assigned task
              </Button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}

function DevelopmentMeetingEditor({
  meeting,
  readOnly,
}: {
  meeting: DevelopmentMeeting;
  readOnly: boolean;
}) {
  const id = meeting.note.id;
  const client = useQueryClient();
  const { toast } = useToast();
  const { data: users = [] } = useListUsers();
  const donorSuggestions = useListDevelopmentDonorSuggestions({
    query: {
      enabled: !readOnly,
      queryKey: ["/api/development-meetings/suggested-donors"],
    },
  });
  const [title, setTitle] = useState("");
  const [donor, setDonor] = useState<PickedContact | null>(null);
  const [saving, setSaving] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [suggestions, setSuggestions] = useState<MeetingActionItem[]>([]);
  const [summarizing, setSummarizing] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  async function refresh(updated?: DevelopmentMeeting) {
    const queryKey = getGetDevelopmentMeetingQueryKey(id);
    if (updated) {
      await client.cancelQueries({ queryKey });
      client.setQueryData(queryKey, updated);
    } else {
      await client.invalidateQueries({ queryKey });
    }
    await client.invalidateQueries({
      queryKey: getListDevelopmentMeetingsQueryKey(),
    });
  }
  async function add(data: AddDevelopmentAgendaItemBody) {
    setSaving(true);
    try {
      await refresh(await addDevelopmentAgendaItem(id, data));
      setTitle("");
      setDonor(null);
    } catch (error) {
      toast({
        title: "Could not add agenda item",
        description: describeError(error),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }
  async function summarize() {
    setSummarizing(true);
    try {
      await summarizeDevelopmentTranscript(id, { transcript });
      setTranscript("");
      await refresh();
    } catch (error) {
      toast({
        title: "Could not summarize transcript",
        description: describeError(error),
        variant: "destructive",
      });
    } finally {
      setSummarizing(false);
    }
  }
  async function suggest() {
    setSuggesting(true);
    try {
      const result = await generateMeetingNextSteps(id);
      setSuggestions(
        result.proposals.map((item) => ({
          title: item.title,
          dueDate: item.dueDate,
        })),
      );
      toast({
        title: result.proposals.length
          ? "Suggestions are available under Assign a next step"
          : "No explicit follow-ups found in the saved notes",
      });
    } catch (error) {
      toast({
        title: "Could not suggest next steps",
        description: describeError(error),
        variant: "destructive",
      });
    } finally {
      setSuggesting(false);
    }
  }
  const assignedTitles = new Set(
    meeting.agenda.flatMap((item) =>
      item.tasks.map((task) => task.title.toLowerCase()),
    ),
  );
  const remainingSuggestions = [
    ...suggestions,
    ...(meeting.note.actionItems ?? []),
  ].filter(
    (item, index, all) =>
      !item.promotedTaskId &&
      !assignedTitles.has(item.title.toLowerCase()) &&
      all.findIndex(
        (match) => match.title.toLowerCase() === item.title.toLowerCase(),
      ) === index,
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/meetings/development"
            className="text-sm text-primary hover:underline"
          >
            Development meeting history
          </Link>
          <h1 className="mt-1 text-3xl font-serif font-bold">
            Weekly development meeting
          </h1>
          <p className="text-sm text-muted-foreground">
            {formatDate(meeting.note.meetingDate.slice(0, 10))}
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/fundraising-brief">Review fundraising findings</Link>
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Agenda</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {meeting.agenda.map((item, index) => (
            <AgendaItemEditor
              key={item.id}
              item={item}
              meetingId={id}
              users={users}
              suggestions={remainingSuggestions}
              readOnly={readOnly}
              first={index === 0}
              last={index === meeting.agenda.length - 1}
              onUpdate={refresh}
              onTask={() =>
                void client.invalidateQueries({
                  queryKey: getListTasksQueryKey(),
                })
              }
            />
          ))}
          {!readOnly && (
            <div className="space-y-3 border-t pt-3">
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void add({ title: title.trim() });
                }}
              >
                <Input
                  className="max-w-md"
                  maxLength={300}
                  aria-label="New agenda item"
                  placeholder="New agenda item"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <Button
                  variant="outline"
                  type="submit"
                  disabled={saving || !title.trim()}
                >
                  Add item
                </Button>
              </form>
              <div className="flex flex-wrap items-start gap-2">
                <div className="w-full max-w-md">
                  <ContactPicker value={donor} onChange={setDonor} />
                </div>
                <Button
                  variant="outline"
                  disabled={saving || !donor}
                  onClick={() => {
                    if (donor)
                      void add(
                        donor.kind === "organization"
                          ? { organizationId: donor.id }
                          : donor.kind === "person"
                            ? { personId: donor.id }
                            : { householdId: donor.id },
                      );
                  }}
                >
                  Add donor
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      {!readOnly && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Suggested donors to discuss
            </CardTitle>
          </CardHeader>
          <CardContent>
            {donorSuggestions.isLoading && (
              <p className="text-sm text-muted-foreground">
                Finding donors to discuss…
              </p>
            )}
            {donorSuggestions.isError && (
              <p className="text-sm text-destructive">
                Donor suggestions could not be loaded.
              </p>
            )}
            {donorSuggestions.data?.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No donor suggestions right now.
              </p>
            )}
            <ul className="divide-y">
              {donorSuggestions.data?.map((row) => {
                const donorScope =
                  row.kind === "organization"
                    ? { organizationId: row.id }
                    : row.kind === "person"
                      ? { personId: row.id }
                      : { householdId: row.id };
                const added = meeting.agenda.some(
                  (item) =>
                    !item.findingId &&
                    (row.kind === "organization"
                      ? item.organizationId
                      : row.kind === "person"
                        ? item.personId
                        : item.householdId) === row.id,
                );
                const path =
                  row.kind === "organization"
                    ? "/organizations/"
                    : row.kind === "person"
                      ? "/people/"
                      : "/households/";
                return (
                  <li
                    key={row.kind + row.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <div>
                      <Link
                        className="font-medium text-primary hover:underline"
                        href={path + row.id}
                      >
                        {row.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {row.reason}
                        {row.ownerName && " · " + row.ownerName}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={added || saving}
                      onClick={() => void add(donorScope)}
                    >
                      {added ? "On agenda" : "Add to agenda"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Meeting summary and next steps
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {meeting.note.aiSummary && (
            <p className="whitespace-pre-wrap text-sm">
              {meeting.note.aiSummary}
            </p>
          )}
          {remainingSuggestions.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {remainingSuggestions.length} suggested next{" "}
              {remainingSuggestions.length === 1 ? "step" : "steps"} to review
              under the relevant agenda item.
            </p>
          )}
          {!readOnly && (
            <>
              <Button
                variant="outline"
                disabled={suggesting}
                onClick={() => void suggest()}
              >
                {suggesting
                  ? "Looking for next steps…"
                  : "Suggest next steps from saved notes"}
              </Button>
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Add a meeting transcript
                </summary>
                <div className="mt-3 space-y-2">
                  <label className="grid gap-1 text-sm">
                    Paste transcript
                    <Textarea
                      rows={5}
                      maxLength={180000}
                      value={transcript}
                      onChange={(event) => setTranscript(event.target.value)}
                    />
                  </label>
                  <label className="grid gap-1 text-sm">
                    Or upload a transcript
                    <Input
                      type="file"
                      accept=".txt,.vtt,.srt,.md"
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        try {
                          if (file.size > 720_000)
                            throw new Error(
                              "Transcript is too long to summarize.",
                            );
                          const content = await file.text();
                          if (content.length > 180_000)
                            throw new Error(
                              "Transcript is too long to summarize.",
                            );
                          setTranscript(content);
                        } catch (error) {
                          toast({
                            title: "Could not read transcript",
                            description: describeError(error),
                            variant: "destructive",
                          });
                        }
                      }}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    The summary and proposed next steps will be visible to CRM
                    staff.
                  </p>
                  <Button
                    size="sm"
                    disabled={summarizing || !transcript.trim()}
                    onClick={() => void summarize()}
                  >
                    {summarizing ? "Summarizing…" : "Summarize transcript"}
                  </Button>
                </div>
              </details>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function DevelopmentMeetingPage() {
  const id = useParams<{ id: string }>().id ?? "";
  const query = useGetDevelopmentMeeting(id, {
    query: {
      queryKey: getGetDevelopmentMeetingQueryKey(id),
      refetchInterval: 10_000,
    },
  });
  const { data: viewer } = useGetCurrentUser();
  if (query.isLoading)
    return <p className="text-sm text-muted-foreground">Loading agenda…</p>;
  if (!query.data)
    return (
      <p className="text-sm text-destructive">
        This development meeting could not be loaded.
      </p>
    );
  return (
    <DevelopmentMeetingEditor
      key={id}
      meeting={query.data}
      readOnly={!viewer || viewer.role === "read_only"}
    />
  );
}
