import {
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  useListTasks,
  getListTasksQueryKey,
  useUpdateTask,
  useDeleteTask,
  type ListGiftsAndPaymentsParams,
  type ListOpportunitiesAndPledgesParams,
  type ListTasksParams,
  type OpportunityStatus,
  type Task,
  type TaskStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Trash2 } from "lucide-react";
import { GiftFormDialog } from "@/components/gift-form-dialog";
import { CreateOpportunityDialog } from "@/components/create-opportunity-dialog";
import { AddTaskDialog } from "@/components/tasks-panel";
import { RelatedCard, RelatedRow } from "@/components/record-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUserNameMap } from "@/components/user-picker";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate, formatDateShort, formatEnum } from "@/lib/format";
import { opportunityStatusLabel } from "@/lib/opportunity-status";

// Cap each card at this many rows. Donor-scoped lists rarely exceed
// this in practice; the header still shows the true total. We do not
// render a "See all" link today because the index pages (gifts.tsx,
// opportunities.tsx) don't yet read filters from the URL, so any link
// here would lose the donor scope and silently mislead.
// TODO(detail-filters): once the index pages hydrate filters from the
// URL, add a "See all" link that serializes scope + status.
const PAGE_SIZE = 50;

/**
 * Donor-scoping filter for the linked-record cards. Exactly one of
 * the three fields must be set; the cards mirror the donor XOR
 * invariant from the DB / API so we never accidentally union three
 * unrelated donor's lists into one card.
 */
export type LinkedRecordsScope =
  | { organizationId: string }
  | { householdId: string }
  | { individualGiverPersonId: string };

export function buildBaseParams(scope: LinkedRecordsScope) {
  if ("organizationId" in scope) return { organizationId: scope.organizationId };
  if ("householdId" in scope) return { householdId: scope.householdId };
  return { individualGiverPersonId: scope.individualGiverPersonId };
}

export function LinkedGiftsCard({ scope }: { scope: LinkedRecordsScope }) {
  const params: ListGiftsAndPaymentsParams = {
    ...buildBaseParams(scope),
    limit: PAGE_SIZE,
    page: 1,
  };
  const { data, isLoading, isError, error } = useListGiftsAndPayments(params, {
    query: { queryKey: getListGiftsAndPaymentsQueryKey(params) },
  });
  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;

  return (
    <RelatedCard
      title="Gifts & payments"
      count={isLoading ? undefined : total}
      action={<GiftFormDialog scope={scope} />}
    >
      {isError ? (
        <p className="px-2 py-2 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load gifts."}
        </p>
      ) : isLoading ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">
          No linked gifts.
        </p>
      ) : (
        <div data-testid="linked-gifts">
          {rows.map((g) => (
            <div key={g.id} data-testid={`row-linked-gift-${g.id}`}>
              <RelatedRow
                name={g.name ?? `Gift ${g.id}`}
                href={`/gifts/${g.id}`}
                tone="primary"
                sub={`${formatDateShort(g.dateReceived)} · ${formatEnum(g.type)}`}
                amount={formatCurrency(g.amount)}
              />
            </div>
          ))}
        </div>
      )}
    </RelatedCard>
  );
}

/**
 * Pledges card — uses the server's pledgeView filter (wasPledge=true OR
 * stage ∈ conditional/verbal/written) so historical pledges stay
 * visible after they're fully paid. Opportunities card uses the
 * complement. Shown as separate cards because fundraisers reason about
 * them differently (covered FYs vs still-being-negotiated ask amounts).
 */
