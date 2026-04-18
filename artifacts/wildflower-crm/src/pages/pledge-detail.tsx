import { useParams } from "wouter";
import { useGetPledge, getGetPledgeQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PledgeDetail() {
  const params = useParams();
  const id = params.id as string;

  const { data: pledge, isLoading } = useGetPledge(id, {
    query: {
      enabled: !!id,
      queryKey: getGetPledgeQueryKey(id)
    }
  });

  if (isLoading) return <div className="p-8 text-muted-foreground animate-pulse">Loading pledge...</div>;
  if (!pledge) return <div className="p-8 text-destructive">Pledge not found.</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            {pledge.donorName} Pledge
          </h1>
        </div>
      </div>
      
      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Pledge view coming soon.</p>
        </CardContent>
      </Card>
    </div>
  );
}
