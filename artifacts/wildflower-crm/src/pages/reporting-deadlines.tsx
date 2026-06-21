import { useMemo } from "react";
import { Link } from "wouter";
import {
  useListTasks,
  useUpdateTask,
  getListTasksQueryKey,
  type Task,
  type TaskStatus,
  type TaskKind,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { useUserNameMap } from "@/components/user-picker";
import { OwnerMultiFilter } from "@/components/owner-multi-filter";
import { DonorFieldPicker, type DonorType } from "@/components/entity-picker";
import { formatDate } from "@/lib/format";
import { CheckCircle2, Clock, FileClock } from "lucide-react";

/**
 * Cross-team view of every reporting_deadline task, sorted by due date
 * (soonest → latest, nulls last). Default filter hides completed
 * (status=done / cancelled); toggle to include them.
 */
const INCOMPLETE_STATUSES: TaskStatus[] = ["open", "waiting"];
const ALL_STATUSES: TaskStatus[] = ["open", "waiting", "done", "cancelled"];

export default function ReportingDeadlinesPage() {
  const [showCompleted, setShowCompleted] = usePersistedState<boolean>(
    "wf.list.reporting-deadlines.showCompleted",
    false,
  );
  // Owner filter — multi-select on assigneeUserId. The /tasks endpoint
  // only takes a single assigneeUserId, so we pull the full set (limit
  // 500 is well above the reporting-deadline volume) and filter client
  // side. The sentinel "__unassigned__" matches rows with no assignee.
  const [owners, setOwners] = usePersistedState<string[]>(
    "wf.list.reporting-deadlines.owners",
    [],
  );
  // Donor filter — narrows to reporting deadlines whose linked
  // opportunity/pledge has this donor. Donor lives on the opportunity, so the
  // /tasks endpoint resolves it through opportunity_ids (donor-XOR: at most one
  // of the three opportunity* params is sent). donorId === null = no filter.
  const [donorType, setDonorType] = usePersistedState<DonorType>(
    "wf.list.reporting-deadlines.donorType",
    "organization",
  );
  const [donorId, setDonorId] = usePersistedState<string | null>(
    "wf.list.reporting-deadlines.donorId",
    null,
  );
  const params = {
    kind: ["reporting_deadline"] as TaskKind[],
    status: showCompleted ? ALL_STATUSES : INCOMPLETE_STATUSES,
    limit: 500,
    ...(donorId && donorType === "organization"
      ? { opportunityOrganizationId: donorId }
      : {}),
    ...(donorId && donorType === "individual"
      ? { opportunityIndividualGiverPersonId: donorId }
      : {}),
    ...(donorId && donorType === "household"
      ? { opportunityHouseholdId: donorId }
      : {}),
  };
  const { data, isLoading, isError, error } = useListTasks(params);
  const userNames = useUserNameMap();

  const tasks = data?.data ?? [];
  const filtered = useMemo(() => {
    if (owners.length === 0) return tasks;
    const includeUnassigned = owners.includes("__unassigned__");
    const ownerSet = new Set(owners.filter((o) => o !== "__unassigned__"));
    return tasks.filter((t) => {
      if (t.assigneeUserId === null || t.assigneeUserId === undefined) {
        return includeUnassigned;
      }
      return ownerSet.has(t.assigneeUserId);
    });
  }, [tasks, owners]);
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    });
  }, [filtered]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <FileClock className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            Reporting deadlines
          </h1>
          <p className="text-sm text-muted-foreground">
            All reporting deadlines across the team, soonest first.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label
          className="inline-flex items-center gap-2 text-sm cursor-pointer select-none"
          data-testid="toggle-show-completed"
        >
          <Checkbox
            checked={showCompleted}
            onCheckedChange={(v) => setShowCompleted(v === true)}
          />
          Show completed
        </label>
        <OwnerMultiFilter
          selected={owners}
          onChange={setOwners}
          testId="filter-reporting-deadlines-owner"
          label="Assignee"
        />
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Donor</span>
          <DonorFieldPicker
            type={donorType}
            id={donorId}
            onChange={(t, id) => {
              setDonorType(t);
              setDonorId(id);
            }}
            testIdBase="filter-reporting-deadlines-donor"
          />
        </div>
        {(owners.length > 0 || showCompleted || donorId) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setOwners([]);
              setShowCompleted(false);
              setDonorId(null);
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {isLoading && (
        <div className="text-sm text-muted-foreground">Loading…</div>
      )}
      {isError && (
        <div className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load."}
        </div>
      )}
      {!isLoading && sorted.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {showCompleted
              ? "No reporting deadlines yet."
              : "No open reporting deadlines. New ones are created when an opportunity becomes a pledge or cash-in."}
          </CardContent>
        </Card>
      )}

      {sorted.length > 0 && (
        <Card>
          <CardContent className="divide-y py-0">
            {sorted.map((t) => (
              <DeadlineRow key={t.id} task={t} userNames={userNames} />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DeadlineRow({
  task,
  userNames,
}: {
  task: Task;
  userNames: Map<string, string>;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateMut = useUpdateTask({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
        toast({ title: "Marked done" });
      },
      onError: (err: unknown) =>
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });
  const oppId = task.opportunityIds?.[0] ?? null;
  const now = new Date();
  const due = task.dueDate ? new Date(`${task.dueDate}T00:00:00Z`) : null;
  const overdue = !!due && due.getTime() < now.getTime();
  const soon = !!due && !overdue && due.getTime() - now.getTime() < 14 * 24 * 60 * 60 * 1000;
  const done = task.status === "done" || task.status === "cancelled";
  const assigneeName = task.assigneeUserId
    ? (userNames.get(task.assigneeUserId) ?? task.assigneeUserId)
    : "Unassigned";

  return (
    <div
      className="flex items-start gap-3 py-3"
      data-testid={`reporting-deadline-${task.id}`}
    >
      <Clock
        className={
          "h-4 w-4 mt-1 shrink-0 " +
          (done
            ? "text-muted-foreground"
            : overdue
            ? "text-destructive"
            : soon
            ? "text-amber-500"
            : "text-muted-foreground")
        }
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={"font-medium " + (done ? "line-through text-muted-foreground" : "")}>
            {task.title}
          </span>
          {task.status === "waiting" && (
            <Badge variant="outline" className="text-xs">Waiting</Badge>
          )}
          {task.status === "done" && (
            <Badge variant="secondary" className="text-xs">Done</Badge>
          )}
          {task.status === "cancelled" && (
            <Badge variant="outline" className="text-xs">Cancelled</Badge>
          )}
          {!done && overdue && <Badge variant="destructive" className="text-xs">Overdue</Badge>}
          {!done && soon && <Badge className="text-xs">Due soon</Badge>}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Due {formatDate(task.dueDate)} · {assigneeName}
          {oppId && (
            <>
              {" · "}
              <Link href={`/opportunities/${oppId}`} className="text-primary hover:underline">
                View opportunity
              </Link>
            </>
          )}
        </div>
        {task.description && (
          <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
            {task.description}
          </div>
        )}
      </div>
      {!done && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => updateMut.mutate({ id: task.id, data: { status: "done" } })}
          disabled={updateMut.isPending}
          data-testid={`button-complete-deadline-${task.id}`}
        >
          <CheckCircle2 className="h-4 w-4 mr-1" />
          Done
        </Button>
      )}
    </div>
  );
}
