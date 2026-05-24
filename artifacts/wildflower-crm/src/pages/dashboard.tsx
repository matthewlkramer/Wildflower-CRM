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
  const money = data?.money;
  const fy = data?.currentFiscalYear;

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

  const moneyTiles = [
    {
      label: "Open pipeline — ask",
      value: money?.openPipelineAsk,
      sub: "SUM(ask) across open opps",
      testId: "tile-pipeline-ask",
    },
    {
      label: "Open pipeline — expected",
      value: money?.openPipelineExpected,
      sub: "ask × win probability",
      testId: "tile-pipeline-expected",
    },
    {
      label: `Awarded ${fy?.label ?? "this FY"}`,
      value: money?.awardedCurrentFy,
      sub: fy ? `Won opps closed ${fy.startDate} → ${fy.endDate}` : "Won opps closed this fiscal year",
      testId: "tile-awarded-fy",
    },
    {
      label: `Received ${fy?.label ?? "this FY"}`,
      value: money?.receivedCurrentFy,
      sub: fy ? `Gift allocations booked to ${fy.label}` : "Gift allocations booked to this fiscal year",
      testId: "tile-received-fy",
    },
  ];

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
