import { useState } from "react";
import { Link } from "wouter";
import {
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
  useGetCurrentUser,
  useListTasks,
  useUpdateTask,
  useListOrganizations,
  useListPeople,
  getListTasksQueryKey,
  getListOrganizationsQueryKey,
  getListPeopleQueryKey,
  type Task,
  type TaskStatus,
  type ListOrganizationsParams,
  type ListPeopleParams,
  type FiscalYearMetrics,
  type DashboardWorklists,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { displayPersonName } from "@/lib/visibility";
import EmailProposalsCard from "@/components/EmailProposalsCard";
import GrantLeadsCard from "@/components/GrantLeadsCard";
import UpcomingMeetingsCard, {
  TeamUpcomingMeetingsCard,
} from "@/components/upcoming-meetings-card";
import { useEntityFilter } from "@/lib/entity-filter-context";
import { Check } from "lucide-react";

export default function Dashboard() {
  // Entity filter is global now (lives in the header on every page) — read
  // it from context instead of the URL. The "Apply now" button on Settings
  // and the header dropdown are the two write points.
  const { selected: selectedEntityIds } = useEntityFilter();

  // Pass entityIds only when the user has narrowed the filter. Omitting keeps
  // the unfiltered query (and query-cache key) stable.
  const summaryParams =
    selectedEntityIds.length > 0 ? { entityIds: selectedEntityIds } : undefined;
  const { data, isLoading, isError, error } = useGetDashboardSummary(
    summaryParams,
    {
      query: { queryKey: getGetDashboardSummaryQueryKey(summaryParams) },
    },
  );

  const fy = data?.currentFiscalYear;
  const byFy = data?.byFiscalYear ?? [];

  // The FY Report drilldown sources its entity scope from the global header
  // filter (the same source as these bars), so the report reconciles to the bar
  // for any number of selected entities — no per-link entity forwarding needed.
  // These flags only drive the informational banner under the track toggle.
  const multiEntityFilterActive = selectedEntityIds.length > 1;
  const entityFilterActive = selectedEntityIds.length > 0;

  // Loan-fund capital reports as a track parallel to revenue — never mixed.
  // A single toggle picks which track BOTH fiscal-year bars render. Defaults
  // to regular fundraising (revenue); flip to loans (loan capital).
  type CategoryMetrics = FiscalYearMetrics["revenue"];
  const [selectedTrack, setSelectedTrack] = useState<"revenue" | "loanCapital">(
    "revenue",
  );
  const trackSlug: "revenue" | "loan_capital" =
    selectedTrack === "loanCapital" ? "loan_capital" : "revenue";

  // The bar reads left→right: received goal credit, probability-weighted unpaid
  // commitments, and weighted open asks. Face-value amounts are shown below
  // the bar so they are not conflated with the weighted projection.
  const BAR_SEGMENTS: {
    key: "received" | "committed" | "openWeighted";
    label: string;
    color: string;
  }[] = [
    { key: "received", label: "Received goal credit", color: "bg-primary" },
    {
      key: "committed",
      label: "Probability-weighted unpaid commitments",
      color: "bg-primary/60",
    },
    {
      key: "openWeighted",
      label: "Weighted open asks",
      color: "bg-primary/30",
    },
  ];

  const renderGoalBar = (m: FiscalYearMetrics) => {
    const fySlug = m.fiscalYear.id;
    const fyLabel = m.fiscalYear.label;
    const cm = m[selectedTrack];
    const catParam = `&category=${trackSlug}`;

    // Server guarantees non-null numeric strings for these rollups (win
    // probability is NOT NULL as of migration 0128), so parse directly —
    // a `|| 0` here would silently mask a server regression as $0.
    const received = Number(cm.received);
    const committed = Number(cm.committedWeighted);
    const openWeighted = Number(cm.openPipelineWeighted);
    const projection = received + committed + openWeighted;
    const goalNum =
      cm.goal != null && Number(cm.goal) > 0 ? Number(cm.goal) : null;
    const segValue: Record<string, number> = {
      received,
      committed,
      openWeighted,
    };

    const hasGoal = goalNum != null;
    const overGoal = hasGoal && projection > goalNum;
    // Width denominator: against the goal when one is set and not exceeded
    // (so the empty remainder fills to goal); against the projection itself
    // when over goal or when no goal is set (segments fill the whole bar).
    const denom = hasGoal
      ? overGoal
        ? projection
        : goalNum
      : projection > 0
        ? projection
        : 1;
    const coverage = hasGoal ? projection / goalNum : null;
    // goalGap is an API-owned value; it can be null when no goal is set.
    const goalGap = cm.goalGap;

    // Every segment drills into the FY Report, which lists the actual records
    // behind all three buckets. The report sources entity scope from the global
    // header filter (the same source as this bar), so it reconciles to the bar
    // for any number of selected entities — no entity gate or param needed.
    const reportHref = `/fiscal-year-report/${fySlug}?category=${trackSlug}`;

    return (
      <div key={fySlug} className="space-y-2" data-testid={`fy-bar-${fySlug}`}>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-lg font-serif font-semibold text-foreground">
            {fyLabel}
          </h2>
          <div
            className="text-sm text-right"
            data-testid={`fy-bar-summary-${fySlug}`}
          >
            {isLoading ? (
              <span className="text-muted-foreground">…</span>
            ) : hasGoal ? (
              <span>
                <span className="font-semibold text-foreground">
                  {formatCurrency(projection)}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  weighted projection of {formatCurrency(goalNum)} goal
                </span>
                <span className="ml-2 font-medium text-foreground">
                  {Math.round(coverage! * 100)}%
                </span>
                {overGoal ? (
                  <span className="ml-1 text-emerald-600">
                    (+{formatCurrency(projection - goalNum)} over)
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-muted-foreground">
                <span className="font-semibold text-foreground">
                  {formatCurrency(projection)}
                </span>{" "}
                weighted projection · No goal set
              </span>
            )}
          </div>
        </div>

        <div
          className="flex h-6 w-full overflow-hidden rounded-md bg-muted"
          role="img"
          aria-label={`${fyLabel} progress to goal`}
        >
          {BAR_SEGMENTS.map((seg) => {
            const v = segValue[seg.key];
            const width = denom > 0 ? (v / denom) * 100 : 0;
            if (width <= 0) return null;
            const title = `${seg.label}: ${formatCurrency(v)}`;
            const className = cn(
              "block h-full first:rounded-l-md transition-opacity cursor-pointer hover:opacity-80",
              seg.color,
            );
            const style = { width: `${width}%` };
            const testId = `fy-bar-seg-${seg.key}-${fySlug}`;
            return (
              <Link
                key={seg.key}
                href={reportHref}
                className={className}
                style={style}
                title={title}
                data-testid={testId}
              />
            );
          })}
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {BAR_SEGMENTS.map((seg) => (
            <div key={seg.key} className="flex items-center gap-1.5">
              <span
                className={cn("inline-block h-2.5 w-2.5 rounded-sm", seg.color)}
              />
              <span className="text-muted-foreground">{seg.label}</span>
              <span className="font-medium text-foreground">
                {formatCurrency(segValue[seg.key])}
              </span>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed bg-muted" />
            <span className="text-muted-foreground">Goal gap</span>
            <span className="font-medium text-foreground">
              {goalGap == null ? "—" : formatCurrency(goalGap)}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t pt-2 text-xs md:grid-cols-5">
          <MetricLine
            label="Face-value unpaid commitments"
            value={cm.committed}
          />
          <MetricLine label="Face-value open asks" value={cm.openPipelineAsk} />
          <MetricLine label="Received goal credit" value={cm.received} />
          <MetricLine
            label="Probability-weighted unpaid commitments"
            value={cm.committedWeighted}
          />
          <MetricLine
            label="Weighted open asks"
            value={cm.openPipelineWeighted}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Dashboard
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          A quick snapshot of the CRM. Fiscal year runs July 1 – June 30;
          currently <span className="font-medium">{fy?.label ?? "…"}</span>.
          {selectedEntityIds.length > 0 ? (
            <>
              {" "}
              Filtered to{" "}
              <span className="font-medium">
                {selectedEntityIds.length === 1
                  ? "1 entity"
                  : `${selectedEntityIds.length} entities`}
              </span>{" "}
              (change in the header).
            </>
          ) : null}
        </p>
      </div>

      {isError ? (
        <div
          className="rounded-md border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive"
          data-testid="dashboard-error"
        >
          {error instanceof Error
            ? error.message
            : "Failed to load dashboard summary."}
        </div>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-4">
            <CardTitle className="text-lg">Progress to goal</CardTitle>
            <div
              className="flex items-center gap-2 text-sm"
              data-testid="dashboard-track-toggle"
            >
              <span
                className={cn(
                  selectedTrack === "revenue"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                Grants
              </span>
              <Switch
                checked={selectedTrack === "loanCapital"}
                onCheckedChange={(checked) =>
                  setSelectedTrack(checked ? "loanCapital" : "revenue")
                }
                aria-label="Switch between regular fundraising and loans"
                data-testid="dashboard-track-switch"
              />
              <span
                className={cn(
                  selectedTrack === "loanCapital"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                Loans
              </span>
            </div>
          </div>
          {multiEntityFilterActive ? (
            <p className="text-xs text-muted-foreground">
              Showing the combined total across {selectedEntityIds.length}{" "}
              entities (change in the header). Click a segment to see the
              records behind it.
            </p>
          ) : entityFilterActive ? (
            <p className="text-xs text-muted-foreground">
              Filtered to 1 entity (change in the header).
            </p>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-6">
          {byFy.length === 0 ? (
            isLoading ? (
              <DashboardGoalBarSkeleton />
            ) : (
              <p className="text-sm text-muted-foreground">
                No fiscal-year data available.
              </p>
            )
          ) : (
            byFy.map((m) => renderGoalBar(m))
          )}
        </CardContent>
      </Card>

      <WorklistsCard worklists={data?.worklists} isLoading={isLoading} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <UpcomingMeetingsCard />
        <TeamUpcomingMeetingsCard />
      </div>

      <TopPrioritiesRow />

      <MyTasksRow />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <EmailProposalsCard />
        <GrantLeadsCard />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/projections">
          <Card className="cursor-pointer hover:bg-muted/30 transition-colors h-full">
            <CardHeader>
              <CardTitle className="text-lg">Projections</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Open-pipeline allocations by fiscal year and fund entity.
            </CardContent>
          </Card>
        </Link>
        <Link href="/grants-calendar">
          <Card className="cursor-pointer hover:bg-muted/30 transition-colors h-full">
            <CardHeader>
              <CardTitle className="text-lg">
                Application/close deadlines
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Upcoming application deadlines and projected close dates.
            </CardContent>
          </Card>
        </Link>
        <Link href="/moves">
          <Card className="cursor-pointer hover:bg-muted/30 transition-colors h-full">
            <CardHeader>
              <CardTitle className="text-lg">Moves</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              People who haven't been contacted recently.
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <span className="truncate text-muted-foreground" title={label}>
        {label}
      </span>
      <span className="shrink-0 font-medium tabular-nums text-foreground">
        {formatCurrency(value)}
      </span>
    </div>
  );
}

function DashboardGoalBarSkeleton() {
  return (
    <div className="space-y-6" data-testid="dashboard-goal-bar-skeleton">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="flex items-baseline justify-between gap-4">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-48" />
          </div>
          <Skeleton className="h-6 w-full rounded-md" />
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-36" />
          </div>
        </div>
      ))}
    </div>
  );
}

function TopPrioritiesRow() {
  const { data: me } = useGetCurrentUser();
  const userId = me?.id;
  const teamOrgParams: ListOrganizationsParams = {
    priority: ["top"],
    limit: 100,
  };
  const mineOrgParams: ListOrganizationsParams = userId
    ? { priority: ["top"], ownerUserId: [userId], limit: 100 }
    : { priority: ["top"], limit: 0 };
  const teamPersonParams: ListPeopleParams = {
    priority: ["top"],
    deceased: false,
    limit: 100,
  };
  const minePersonParams: ListPeopleParams = userId
    ? {
        priority: ["top"],
        ownerUserId: [userId],
        deceased: false,
        limit: 100,
      }
    : { priority: ["top"], deceased: false, limit: 1 };
  const { data: teamOrgData } = useListOrganizations(teamOrgParams, {
    query: { queryKey: getListOrganizationsQueryKey(teamOrgParams) },
  });
  const { data: mineOrgData } = useListOrganizations(mineOrgParams, {
    query: {
      enabled: !!userId,
      queryKey: getListOrganizationsQueryKey(mineOrgParams),
    },
  });
  const { data: teamPersonData } = useListPeople(teamPersonParams, {
    query: { queryKey: getListPeopleQueryKey(teamPersonParams) },
  });
  const { data: minePersonData } = useListPeople(minePersonParams, {
    query: {
      enabled: !!userId,
      queryKey: getListPeopleQueryKey(minePersonParams),
    },
  });

  type PriorityRecord = {
    id: string;
    name: string;
    href: string;
    kind: "Organization" | "Individual";
    lastContacted: string | null;
  };

  const organizations = (
    rows: NonNullable<typeof teamOrgData>["data"],
  ): PriorityRecord[] =>
    rows.map((org) => ({
      id: org.id,
      name: org.name,
      href: `/organizations/${org.id}`,
      kind: "Organization",
      lastContacted: org.lastContacted ?? null,
    }));
  const people = (
    rows: NonNullable<typeof teamPersonData>["data"],
  ): PriorityRecord[] =>
    rows.map((person) => ({
      id: person.id,
      name: displayPersonName(person, me ?? null),
      href: `/individuals/${person.id}`,
      kind: "Individual",
      lastContacted: person.lastContacted ?? null,
    }));
  const oldestContactFirst = (a: PriorityRecord, b: PriorityRecord) => {
    if (a.lastContacted !== b.lastContacted) {
      if (!a.lastContacted) return -1;
      if (!b.lastContacted) return 1;
      return a.lastContacted.localeCompare(b.lastContacted);
    }
    return a.name.localeCompare(b.name);
  };
  const team = [
    ...organizations(teamOrgData?.data ?? []),
    ...people(teamPersonData?.data ?? []),
  ].sort(oldestContactFirst);
  const mine = [
    ...organizations(mineOrgData?.data ?? []),
    ...people(minePersonData?.data ?? []),
  ].sort(oldestContactFirst);
  const renderList = (rows: PriorityRecord[], emptyMsg: string) =>
    rows.length === 0 ? (
      <p className="text-sm text-muted-foreground">{emptyMsg}</p>
    ) : (
      <ul className="space-y-2">
        {rows.map((record) => (
          <li
            key={`${record.kind}-${record.id}`}
            className="border rounded-md p-2 hover:bg-muted/50 transition-colors"
          >
            <Link
              href={record.href}
              className="block"
              data-testid={`dash-top-priority-${record.id}`}
            >
              <span className="block truncate text-sm font-medium">
                {record.name}
              </span>
              <span className="block text-xs text-muted-foreground">
                {record.lastContacted
                  ? `${record.kind} · Last contacted ${formatDateShort(record.lastContacted)}`
                  : `${record.kind} · No logged contact`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card data-testid="card-my-top-priorities">
        <CardHeader>
          <CardTitle className="text-lg">My top priorities</CardTitle>
          <p className="text-xs text-muted-foreground">
            People and organizations assigned to you, ordered by oldest logged contact.
          </p>
        </CardHeader>
        <CardContent>
          {renderList(
            mine,
            "No top-priority people or organizations assigned to you.",
          )}
        </CardContent>
      </Card>
      <Card data-testid="card-team-top-priorities">
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-lg">Team top priorities</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              All top-priority people and organizations.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/top-priorities">View all</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {renderList(team, "No top-priority people or organizations.")}
        </CardContent>
      </Card>
    </div>
  );
}

// Donor-lifecycle worklists ("what hasn't been done yet"). Each tile links to a
// pre-filtered list (the `worklist` URL param the list pages read) except the
// staged-money tile, which links to the reconciliation workbench. Counts come
// from the dashboard summary and honor the global entity filter.
const WORKLIST_ITEMS: ReadonlyArray<{
  key: keyof DashboardWorklists;
  label: string;
  desc: string;
  href: string;
}> = [
  {
    key: "verbalNoLetter",
    label: "Verbal yes, no letter",
    desc: "Verbal commitments with no written grant letter recorded yet.",
    href: "/opportunities?worklist=verbal_no_letter",
  },
  {
    key: "committedUnpaid",
    label: "Committed but unpaid",
    desc: "Written pledges with nothing paid against them yet.",
    href: "/pledges?worklist=committed_unpaid",
  },
  {
    key: "partiallyPaid",
    label: "Partially paid pledges",
    desc: "Pledges with some money in but not fully paid.",
    href: "/pledges?worklist=partially_paid",
  },
  {
    key: "overdueFixedClose",
    label: "Overdue fixed closes",
    desc: "Open opportunities whose fixed projected close is more than one year overdue.",
    href: "/opportunities?worklist=overdue_fixed_close",
  },
  {
    key: "stagedUnprocessed",
    label: "Money staged, not processed",
    desc: "Staged QuickBooks / Stripe payments awaiting reconciliation.",
    href: "/reconciliation/deposits",
  },
  {
    key: "giftsMissingAllocations",
    label: "Gifts missing allocations",
    desc: "Gifts with no allocation rows — unattributed money.",
    href: "/gifts?worklist=missing_allocations",
  },
];

function WorklistsCard({
  worklists,
  isLoading,
}: {
  worklists?: DashboardWorklists;
  isLoading: boolean;
}) {
  return (
    <Card data-testid="card-worklists">
      <CardHeader>
        <CardTitle className="text-lg">Worklists</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {WORKLIST_ITEMS.map((item) => {
            const count = worklists?.[item.key];
            return (
              <Link key={item.key} href={item.href}>
                <Card
                  className="cursor-pointer hover:bg-muted/30 transition-colors h-full"
                  data-testid={`worklist-tile-${item.key}`}
                >
                  <CardContent className="p-4 space-y-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium text-sm">{item.label}</span>
                      {isLoading ? (
                        <Skeleton className="h-6 w-8" />
                      ) : (
                        <span
                          className="text-xl font-semibold tabular-nums"
                          data-testid={`worklist-count-${item.key}`}
                        >
                          {count ?? 0}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{item.desc}</p>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function MyTasksRow() {
  const { data: me } = useGetCurrentUser();
  const userId = me?.id;
  const OPEN_STATUSES: TaskStatus[] = ["open", "waiting"];
  const myTasksParams = {
    assigneeUserId: userId,
    status: OPEN_STATUSES,
    limit: 10,
  };
  const { data: tasksData, isLoading } = useListTasks(myTasksParams, {
    query: { enabled: !!userId, queryKey: getListTasksQueryKey(myTasksParams) },
  });
  const myTasks = tasksData?.data ?? [];
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
  const fmtDate = (iso?: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" })
      : "—";
  return (
    <Card data-testid="card-my-tasks">
      <CardHeader>
        <CardTitle className="text-lg">My open tasks</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : myTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No open tasks assigned to you. Review{" "}
            <Link
              href="/top-priorities"
              className="text-primary hover:underline"
            >
              Top Priorities
            </Link>{" "}
            or{" "}
            <Link href="/moves" className="text-primary hover:underline">
              Moves
            </Link>{" "}
            to choose a next cultivation step.
          </p>
        ) : (
          <ul className="space-y-2">
            {myTasks.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-3 text-sm border rounded-md p-2"
                data-testid={`dash-task-${t.id}`}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge
                      variant={t.status === "waiting" ? "secondary" : "default"}
                    >
                      {t.status}
                    </Badge>
                    <span className="truncate font-medium">{t.title}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span>Due {fmtDate(t.dueDate)}</span>
                    <TaskRecordLink task={t} />
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-primary"
                  aria-label={`Mark ${t.title} done`}
                  title="Mark done"
                  disabled={updateTask.isPending}
                  onClick={() =>
                    updateTask.mutate({ id: t.id, data: { status: "done" } })
                  }
                  data-testid={`dash-task-done-${t.id}`}
                >
                  <Check className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function TaskRecordLink({ task }: { task: Task }) {
  const target = task.organizationIds?.[0]
    ? {
        href: `/organizations/${task.organizationIds[0]}`,
        label: "Open organization",
      }
    : task.personIds?.[0]
      ? { href: `/individuals/${task.personIds[0]}`, label: "Open individual" }
      : task.householdIds?.[0]
        ? {
            href: `/households/${task.householdIds[0]}`,
            label: "Open household",
          }
        : task.opportunityIds?.[0]
          ? {
              href: `/opportunities/${task.opportunityIds[0]}`,
              label: "Open opportunity",
            }
          : task.giftIds?.[0]
            ? { href: `/gifts/${task.giftIds[0]}`, label: "Open gift" }
            : task.grantLeadIds?.[0]
              ? { href: "/grant-leads", label: "Open grant leads" }
              : null;

  return target ? (
    <Link href={target.href} className="text-primary hover:underline">
      {target.label}
    </Link>
  ) : null;
}
