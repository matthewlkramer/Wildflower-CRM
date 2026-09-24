import { useState } from "react";
import {
  getGetTopPrioritiesQueryKey,
  useGetCurrentUser,
  useGetTopPriorities,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DashboardScopeToggle,
  type DashboardScope,
} from "@/components/dashboard-scope-toggle";
import { TopPrioritiesTables } from "@/components/top-priorities-tables";

export function DashboardPrioritiesCard() {
  const [scope, setScope] = useState<DashboardScope>("mine");
  const { data: currentUser } = useGetCurrentUser();
  const { data, isLoading } = useGetTopPriorities({
    query: {
      queryKey: getGetTopPrioritiesQueryKey(),
      refetchOnMount: "always",
    },
  });
  const userId = currentUser?.id;
  const teamFunders = data?.organizations ?? [];
  const teamIndividuals = data?.individuals ?? [];
  const funders =
    scope === "team"
      ? teamFunders
      : teamFunders.filter((funder) => funder.ownerUserId === userId);
  const individuals =
    scope === "team"
      ? teamIndividuals
      : teamIndividuals.filter((person) => person.ownerUserId === userId);

  return (
    <Card data-testid="card-top-priorities">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-lg">Top priorities</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Funders, people, open asks, tasks, and recent giving in one view.
          </p>
        </div>
        <DashboardScopeToggle
          value={scope}
          onValueChange={setScope}
          testId="priorities-scope-toggle"
        />
      </CardHeader>
      <CardContent className="p-0">
        <TopPrioritiesTables
          funders={funders}
          individuals={individuals}
          loading={isLoading || (scope === "mine" && !userId)}
          tableIdPrefix={`dashboard-priorities-${scope}`}
        />
      </CardContent>
    </Card>
  );
}
