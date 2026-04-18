import { useParams, Link } from "wouter";
import { useGetIndividual, getGetIndividualQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrency, formatDate, formatEnum, formatCapacity } from "@/lib/format";

export default function IndividualDetail() {
  const params = useParams();
  const id = params.id as string;

  const { data: individual, isLoading } = useGetIndividual(id, {
    query: {
      enabled: !!id,
      queryKey: getGetIndividualQueryKey(id)
    }
  });

  if (isLoading) return <div className="p-8 text-muted-foreground animate-pulse">Loading individual...</div>;
  if (!individual) return <div className="p-8 text-destructive">Individual not found.</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            {individual.firstName} {individual.lastName}
          </h1>
          <div className="mt-2 flex items-center gap-2">
            <Badge variant="outline">{formatEnum(individual.donorCultivationStage)}</Badge>
            <Badge variant="secondary">{formatEnum(individual.enthusiasm)}</Badge>
            <span className="text-sm text-muted-foreground">{formatCapacity(individual.capacityRating)}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Contact Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div><span className="font-medium">Email:</span> {individual.primaryEmail || "—"}</div>
              <div><span className="font-medium">Phone:</span> {individual.primaryPhone || "—"}</div>
              <div><span className="font-medium">Location:</span> {individual.metroArea || "—"}</div>
              {individual.householdId && (
                <div>
                  <span className="font-medium">Household:</span>{" "}
                  <Link href={`/households/${individual.householdId}`} className="text-primary hover:underline">
                    {individual.householdName || "View Household"}
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="md:col-span-2">
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="giving">Giving History</TabsTrigger>
              <TabsTrigger value="opportunities">Opportunities</TabsTrigger>
              <TabsTrigger value="moves">Moves</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="mt-4">
              <Card>
                <CardHeader><CardTitle>Overview</CardTitle></CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{individual.biography || "No biography available."}</p>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="giving" className="mt-4">
              <Card>
                <CardHeader><CardTitle>Giving History</CardTitle></CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">Total Giving: {formatCurrency(individual.totalGiving)}</p>
                  <p className="text-sm text-muted-foreground">Last Gift: {formatCurrency(individual.lastGiftAmount)} on {formatDate(individual.lastGiftDate)}</p>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="opportunities" className="mt-4">
               <Card>
                <CardHeader><CardTitle>Opportunities</CardTitle></CardHeader>
                <CardContent>
                   <p className="text-sm text-muted-foreground">No opportunities to display.</p>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="moves" className="mt-4">
               <Card>
                <CardHeader><CardTitle>Moves Log</CardTitle></CardHeader>
                <CardContent>
                   <p className="text-sm text-muted-foreground">Last Move: {formatDate(individual.lastMoveDate)}</p>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
