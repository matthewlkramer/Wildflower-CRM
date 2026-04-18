import { useParams } from "wouter";
import { useGetFundingEntity, getGetFundingEntityQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function FundingEntityDetail() {
  const params = useParams();
  const id = params.id as string;

  const { data: entity, isLoading } = useGetFundingEntity(id, {
    query: {
      enabled: !!id,
      queryKey: getGetFundingEntityQueryKey(id)
    }
  });

  if (isLoading) return <div className="p-8 text-muted-foreground animate-pulse">Loading entity...</div>;
  if (!entity) return <div className="p-8 text-destructive">Entity not found.</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            {entity.legalName}
          </h1>
        </div>
      </div>
      
      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Entity view coming soon.</p>
        </CardContent>
      </Card>
    </div>
  );
}
