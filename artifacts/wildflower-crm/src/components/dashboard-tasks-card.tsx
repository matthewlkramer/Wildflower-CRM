import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListTasksQueryKey,
  type Task,
  type TaskStatus,
  useGetCurrentUser,
  useListTasks,
  useUpdateTask,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DashboardScopeToggle,
  type DashboardScope,
} from "@/components/dashboard-scope-toggle";
import { useUserNameMap } from "@/components/user-picker";
import { Check } from "lucide-react";

const OPEN_STATUSES: TaskStatus[] = ["open", "waiting"];

export function DashboardTasksCard() {
  const [scope, setScope] = useState<DashboardScope>("mine");
  const { data: currentUser } = useGetCurrentUser();
  const userId = currentUser?.id;
  const userNames = useUserNameMap();
  const myParams = {
    assigneeUserId: userId,
    status: OPEN_STATUSES,
    limit: 50,
  };
  const teamParams = { status: OPEN_STATUSES, limit: 100 };
  const myQuery = useListTasks(myParams, {
    query: {
      enabled: scope === "mine" && Boolean(userId),
      queryKey: getListTasksQueryKey(myParams),
    },
  });
  const teamQuery = useListTasks(teamParams, {
    query: {
      enabled: scope === "team",
      queryKey: getListTasksQueryKey(teamParams),
    },
  });
  const activeQuery = scope === "mine" ? myQuery : teamQuery;
  const tasks = activeQuery.data?.data ?? [];
  const queryClient = useQueryClient();
  const updateTask = useUpdateTask({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListTasksQueryKey(),
        });
      },
    },
  });

  return (
    <Card data-testid="card-tasks">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-lg">Open tasks</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Open and waiting work, with linked CRM records and due dates.
          </p>
        </div>
        <DashboardScopeToggle
          value={scope}
          onValueChange={setScope}
          testId="tasks-scope-toggle"
        />
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Task</TableHead>
              <TableHead className="w-28">Status</TableHead>
              <TableHead className="w-44">Assignee</TableHead>
              <TableHead className="w-36">Due</TableHead>
              <TableHead className="w-44">Related record</TableHead>
              <TableHead className="w-24 pr-6 text-right">Done</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {activeQuery.isLoading || (scope === "mine" && !userId) ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-8 text-center text-muted-foreground"
                >
                  Loading tasks…
                </TableCell>
              </TableRow>
            ) : activeQuery.isError ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-8 text-center text-muted-foreground"
                >
                  Couldn't load {scope === "mine" ? "your" : "the team"} tasks.
                </TableCell>
              </TableRow>
            ) : tasks.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-8 text-center text-muted-foreground"
                >
                  No open tasks{" "}
                  {scope === "mine" ? "assigned to you" : "for the team"}.
                </TableCell>
              </TableRow>
            ) : (
              tasks.map((task) => (
                <TableRow key={task.id} data-testid={`dash-task-${task.id}`}>
                  <TableCell className="pl-6 font-medium">
                    {task.title}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        task.status === "waiting" ? "secondary" : "default"
                      }
                    >
                      {task.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {task.assigneeUserId ? (
                      (userNames.get(task.assigneeUserId) ??
                      task.assigneeUserId)
                    ) : (
                      <span className="text-muted-foreground">Unassigned</span>
                    )}
                  </TableCell>
                  <TableCell>{formatDueDate(task.dueDate)}</TableCell>
                  <TableCell>
                    <TaskRecordLink task={task} />
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-primary"
                      aria-label={`Mark ${task.title} done`}
                      title="Mark done"
                      disabled={updateTask.isPending}
                      onClick={() =>
                        updateTask.mutate({
                          id: task.id,
                          data: { status: "done" },
                        })
                      }
                      data-testid={`dash-task-done-${task.id}`}
                    >
                      <Check className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function formatDueDate(date?: string | null) {
  return date
    ? new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
        dateStyle: "medium",
      })
    : "—";
}

function TaskRecordLink({ task }: { task: Task }) {
  const target = task.organizationIds?.[0]
    ? {
        href: `/organizations/${task.organizationIds[0]}`,
        label: "Organization",
      }
    : task.personIds?.[0]
      ? { href: `/individuals/${task.personIds[0]}`, label: "Individual" }
      : task.householdIds?.[0]
        ? { href: `/households/${task.householdIds[0]}`, label: "Household" }
        : task.opportunityIds?.[0]
          ? {
              href: `/opportunities/${task.opportunityIds[0]}`,
              label: "Opportunity",
            }
          : task.giftIds?.[0]
            ? { href: `/gifts/${task.giftIds[0]}`, label: "Gift" }
            : task.grantLeadIds?.[0]
              ? { href: "/grant-leads", label: "Grant lead" }
              : null;

  return target ? (
    <Link href={target.href} className="text-primary hover:underline">
      {target.label}
    </Link>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}
