import { useMemo } from "react";
import { Link } from "wouter";
import {
  useListTasks,
  useUpdateTask,
  getListTasksQueryKey,
  type Task,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useUserNameMap } from "@/components/user-picker";
import { formatDate } from "@/lib/format";
import { CheckCircle2, Clock, FileClock } from "lucide-react";

/**
 * Cross-team view of every open reporting_deadline task. Groups by
 * assignee so each grant manager can see what's on their plate at a
 * glance; unassigned rows bubble to the top so they don't slip through
 * the cracks. Sorted within each group by due date (nulls last).
 *
 * This page deliberately doesn't paginate — reporting deadlines are
 * low-volume by nature (a few per active grant). If volume grows we
 * can add status / due-window filters before paging.
 */
export default function ReportingDeadlinesPage() {
  const { data, isLoading, isError, error } = useListTasks({
    kind: ["reporting_deadline"],
    status: ["open", "waiting"],
    limit: 200,
  });
  const userNames = useUserNameMap();

  const tasks = data?.data ?? [];
  const grouped = useMemo(() => {
    const byAssignee = new Map<string | null, Task[]>();
    for (const t of tasks) {
      const key = t.assigneeUserId ?? null;
      const arr = byAssignee.get(key) ?? [];
      arr.push(t);
      byAssignee.set(key, arr);
    }
    // Sort each bucket by dueDate ascending, nulls last.
    for (const arr of byAssignee.values()) {
      arr.sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      });
    }
    const entries = Array.from(byAssignee.entries());
    // Unassigned first, then assignees alphabetically.
    entries.sort(([a], [b]) => {
      if (a === null) return -1;
      if (b === null) return 1;
      const na = userNames.get(a) ?? a;
      const nb = userNames.get(b) ?? b;
      return na.localeCompare(nb);
    });
    return entries;
  }, [tasks, userNames]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <FileClock className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            Reporting deadlines
          </h1>
          <p className="text-sm text-muted-foreground">
            Open reporting deadlines across the team, grouped by who owns them.
          </p>
        </div>
      </div>

      {isLoading && (
        <div className="text-sm text-muted-foreground">Loading…</div>
      )}
      {isError && (
        <div className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load."}
        </div>
      )}
      {!isLoading && tasks.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No open reporting deadlines. New ones are created when an
            opportunity becomes a pledge or cash-in.
          </CardContent>
        </Card>
      )}

      <div className="space-y-6">
        {grouped.map(([assigneeId, items]) => (
          <AssigneeGroup
            key={assigneeId ?? "__unassigned__"}
            assigneeId={assigneeId}
            assigneeName={assigneeId ? (userNames.get(assigneeId) ?? assigneeId) : "Unassigned"}
            tasks={items}
          />
        ))}
      </div>
    </div>
  );
}

function AssigneeGroup({
  assigneeId,
  assigneeName,
  tasks,
}: {
  assigneeId: string | null;
  assigneeName: string;
  tasks: Task[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          {assigneeName}
          <Badge variant="secondary">{tasks.length}</Badge>
          {assigneeId === null && (
            <Badge variant="destructive" className="text-xs">Needs owner</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-y -mt-2">
        {tasks.map((t) => (
          <DeadlineRow key={t.id} task={t} />
        ))}
      </CardContent>
    </Card>
  );
}

function DeadlineRow({ task }: { task: Task }) {
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

  return (
    <div
      className="flex items-start gap-3 py-3"
      data-testid={`reporting-deadline-${task.id}`}
    >
      <Clock
        className={
          "h-4 w-4 mt-1 shrink-0 " +
          (overdue ? "text-destructive" : soon ? "text-amber-500" : "text-muted-foreground")
        }
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{task.title}</span>
          {task.status === "waiting" && (
            <Badge variant="outline" className="text-xs">Waiting</Badge>
          )}
          {overdue && <Badge variant="destructive" className="text-xs">Overdue</Badge>}
          {soon && <Badge className="text-xs">Due soon</Badge>}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Due {formatDate(task.dueDate)}
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
    </div>
  );
}
