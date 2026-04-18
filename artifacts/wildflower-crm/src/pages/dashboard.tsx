import {
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
  useGetRecentActivity,
  getGetRecentActivityQueryKey,
  useGetOverdueNextSteps,
  getGetOverdueNextStepsQueryKey,
  useGetDonorsGoneQuiet,
  getGetDonorsGoneQuietQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate, FUND_LABELS } from "@/lib/format";
import { AlertTriangle, TrendingUp, DollarSign, Calendar } from "lucide-react";

export default function Dashboard() {
  const { data: summary, isLoading } = useGetDashboardSummary(undefined, {
    query: { queryKey: getGetDashboardSummaryQueryKey() },
  });

  const { data: recentActivity } = useGetRecentActivity(undefined, {
    query: { queryKey: getGetRecentActivityQueryKey() },
  });

  const { data: overdueSteps } = useGetOverdueNextSteps(undefined, {
    query: { queryKey: getGetOverdueNextStepsQueryKey() },
  });

  const { data: quietDonors } = useGetDonorsGoneQuiet(undefined, {
    query: { queryKey: getGetDonorsGoneQuietQueryKey() },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-serif font-bold text-foreground">Dashboard</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Open Opportunities</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoading ? "—" : (summary?.openOpportunitiesCount ?? 0)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {formatCurrency(summary?.openOpportunitiesValue ?? 0)} pipeline value
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">YTD Giving</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoading ? "—" : formatCurrency(summary?.totalGivingCurrentFY ?? 0)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              vs {formatCurrency(summary?.totalGivingLastFY ?? 0)} last FY
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Overdue Next Steps</CardTitle>
            <AlertTriangle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">
              {isLoading ? "—" : (summary?.overdueNextStepsCount ?? 0)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Require attention</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pledge Installments Due</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoading ? "—" : (summary?.pledgeInstallmentsDueCount ?? 0)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Due next 30 days</p>
          </CardContent>
        </Card>
      </div>

      {summary?.opportunitiesByFund && summary.opportunitiesByFund.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pipeline by Fund</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {summary.opportunitiesByFund.map((item) => (
                <div key={item.fund} className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {FUND_LABELS[item.fund] ?? item.fund}
                  </p>
                  <p className="text-lg font-bold">{formatCurrency(item.value)}</p>
                  <p className="text-xs text-muted-foreground">{item.count} opportunities</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {quietDonors && quietDonors.length > 0 && (
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-amber-800">
              <AlertTriangle className="h-4 w-4" />
              {summary?.donorsGoneQuietCount ?? quietDonors.length} donor
              {(summary?.donorsGoneQuietCount ?? quietDonors.length) !== 1 ? "s" : ""} gone
              quiet (90+ days)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {quietDonors.slice(0, 5).map((donor) => (
                <div
                  key={donor.entityId}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="font-medium text-amber-900">{donor.entityName}</span>
                  <span className="text-xs text-amber-700">
                    {donor.lastMoveDate
                      ? `${donor.daysSinceLastMove}d ago`
                      : "Never contacted"}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Overdue Next Steps</CardTitle>
          </CardHeader>
          <CardContent>
            {!overdueSteps || overdueSteps.length === 0 ? (
              <p className="text-sm text-muted-foreground">No overdue next steps.</p>
            ) : (
              <div className="space-y-3">
                {overdueSteps.slice(0, 8).map((step) => (
                  <div
                    key={step.moveId}
                    className="border-l-2 border-destructive pl-3"
                  >
                    <p className="text-sm font-medium">{step.nextStep}</p>
                    <p className="text-xs text-muted-foreground">
                      {step.entityName} · {step.daysOverdue}d overdue
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {!recentActivity || recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent activity.</p>
            ) : (
              <div className="space-y-3">
                {recentActivity.slice(0, 8).map((item) => (
                  <div key={item.id} className="flex items-start gap-3">
                    <Badge variant="outline" className="text-[10px] mt-0.5 shrink-0 capitalize">
                      {item.type}
                    </Badge>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{item.entityName}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(item.timestamp)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
