import {
  getGetTopPrioritiesQueryKey,
  useGetTopPriorities,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { TopPrioritiesTables } from "@/components/top-priorities-tables";

export default function TopPrioritiesPage() {
  const { data, isLoading } = useGetTopPriorities({
    query: {
      queryKey: getGetTopPrioritiesQueryKey(),
      refetchOnMount: "always",
    },
  });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Top Priorities</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your most important funders and individuals in one place.
        </p>
      </div>
      <Card>
        <CardContent className="p-0">
          <TopPrioritiesTables
            funders={data?.organizations ?? []}
            individuals={data?.individuals ?? []}
            loading={isLoading}
          />
        </CardContent>
      </Card>
    </div>
  );
}
