import { useState } from "react";
import { Link } from "wouter";
import {
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
  useGetCurrentUser,
  useListTasks,
  useListOrganizations,
  getListTasksQueryKey,
  getListOrganizationsQueryKey,
  type TaskStatus,
  type ListOrganizationsParams,
  type FiscalYearMetrics,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import EmailProposalsCard from "@/components/EmailProposalsCard";
import GrantLeadsCard from "@/components/GrantLeadsCard";
import UpcomingMeetingsCard, {
  TeamUpcomingMeetingsCard,
} from "@/components/upcoming-meetings-card";
import { useEntityFilter } from "@/lib/entity-filter-context";

export default function Dashboard() {
  // Entity filter is global now (lives in the header on every page) — read
  // it from context instead of the URL. The "Apply now" button on Settings
  // and the header dropdown are the two write points.
  const { selected: selectedEntityIds } = useEntityFilter();

  // Pass entityIds only when the user has narrowed the filter. Omitting keeps
  // the unfiltered query (and query-cache key) stable.
  const summaryParams = selectedEntityIds.length > 0 ? { entityIds: selectedEntityIds } : undefined;
  const { data, isLoading, isError, error } = useGetDashboardSummary(summaryParams, {
    query: { queryKey: getGetDashboardSummaryQueryKey(summaryParams) },
  });

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
  const [selectedTrack, setSelectedTrack] = useState<"revenue" | "loanCapital">("revenue");
  const trackSlug: "revenue" | "loan_capital" =
    selectedTrack === "loanCapital" ? "loan_capital" : "revenue";

  // The bar reads left→right: Received (cash in), Committed (weighted unpaid
  // pledges), Weighted open pipeline. Same hue, descending strength, so the
  // "how much is real money vs. probability-weighted" reads at a glance. The
  // three segments sum to the weighted projection; the goal is the full width.
  // Every segment drills into the FY Report page, which lists the actual records
  // behind all three buckets (received gifts, committed pledges, open pipeline).
  const BAR_SEGMENTS: {
    key: "received" | "committed" | "openWeighted";
    label: string;
    color: string;
  }[] = [
    { key: "received", label: "Received", color: "bg-primary" },
    { key: "committed", label: "Committed", color: "bg-primary/60" },
    { key: "openWeighted", label: "Weighted open pipeline", color: "bg-primary/30" },
  ];

  const renderGoalBar = (m: FiscalYearMetrics) => {
    const fySlug = m.fiscalYear.id;
    const fyLabel = m.fiscalYear.label;
    const cm = m[selectedTrack];
    const catParam = `&category=${trackSlug}`;

    const received = Number(cm.received) || 0;
    const committed = Number(cm.committedWeighted) || 0;
    const openWeighted = Number(cm.openPipelineWeighted) || 0;
    const projection = received + committed + openWeighted;
    const goalNum = cm.goal != null && Number(cm.goal) > 0 ? Number(cm.goal) : null;
    const segValue: Record<string, number> = { received, committed, openWeighted };

    const hasGoal = goalNum != null;
    const overGoal = hasGoal && projection > goalNum;
    // Width denominator: against the goal when one is set and not exceeded
    // (so the empty remainder fills to goal); against the projection itself
    // when over goal or when no goal is set (segments fill the whole bar).
    const denom = hasGoal ? (overGoal ? projection : goalNum) : projection > 0 ? projection : 1;
    const coverage = hasGoal ? projection / goalNum : null;
    const remaining = hasGoal && !overGoal ? Math.max(0, goalNum - projection) : 0;

    // Every segment drills into the FY Report, which lists the actual records
    // behind all three buckets. The report sources entity scope from the global
    // header filter (the same source as this bar), so it reconciles to the bar
    // for any number of selected entities — no entity gate or param needed.
    const reportHref = `/fiscal-year-report/${fySlug}?category=${trackSlug}`;

    return (
      <div key={fySlug} className="space-y-2" data-testid={`fy-bar-${fySlug}`}>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-lg font-serif font-semibold text-foreground">{fyLabel}</h2>
          <div className="text-sm text-right" data-testid={`fy-bar-summary-${fySlug}`}>
            {isLoading ? (
              <span className="text-muted-foreground">…</span>
            ) : hasGoal ? (
              <span>
                <span className="font-semibold text-foreground">{formatCurrency(projection)}</span>
                <span className="text-muted-foreground"> of {formatCurrency(goalNum)} goal</span>
                <span className="ml-2 font-medium text-foreground">{Math.round(coverage! * 100)}%</span>
                {overGoal ? (
                  <span className="ml-1 text-emerald-600">
                    (+{formatCurrency(projection - goalNum)} over)
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-muted-foreground">
                <span className="font-semibold text-foreground">{formatCurrency(projection)}</span>{" "}
                projected · No goal set
              </span>
            )}
          </div>
        </div>

        <div className="flex h-6 w-full overflow-hidden rounded-md bg-muted" role="img" aria-label={`${fyLabel} progress to goal`}>
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
              <Link key={seg.key} href={reportHref} className={className} style={style} title={title} data-testid={testId} />
            );
          })}
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {BAR_SEGMENTS.map((seg) => (
            <div key={seg.key} className="flex items-center gap-1.5">
              <span className={cn("inline-block h-2.5 w-2.5 rounded-sm", seg.color)} />
              <span className="text-muted-foreground">{seg.label}</span>
              <span className="font-medium text-foreground">{formatCurrency(segValue[seg.key])}</span>
            </div>
          ))}
          {hasGoal && !overGoal && remaining > 0 ? (
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm border bg-muted" />
              <span className="text-muted-foreground">Remaining to goal</span>
              <span className="font-medium text-foreground">{formatCurrency(remaining)}</span>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          A quick snapshot of the CRM. Fiscal year runs July 1 – June 30; currently{" "}
          <span className="font-medium">{fy?.label ?? "…"}</span>.
          {selectedEntityIds.length > 0 ? (
            <>
              {" "}Filtered to{" "}
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
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive" data-testid="dashboard-error">
          {error instanceof Error ? error.message : "Failed to load dashboard summary."}
        </div>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-4">
            <CardTitle className="text-lg">Progress to goal</CardTitle>
            <div className="flex items-center gap-2 text-sm" data-testid="dashboard-track-toggle">
              <span
                className={cn(
                  selectedTrack === "revenue" ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                Grants
              </span>
              <Switch
                checked={selectedTrack === "loanCapital"}
                onCheckedChange={(checked) => setSelectedTrack(checked ? "loanCapital" : "revenue")}
                aria-label="Switch between regular fundraising and loans"
                data-testid="dashboard-track-switch"
              />
              <span
                className={cn(
                  selectedTrack === "loanCapital" ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                Loans
              </span>
            </div>
          </div>
          {multiEntityFilterActive ? (
            <p className="text-xs text-muted-foreground">
              Showing the combined total across {selectedEntityIds.length} entities (change in the
              header). Click a segment to see the records behind it.
            </p>
          ) : entityFilterActive ? (
            <p className="text-xs text-muted-foreground">Filtered to 1 entity (change in the header).</p>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-6">
          {byFy.length === 0 ? (
            isLoading ? (
              <DashboardGoalBarSkeleton />
            ) : (
              <p className="text-sm text-muted-foreground">No fiscal-year data available.</p>
            )
          ) : (
            byFy.map((m) => renderGoalBar(m))
          )}
        </CardContent>
      </Card>

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
            <CardHeader><CardTitle className="text-lg">Projections</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Open-pipeline allocations by fiscal year and fund entity.
            </CardContent>
          </Card>
        </Link>
        <Link href="/grants-calendar">
          <Card className="cursor-pointer hover:bg-muted/30 transition-colors h-full">
            <CardHeader><CardTitle className="text-lg">Grants calendar</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Upcoming application deadlines and projected close dates.
            </CardContent>
          </Card>
        </Link>
        <Link href="/moves">
          <Card className="cursor-pointer hover:bg-muted/30 transition-colors h-full">
            <CardHeader><CardTitle className="text-lg">Moves</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              People who haven't been contacted recently.
            </CardContent>
          </Card>
        </Link>
      </div>
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
  const teamParams: ListOrganizationsParams = { priority: ["top"], limit: 100 };
  const mineParams: ListOrganizationsParams = userId
    ? { priority: ["top"], ownerUserId: [userId], limit: 100 }
    : { priority: ["top"], limit: 0 };
  const { data: teamData } = useListOrganizations(teamParams, {
    query: { queryKey: getListOrganizationsQueryKey(teamParams) },
  });
  const { data: mineData } = useListOrganizations(mineParams, {
    query: { enabled: !!userId, queryKey: getListOrganizationsQueryKey(mineParams) },
  });
  const team = teamData?.data ?? [];
  const mine = mineData?.data ?? [];
  const renderList = (rows: typeof team, emptyMsg: string) =>
    rows.length === 0 ? (
      <p className="text-sm text-muted-foreground">{emptyMsg}</p>
    ) : (
      <ul className="space-y-1">
        {rows.map((f) => (
          <li key={f.id} className="text-sm border rounded-md p-2 hover:bg-muted/50 transition-colors">
            <Link href={`/organizations/${f.id}`} className="block truncate" data-testid={`dash-top-priority-${f.id}`}>
              {f.name}
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
        </CardHeader>
        <CardContent>
          {renderList(mine, "No top-priority organizations assigned to you.")}
        </CardContent>
      </Card>
      <Card data-testid="card-team-top-priorities">
        <CardHeader>
          <CardTitle className="text-lg">Team top priorities</CardTitle>
        </CardHeader>
        <CardContent>
          {renderList(team, "No top-priority organizations.")}
        </CardContent>
      </Card>
    </div>
  );
}

function MyTasksRow() {
  const { data: me } = useGetCurrentUser();
  const userId = me?.id;
  const OPEN_STATUSES: TaskStatus[] = ["open", "waiting"];
  const myTasksParams = { assigneeUserId: userId, status: OPEN_STATUSES, limit: 10 };
  const { data: tasksData } = useListTasks(myTasksParams, {
    query: { enabled: !!userId, queryKey: getListTasksQueryKey(myTasksParams) },
  });
  const myTasks = tasksData?.data ?? [];
  const fmtDate = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
  return (
    <Card data-testid="card-my-tasks">
      <CardHeader>
        <CardTitle className="text-lg">My open tasks</CardTitle>
      </CardHeader>
      <CardContent>
        {myTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing on your plate.</p>
        ) : (
          <ul className="space-y-2">
            {myTasks.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-2 text-sm border rounded-md p-2"
                data-testid={`dash-task-${t.id}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Badge variant={t.status === "waiting" ? "secondary" : "default"}>
                    {t.status}
                  </Badge>
                  <span className="truncate">{t.title}</span>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  Due {fmtDate(t.dueDate)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

