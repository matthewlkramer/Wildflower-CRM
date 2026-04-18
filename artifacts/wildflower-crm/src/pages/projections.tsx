import { useGetProjectionsForecast, getGetProjectionsForecastQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend } from "recharts";
import { formatCurrency } from "@/lib/format";

export default function Projections() {
  const { data, isLoading } = useGetProjectionsForecast(undefined, {
    query: {
      queryKey: getGetProjectionsForecastQueryKey(),
    },
  });

  if (isLoading) {
    return <div className="p-8 text-muted-foreground animate-pulse">Loading projections...</div>;
  }

  const chartData = (data?.fiscalYears ?? []).map((y) => ({
    year: y.label,
    confirmed: y.confirmed,
    weighted: y.weightedPipeline,
    stretch: y.stretch,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-serif font-bold text-foreground">Revenue Projections</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Confirmed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-confirmed">
              {formatCurrency(data?.totalConfirmed ?? 0)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Weighted Pipeline</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-weighted-pipeline">
              {formatCurrency(data?.totalWeightedPipeline ?? 0)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Forecast</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-forecast">
              {formatCurrency(data?.totalForecast ?? 0)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>3-Year Revenue Forecast</CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <div className="flex h-[400px] items-center justify-center text-sm text-muted-foreground">
              No opportunity data to display. Add opportunities with fiscal years assigned.
            </div>
          ) : (
            <div className="h-[400px] w-full" data-testid="chart-projections">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                  <XAxis dataKey="year" />
                  <YAxis tickFormatter={(val: number) => `$${(val / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(value: number) => formatCurrency(value)} />
                  <Legend />
                  <Bar dataKey="confirmed" stackId="a" fill="hsl(153, 43%, 28%)" name="Confirmed" />
                  <Bar dataKey="weighted" stackId="a" fill="hsl(153, 43%, 45%)" name="Weighted Pipeline" />
                  <Bar dataKey="stretch" stackId="a" fill="hsl(40, 20%, 80%)" name="Stretch" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {(data?.fiscalYears ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Detail by Year</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-2 font-medium">Fiscal Year</th>
                    <th className="text-right py-2 font-medium">Confirmed</th>
                    <th className="text-right py-2 font-medium">Weighted Pipeline</th>
                    <th className="text-right py-2 font-medium">Stretch</th>
                    <th className="text-right py-2 font-medium">Total Forecast</th>
                    {data!.fiscalYears[0].target != null && (
                      <th className="text-right py-2 font-medium">Target</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data!.fiscalYears.map((fy) => (
                    <tr key={fy.fiscalYear} className="border-b last:border-0" data-testid={`row-projection-${fy.fiscalYear}`}>
                      <td className="py-3 font-medium">{fy.label}</td>
                      <td className="py-3 text-right">{formatCurrency(fy.confirmed)}</td>
                      <td className="py-3 text-right">{formatCurrency(fy.weightedPipeline)}</td>
                      <td className="py-3 text-right text-muted-foreground">{formatCurrency(fy.stretch)}</td>
                      <td className="py-3 text-right font-semibold">{formatCurrency(fy.totalForecast)}</td>
                      {fy.target != null && (
                        <td className="py-3 text-right">{formatCurrency(fy.target)}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
