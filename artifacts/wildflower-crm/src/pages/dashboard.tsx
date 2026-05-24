import { Link } from "wouter";
import {
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";

export default function Dashboard() {
  const { data, isLoading, isError, error } = useGetDashboardSummary({
    query: { queryKey: getGetDashboardSummaryQueryKey() },
  });

  const counts = data?.counts;
  const fy = data?.currentFiscalYear;
  const byFy = data?.byFiscalYear ?? [];

  const countTiles = [
    { label: "People", value: counts?.people, href: "/individuals", testId: "tile-people" },
    { label: "Funding entities", value: counts?.funders, href: "/funding-entities", testId: "tile-funders" },
    { label: "Households", value: counts?.households, href: "/households", testId: "tile-households" },
    { label: "Organizations", value: counts?.organizations, href: "/organizations", testId: "tile-orgs" },
    { label: "Opportunities", value: counts?.opportunities, href: "/opportunities", testId: "tile-opps" },
    { label: "Open opps", value: counts?.openOpportunities, href: "/opportunities", testId: "tile-open-opps" },
    { label: "Won pledges", value: counts?.wonPledges, href: "/pledges", testId: "tile-pledges" },
    { label: "Gifts & payments", value: counts?.gifts, href: "/gifts", testId: "tile-gifts" },
  ];

  const moneyTiles = byFy.flatMap((m) => {
    const fySlug = m.fiscalYear.id; // e.g. "fy2026"
    const fyLabel = m.fiscalYear.label;
    return [
      {
        label: `Open pipeline ${fyLabel}`,
        value: m.openPipelineAsk,
        sub: `Open allocations booked to ${fyLabel}`,
        testId: `tile-pipeline-ask-${fySlug}`,
      },
      {
        label: `Weighted pipeline ${fyLabel}`,
        value: m.openPipelineWeighted,
        sub: `${fyLabel} open allocations × win probability`,
        testId: `tile-pipeline-weighted-${fySlug}`,
      },
      {
        label: `Received ${fyLabel}`,
        value: m.received,
        sub: `Gift allocations booked to ${fyLabel}`,
        testId: `tile-received-${fySlug}`,
      },
      {
        label: `Goal ${fyLabel}`,
        value: m.goal ?? undefined,
        sub: m.goal ? `Fundraising goal for ${fyLabel}` : `No goal set for ${fyLabel}`,
        testId: `tile-goal-${fySlug}`,
      },
    ];
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          A quick snapshot of the CRM. Fiscal year runs July 1 – June 30; currently{" "}
          <span className="font-medium">{fy?.label ?? "…"}</span>.
        </p>
      </div>

      {isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive" data-testid="dashboard-error">
          {error instanceof Error ? error.message : "Failed to load dashboard summary."}
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {moneyTiles.map((t) => (
          <Card key={t.label} data-testid={t.testId}>
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
        ))}
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
