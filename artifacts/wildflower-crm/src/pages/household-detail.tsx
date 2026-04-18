import { useParams } from "wouter";
import { useGetHousehold, getGetHouseholdQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function HouseholdDetail() {
  const params = useParams();
  const id = params.id as string;

  const { data: household, isLoading } = useGetHousehold(id, {
    query: {
      enabled: !!id,
      queryKey: getGetHouseholdQueryKey(id)
    }
  });

  if (isLoading) return <div className="p-8 text-muted-foreground animate-pulse">Loading household...</div>;
  if (!household) return <div className="p-8 text-destructive">Household not found.</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            {household.name}
          </h1>
        </div>
      </div>
      
      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Household view coming soon.</p>
        </CardContent>
      </Card>
    </div>
  );
}
