import { useParams } from "wouter";
import { useGetOpportunity, getGetOpportunityQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function OpportunityDetail() {
  const params = useParams();
  const id = params.id as string;

  const { data: opportunity, isLoading } = useGetOpportunity(id, {
    query: {
      enabled: !!id,
      queryKey: getGetOpportunityQueryKey(id)
    }
  });

  if (isLoading) return <div className="p-8 text-muted-foreground animate-pulse">Loading opportunity...</div>;
  if (!opportunity) return <div className="p-8 text-destructive">Opportunity not found.</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            {opportunity.name || `${opportunity.donorName} Opportunity`}
          </h1>
        </div>
      </div>
      
      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Opportunity view coming soon.</p>
        </CardContent>
      </Card>
    </div>
  );
}
