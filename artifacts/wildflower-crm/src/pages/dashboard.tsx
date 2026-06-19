import { Link } from "wouter";
import {
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
  useGetCurrentUser,
  useListTasks,
  useListNotes,
  useListOrganizations,
  getListTasksQueryKey,
  getListNotesQueryKey,
  getListOrganizationsQueryKey,
  type TaskStatus,
  type ListOrganizationsParams,
  type FiscalYearMetrics,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/format";
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

  const counts = data?.counts;
  const fy = data?.currentFiscalYear;
  const byFy = data?.byFiscalYear ?? [];

  // Forward entity scope to the FY detail page. The detail view has a
  // single-entity dropdown, so we can only forward when exactly one entity is
  // selected. With 0 selected we pass nothing (detail falls back to its
  // Wildflower Foundation default). With 2+ selected we DISABLE the drilldown
  // link entirely — opening the detail page filtered to a different entity
  // than the dashboard would silently mismatch the tile totals and break
  // user trust. Users can narrow to a single entity first to drill in.
  const multiEntityFilterActive = selectedEntityIds.length > 1;
  const forwardedEntityParam =
    selectedEntityIds.length === 1 ? `&entity=${encodeURIComponent(selectedEntityIds[0])}` : "";
  const entityFilterActive = selectedEntityIds.length > 0;

  const countTiles = [
    { label: "People", value: counts?.people, href: "/individuals", testId: "tile-people" },
    { label: "Organizations", value: counts?.organizations, href: "/organizations", testId: "tile-orgs" },
    { label: "Opportunities", value: counts?.opportunities, href: "/opportunities", testId: "tile-opps" },
    { label: "Open opps", value: counts?.openOpportunities, href: "/opportunities", testId: "tile-open-opps" },
    { label: "Pledges", value: counts?.pledges, href: "/pledges", testId: "tile-pledges" },
    { label: "Gifts & payments", value: counts?.gifts, href: "/gifts", testId: "tile-gifts" },
  ];

  // Goal has no drilldown (it's a single seeded number, no rows behind it).
  // The other three tiles all link to the same detail page, with `metric`
  // controlling which table + total is highlighted — same destination, different
  // filter/sum, so users learn one page that backs all the money tiles.
  type MoneyTile = {
    label: string;
    value: string | undefined;
    sub: string;
    testId: string;
    href?: string;
  };

  // Loan-fund capital reports as a track parallel to revenue — never mixed.
  // Each fiscal year renders two rows (Revenue / Gifts + Loan Capital), each
  // built from the same per-category metrics shape.
  type CategoryMetrics = FiscalYearMetrics["revenue"];
  const CATEGORY_TRACKS: {
    key: "revenue" | "loanCapital";
    slug: "revenue" | "loan_capital";
    label: string;
  }[] = [
    { key: "revenue", slug: "revenue", label: "Revenue / Gifts" },
    { key: "loanCapital", slug: "loan_capital", label: "Loan Capital" },
  ];

  const buildTiles = (
    fySlug: string,
    fyLabel: string,
    catSlug: "revenue" | "loan_capital",
    cm: CategoryMetrics,
  ): MoneyTile[] => {
    const catParam = `&category=${catSlug}`;
    // Weighted projection = money in (received) + the UNPAID remainder of
    // written commitments (committed — the server nets out payments already in
    // `received`) + probability-weighted open pipeline. The three buckets are
    // disjoint, so a partial payment on a pledge is counted once.
    const weightedProjection = (
      Number(cm.received) + Number(cm.committed) + Number(cm.openPipelineWeighted)
    ).toFixed(2);
    return [
      {
        label: `Goal ${fyLabel}`,
        value: cm.goal ?? undefined,
        sub: cm.goal
          ? entityFilterActive
            ? `Goal for ${fyLabel} (${selectedEntityIds.length} ${selectedEntityIds.length === 1 ? "entity" : "entities"})`
            : `Total goal across all entities for ${fyLabel}`
          : `No goal set for ${fyLabel}`,
        testId: `tile-goal-${catSlug}-${fySlug}`,
      },
      {
        label: `Weighted projection ${fyLabel}`,
        value: weightedProjection,
        sub: multiEntityFilterActive
          ? `Received + committed + weighted open asks across ${selectedEntityIds.length} entities`
          : `Received + committed + weighted open asks for ${fyLabel}`,
        testId: `tile-weighted-projection-${catSlug}-${fySlug}`,
      },
      {
        label: `Received ${fyLabel}`,
        value: cm.received,
        sub: multiEntityFilterActive
          ? `Sum across ${selectedEntityIds.length} entities — narrow to one entity to drill in`
          : `Allocations booked to ${fyLabel}`,
        testId: `tile-received-${catSlug}-${fySlug}`,
        href: multiEntityFilterActive
          ? undefined
          : `/fiscal-year/${fySlug}?metric=received${catParam}${forwardedEntityParam}`,
      },
      {
        label: `Open asks ${fyLabel}`,
        value: cm.openPipelineAsk,
        sub: multiEntityFilterActive
          ? `Sum across ${selectedEntityIds.length} entities — narrow to one entity to drill in`
          : `Open allocations booked to ${fyLabel}`,
        testId: `tile-pipeline-ask-${catSlug}-${fySlug}`,
        href: multiEntityFilterActive
          ? undefined
          : `/fiscal-year/${fySlug}?metric=open-asks${catParam}${forwardedEntityParam}`,
      },
      {
        label: `Weighted asks ${fyLabel}`,
        value: cm.openPipelineWeighted,
        sub: multiEntityFilterActive
          ? `Sum across ${selectedEntityIds.length} entities — narrow to one entity to drill in`
          : `${fyLabel} open allocations × win probability`,
        testId: `tile-pipeline-weighted-${catSlug}-${fySlug}`,
        href: multiEntityFilterActive
          ? undefined
          : `/fiscal-year/${fySlug}?metric=weighted-asks${catParam}${forwardedEntityParam}`,
      },
    ];
  };

  const renderTile = (t: MoneyTile) => {
    const card = (
      <Card
        data-testid={t.testId}
        className={t.href ? "cursor-pointer hover:bg-muted/30 transition-colors h-full" : "h-full"}
      >
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t.label}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-serif font-bold text-foreground">
            {isLoading || t.value === undefined ? "…" : formatCurrency(t.value)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">{t.sub}</p>
        </CardContent>
      </Card>
    );
    return t.href ? (
      <Link key={t.label} href={t.href}>{card}</Link>
    ) : (
      <div key={t.label}>{card}</div>
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

      <div className="space-y-6">
        {byFy.map((m) => {
          const fySlug = m.fiscalYear.id;
          const fyLabel = m.fiscalYear.label;
          return (
            <div key={fySlug} className="space-y-3" data-testid={`fy-block-${fySlug}`}>
              <h2 className="text-lg font-serif font-semibold text-foreground">{fyLabel}</h2>
              {CATEGORY_TRACKS.map((track) => {
                const cm = m[track.key];
                return (
                  <div key={track.key} className="space-y-2" data-testid={`fy-track-${track.slug}-${fySlug}`}>
                    <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      {track.label}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
                      {buildTiles(fySlug, fyLabel, track.slug, cm).map(renderTile)}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {countTiles.map((t) => (
          <Link key={t.label} href={t.href} data-testid={t.testId}>
            <Card className="cursor-pointer hover:bg-muted/30 transition-colors h-full">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {t.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-serif font-bold text-foreground">
                  {t.value === undefined ? "…" : t.value.toLocaleString()}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <UpcomingMeetingsCard />
        <TeamUpcomingMeetingsCard />
      </div>

      <TopPrioritiesRow />

      <MyTasksAndMentionsRow />

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

function MyTasksAndMentionsRow() {
  const { data: me } = useGetCurrentUser();
  const userId = me?.id;
  const OPEN_STATUSES: TaskStatus[] = ["open", "waiting"];
  const myTasksParams = { assigneeUserId: userId, status: OPEN_STATUSES, limit: 10 };
  const taskMentionParams = { mentionUserId: userId, status: OPEN_STATUSES, limit: 10 };
  const noteMentionParams = { mentionUserId: userId, limit: 10 };
  const { data: tasksData } = useListTasks(myTasksParams, {
    query: { enabled: !!userId, queryKey: getListTasksQueryKey(myTasksParams) },
  });
  const { data: mentionedTasks } = useListTasks(taskMentionParams, {
    query: { enabled: !!userId, queryKey: getListTasksQueryKey(taskMentionParams) },
  });
  const { data: mentionedNotes } = useListNotes(noteMentionParams, {
    query: { enabled: !!userId, queryKey: getListNotesQueryKey(noteMentionParams) },
  });
  const myTasks = tasksData?.data ?? [];
  const taskMentions = mentionedTasks?.data ?? [];
  const noteMentions = mentionedNotes?.data ?? [];
  const fmtDate = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
      <Card data-testid="card-mentions">
        <CardHeader>
          <CardTitle className="text-lg">Mentions</CardTitle>
        </CardHeader>
        <CardContent>
          {taskMentions.length === 0 && noteMentions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No mentions yet.</p>
          ) : (
            <ul className="space-y-2">
              {taskMentions.map((t) => (
                <li
                  key={`t-${t.id}`}
                  className="text-sm border rounded-md p-2"
                  data-testid={`dash-mention-task-${t.id}`}
                >
                  <span className="text-xs text-muted-foreground mr-1">Task:</span>
                  {t.title}
                </li>
              ))}
              {noteMentions.map((n) => (
                <li
                  key={`n-${n.id}`}
                  className="text-sm border rounded-md p-2"
                  data-testid={`dash-mention-note-${n.id}`}
                >
                  <span className="text-xs text-muted-foreground mr-1">Note:</span>
                  <span className="line-clamp-2 whitespace-pre-wrap">{n.body}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

