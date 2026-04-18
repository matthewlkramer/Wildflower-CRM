import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetFundingEntity, getGetFundingEntityQueryKey, useUpdateFundingEntity, type UpdateFundingEntityBody } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EditDialog } from "@/components/edit-dialog";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";

export default function FundingEntityDetail() {
  const params = useParams();
  const id = params.id as string;

  const queryClient = useQueryClient();
  const { data: entity, isLoading } = useGetFundingEntity(id, {
    query: {
      enabled: !!id,
      queryKey: getGetFundingEntityQueryKey(id)
    }
  });
  const updateMutation = useUpdateFundingEntity({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetFundingEntityQueryKey(id) }),
    },
  });

  if (isLoading) return <div className="p-8 text-muted-foreground animate-pulse">Loading entity...</div>;
  if (!entity) return <div className="p-8 text-destructive">Entity not found.</div>;

  const customFieldEntries = entity.customFields ? Object.entries(entity.customFields) : [];
  const statusVariant = entity.status === "active" ? "default" : entity.status === "defunct" ? "destructive" : "outline";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            {entity.displayName || entity.legalName}
          </h1>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <Badge>{formatEnum(entity.subtype)}</Badge>
            {entity.status && <Badge variant={statusVariant}>{formatEnum(entity.status)}</Badge>}
            <Badge variant="secondary">{formatEnum(entity.enthusiasm)}</Badge>
            {entity.metroArea && <span className="text-sm text-muted-foreground">{entity.metroArea}</span>}
          </div>
          {entity.parentFundingEntityId && (
            <p className="text-sm text-muted-foreground mt-1">
              Parent:{" "}
              <Link href={`/funding-entities/${entity.parentFundingEntityId}`} className="text-primary hover:underline">
                View parent entity
              </Link>
            </p>
          )}
        </div>
        <EditDialog
          trigger={<Button variant="outline" size="sm">Edit</Button>}
          title="Edit funding entity"
          isPending={updateMutation.isPending}
          fields={[
            {
              kind: "select",
              key: "status",
              label: "Status",
              value: entity.status,
              options: [
                { value: "active", label: "Active" },
                { value: "defunct", label: "Defunct" },
                { value: "merged", label: "Merged" },
              ],
            },
            {
              kind: "text",
              key: "parentFundingEntityId",
              label: "Parent funding entity ID",
              value: entity.parentFundingEntityId,
            },
            { kind: "textarea", key: "notes", label: "Notes", value: entity.notes ?? null },
            { kind: "json", key: "customFields", label: "Custom fields (JSON)", value: entity.customFields ?? null },
          ]}
          onSubmit={async (values) => {
            await updateMutation.mutateAsync({ id, data: values as Pick<UpdateFundingEntityBody, "status" | "parentFundingEntityId" | "notes" | "customFields"> });
          }}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-lg">Total Giving</CardTitle></CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-primary">{formatCurrency(entity.totalGiving)}</p>
            <p className="text-sm text-muted-foreground mt-1">Last gift {formatDate(entity.lastGiftDate)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-lg">Typical Grant</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm">
              {entity.typicalGrantSizeMin || entity.typicalGrantSizeMax
                ? `${formatCurrency(entity.typicalGrantSizeMin)} – ${formatCurrency(entity.typicalGrantSizeMax)}`
                : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-lg">Stewardship</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div><span className="font-medium">Owner:</span> {entity.relationshipOwnerName || "—"}</div>
            <div><span className="font-medium">Strategy:</span> {entity.strategyUserName || "—"}</div>
            <div><span className="font-medium">Primary contact:</span> {entity.primaryContactName || "—"}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>People</CardTitle></CardHeader>
          <CardContent>
            {entity.people && entity.people.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {entity.people.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <Link href={`/individuals/${p.individualId}`} className="text-primary hover:underline">
                      {p.individualName}
                    </Link>
                    <span className="text-muted-foreground text-xs">
                      {formatEnum(p.affiliationType)}{p.role ? ` • ${p.role}` : ""}{p.isCurrent ? "" : " (former)"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No people linked.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Recent Gifts</CardTitle></CardHeader>
          <CardContent>
            {entity.givingHistory && entity.givingHistory.length > 0 ? (
              <ul className="space-y-3 text-sm">
                {entity.givingHistory.slice(0, 8).map((g) => {
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
                      data-testid={`row-funder-gift-${g.id}`}
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
              <p className="text-sm text-muted-foreground">No gifts recorded.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {customFieldEntries.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Custom Fields</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-2 text-sm">
            {customFieldEntries.map(([key, value]) => (
              <div key={key}>
                <span className="font-medium">{formatEnum(key)}:</span>{" "}
                <span className="text-muted-foreground">{String(value)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {(entity.fundingCycleNotes || entity.applicationRequirementsNotes || entity.notes) && (
        <Card>
          <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {entity.fundingCycleNotes && (
              <div>
                <div className="font-medium">Funding Cycle</div>
                <p className="text-muted-foreground whitespace-pre-wrap">{entity.fundingCycleNotes}</p>
              </div>
            )}
            {entity.applicationRequirementsNotes && (
              <div>
                <div className="font-medium">Application Requirements</div>
                <p className="text-muted-foreground whitespace-pre-wrap">{entity.applicationRequirementsNotes}</p>
              </div>
            )}
            {entity.notes && (
              <div>
                <div className="font-medium">General</div>
                <p className="text-muted-foreground whitespace-pre-wrap">{entity.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
