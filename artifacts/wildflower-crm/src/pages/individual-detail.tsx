import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetIndividual, getGetIndividualQueryKey, useUpdateIndividual, type UpdateIndividualBody } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EditDialog } from "@/components/edit-dialog";
import { formatCurrency, formatDate, formatEnum, formatCapacity } from "@/lib/format";

export default function IndividualDetail() {
  const params = useParams();
  const id = params.id as string;

  const queryClient = useQueryClient();
  const { data: individual, isLoading } = useGetIndividual(id, {
    query: {
      enabled: !!id,
      queryKey: getGetIndividualQueryKey(id)
    }
  });
  const updateMutation = useUpdateIndividual({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetIndividualQueryKey(id) }),
    },
  });

  if (isLoading) return <div className="p-8 text-muted-foreground animate-pulse">Loading individual...</div>;
  if (!individual) return <div className="p-8 text-destructive">Individual not found.</div>;

  const primaryEmail = individual.emails?.find((e) => e.isPrimary) ?? individual.emails?.[0];
  const primaryPhone = individual.phones?.find((p) => p.isPrimary) ?? individual.phones?.[0];
  const primaryAddress = individual.addresses?.find((a) => a.isPrimary) ?? individual.addresses?.[0];
  const customFieldEntries = individual.customFields ? Object.entries(individual.customFields) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            {individual.firstName} {individual.lastName}
          </h1>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <Badge variant="outline">{formatEnum(individual.donorCultivationStage)}</Badge>
            <Badge variant="secondary">{formatEnum(individual.enthusiasm)}</Badge>
            <span className="text-sm text-muted-foreground">{formatCapacity(individual.capacityRating)}</span>
            {individual.birthday && (
              <span className="text-sm text-muted-foreground">🎂 {formatDate(individual.birthday)}</span>
            )}
          </div>
        </div>
        <EditDialog
          trigger={<Button variant="outline" size="sm">Edit</Button>}
          title="Edit individual"
          isPending={updateMutation.isPending}
          fields={[
            { kind: "date", key: "birthday", label: "Birthday", value: individual.birthday },
            { kind: "keyValue", key: "customFields", label: "Custom fields", value: individual.customFields ?? null, help: "Values are saved as text. Existing structured values are preserved when left unchanged." },
          ]}
          onSubmit={async (values) => {
            await updateMutation.mutateAsync({ id, data: values as Pick<UpdateIndividualBody, "birthday" | "customFields"> });
          }}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Contact Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div><span className="font-medium">Email:</span> {primaryEmail?.email || "—"}</div>
              <div><span className="font-medium">Phone:</span> {primaryPhone?.phone || "—"}</div>
              <div><span className="font-medium">Location:</span> {primaryAddress ? [primaryAddress.city, primaryAddress.state].filter(Boolean).join(", ") || "—" : "—"}</div>
              {individual.household && (
                <div>
                  <span className="font-medium">Household:</span>{" "}
                  <Link href={`/households/${individual.household.id}`} className="text-primary hover:underline">
                    {individual.household.name}
                  </Link>
                </div>
              )}
              {individual.spouseId && (
                <div>
                  <span className="font-medium">Spouse:</span>{" "}
                  <Link href={`/individuals/${individual.spouseId}`} className="text-primary hover:underline">
                    {individual.spouseName || "View"}
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>

          {customFieldEntries.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Custom Fields</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {customFieldEntries.map(([key, value]) => (
                  <div key={key}>
                    <span className="font-medium">{formatEnum(key)}:</span>{" "}
                    <span className="text-muted-foreground">{String(value)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
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
                <CardContent className="space-y-4">
                  <div className="text-sm">
                    <p className="text-muted-foreground">Total Giving: {formatCurrency(individual.totalGiving)}</p>
                    <p className="text-muted-foreground">Last Gift: {formatCurrency(individual.lastGiftAmount)} on {formatDate(individual.lastGiftDate)}</p>
                  </div>
                  {individual.givingHistory && individual.givingHistory.length > 0 ? (
                    <ul className="space-y-3 text-sm border-t pt-4">
                      {individual.givingHistory.map((g) => {
                        const payerNote =
                          g.payerName && g.payerName !== g.donorName
                            ? `paid by ${g.payerName}`
                            : g.fiscalSponsorName
                            ? `via ${g.fiscalSponsorName}`
                            : null;
                        return (
                          <li
                            key={g.id}
                            className="flex items-start justify-between gap-3"
                            data-testid={`row-individual-gift-${g.id}`}
                          >
                            <div className="min-w-0">
                              <Link
                                href={`/gifts/${g.id}`}
                                className="text-primary hover:underline block truncate"
                              >
                                {g.donorName ?? "Unknown donor"}
                              </Link>
                              <div className="text-xs text-muted-foreground">
                                {formatDate(g.cashReceivedDate)}
                                {payerNote ? ` • ${payerNote}` : ""}
                              </div>
                            </div>
                            <span className="font-medium whitespace-nowrap">
                              {formatCurrency(g.amount)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground border-t pt-4">No gifts recorded.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="opportunities" className="mt-4">
               <Card>
                <CardHeader><CardTitle>Opportunities</CardTitle></CardHeader>
                <CardContent>
                  {individual.openOpportunities && individual.openOpportunities.length > 0 ? (
                    <ul className="text-sm space-y-1">
                      {individual.openOpportunities.map((o) => (
                        <li key={o.id} className="text-muted-foreground">{o.name} — {formatCurrency(o.amountRequested)}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">No opportunities to display.</p>
                  )}
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