export function LinkedOpportunitiesCard({
  scope,
  pledgeView,
  status,
  title,
  emptyLabel,
}: {
  scope: LinkedRecordsScope;
  /** Server-side page split. Omit to include all rows. */
  pledgeView?: "pledges" | "opportunities";
  /** Optional explicit status filter (rare; usually drive via pledgeView). */
  status?: OpportunityStatus;
  title: string;
  emptyLabel: string;
}) {
  const params: ListOpportunitiesAndPledgesParams = {
    ...buildBaseParams(scope),
    ...(pledgeView ? { pledgeView } : {}),
    ...(status ? { status: [status] } : {}),
    limit: PAGE_SIZE,
    page: 1,
  };
  const { data, isLoading, isError, error } = useListOpportunitiesAndPledges(
    params,
    { query: { queryKey: getListOpportunitiesAndPledgesQueryKey(params) } },
  );
  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const isPledgeView = pledgeView === "pledges";

  return (
    <RelatedCard
      title={title}
      count={isLoading ? undefined : total}
      action={
        <CreateOpportunityDialog
          scope={scope}
          mode={isPledgeView ? "pledge" : "opportunity"}
        />
      }
    >
      {isError ? (
        <p className="px-2 py-2 text-sm text-destructive">
          {error instanceof Error
            ? error.message
            : "Failed to load opportunities."}
        </p>
      ) : isLoading ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div data-testid="linked-opportunities">
          {rows.map((o) => {
            // Rows that belong on the Pledges page (writtenPledge=true) link
            // through /pledges so breadcrumbs/back-links stay consistent with
            // how the user navigated in; everything else routes through
            // /opportunities.
            const href = o.writtenPledge
              ? `/pledges/${o.id}`
              : `/opportunities/${o.id}`;
            const statusLabel = opportunityStatusLabel(o.status);
            const fy = o.fiscalYear?.toUpperCase();
            const sub = [formatEnum(o.stage), statusLabel, fy]
              .filter(Boolean)
              .join(" · ");
            return (
              <div key={o.id} data-testid={`row-linked-opp-${o.id}`}>
                <RelatedRow
                  name={o.name ?? `Untitled ${o.id}`}
                  href={href}
                  tone="primary"
                  sub={sub}
                  amount={formatCurrency(
                    isPledgeView ? o.awardedAmount : o.askAmount,
                  )}
                />
              </div>
            );
          })}
        </div>
      )}
    </RelatedCard>
  );
}

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

/**
 * Tasks card for record detail pages. Surfaces tasks in their own card
 * (separate from the activity feed) with inline status changes, mark-done,
 * and delete. Pair with `<UnifiedActivityFeed hideTasks />` so tasks aren't
 * duplicated in the timeline.
 */
export function LinkedTasksCard({
  personId,
  organizationId,
  householdId,
  opportunityId,
  giftId,
}: {
  personId?: string;
  organizationId?: string;
  householdId?: string;
  opportunityId?: string;
  giftId?: string;
}) {
  const ctx = { personId, organizationId, householdId, opportunityId, giftId };
  const params: ListTasksParams = { ...ctx, limit: PAGE_SIZE, page: 1 };
  const { data, isLoading, isError, error } = useListTasks(params, {
    query: { queryKey: getListTasksQueryKey(params) },
  });
  const rows: Task[] = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const userMap = useUserNameMap();
  const queryClient = useQueryClient();
  const { toast } = useToast();

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

  return (
    <RelatedCard
      title="Tasks"
      count={isLoading ? undefined : total}
      action={
        <AddTaskDialog
          ctx={ctx}
          trigger={
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              data-testid="button-add-task"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add
            </Button>
          }
        />
      }
    >
      {isError ? (
        <p className="px-2 py-2 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load tasks."}
        </p>
      ) : isLoading ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">No tasks yet.</p>
      ) : (
        <ul className="space-y-2 px-1 py-1" data-testid="linked-tasks">
          {rows.map((t) => (
            <li
              key={t.id}
              className="space-y-1 rounded-md border p-2 text-sm"
              data-testid={`row-linked-task-${t.id}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant={TASK_STATUS_VARIANT[t.status]}>
                    {TASK_STATUS_LABEL[t.status]}
                  </Badge>
                  <span className="truncate font-medium">{t.title}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Select
                    value={t.status}
                    onValueChange={(v) =>
                      updateTask.mutate({
                        id: t.id,
                        data: { status: v as TaskStatus },
                      })
                    }
                  >
                    <SelectTrigger
                      className="h-7 w-[104px] text-xs"
                      data-testid={`select-task-status-${t.id}`}
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
                  {t.status !== "done" ? (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-primary"
                      onClick={() =>
                        updateTask.mutate({ id: t.id, data: { status: "done" } })
                      }
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
                    onClick={() => deleteTask.mutate({ id: t.id })}
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
                  <>
                    {" "}
                    · {userMap.get(t.assigneeUserId) ?? t.assigneeUserId}
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </RelatedCard>
  );
}
