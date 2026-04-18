import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetHousehold, getGetHouseholdQueryKey, useUpdateHousehold, type UpdateHouseholdBody } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EditDialog } from "@/components/edit-dialog";
import { formatCurrency, formatDate, formatEnum, formatCapacity } from "@/lib/format";

export default function HouseholdDetail() {
  const params = useParams();
  const id = params.id as string;

  const queryClient = useQueryClient();
  const { data: household, isLoading } = useGetHousehold(id, {
    query: {
      enabled: !!id,
      queryKey: getGetHouseholdQueryKey(id)
    }
  });
  const updateMutation = useUpdateHousehold({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetHouseholdQueryKey(id) }),
    },
  });

  if (isLoading) return <div className="p-8 text-muted-foreground animate-pulse">Loading household...</div>;
  if (!household) return <div className="p-8 text-destructive">Household not found.</div>;

  const customFieldEntries = household.customFields ? Object.entries(household.customFields) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">{household.name}</h1>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <Badge variant={household.status === "active" ? "default" : "outline"}>
              {formatEnum(household.status)}
            </Badge>
            {household.capacityRating && (
              <span className="text-sm text-muted-foreground">{formatCapacity(household.capacityRating)}</span>
            )}
            {household.formationDate && (
              <span className="text-sm text-muted-foreground">Formed {formatDate(household.formationDate)}</span>
            )}
          </div>
        </div>
        <EditDialog
          trigger={<Button variant="outline" size="sm">Edit</Button>}
          title="Edit household"
          isPending={updateMutation.isPending}
          fields={[
            {
              kind: "select",
              key: "status",
              label: "Status",
              value: household.status,
              options: [
                { value: "active", label: "Active" },
                { value: "dissolved", label: "Dissolved" },
              ],
            },
            { kind: "textarea", key: "notes", label: "Notes", value: household.notes ?? null },
            { kind: "json", key: "customFields", label: "Custom fields (JSON)", value: household.customFields ?? null },
          ]}
          onSubmit={async (values) => {
            await updateMutation.mutateAsync({ id, data: values });
          }}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-lg">Total Giving</CardTitle></CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-primary">{formatCurrency(household.totalGiving)}</p>
            <p className="text-sm text-muted-foreground mt-1">{household.memberCount} member{household.memberCount === 1 ? "" : "s"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-lg">Last Activity</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm">{formatDate(household.lastActivityDate)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-lg">Stewardship</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div><span className="font-medium">Owner:</span> {household.primaryOwnerName || "—"}</div>
            <div><span className="font-medium">Strategy:</span> {household.strategyUserName || "—"}</div>
            <div><span className="font-medium">Primary giver:</span> {household.primaryGivingIndividualName || "—"}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Members</CardTitle></CardHeader>
          <CardContent>
            {household.members && household.members.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {household.members.map((m) => (
                  <li key={m.id} className="flex items-center justify-between">
                    <Link href={`/individuals/${m.individualId}`} className="text-primary hover:underline">
                      {m.individualName}
                    </Link>
                    <span className="text-muted-foreground">{formatEnum(m.role)}{m.isCurrent ? "" : " (former)"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No members.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Linked Funding Entities</CardTitle></CardHeader>
          <CardContent>
            {household.linkedFundingEntities && household.linkedFundingEntities.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {household.linkedFundingEntities.map((fe) => (
                  <li key={fe.id}>
                    <Link href={`/funding-entities/${fe.id}`} className="text-primary hover:underline">
                      {fe.legalName}
                    </Link>
                    <span className="text-muted-foreground"> — {formatEnum(fe.subtype)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No linked funding entities.</p>
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

      {(household.decisionMakingNotes || household.familyPhilanthropyNotes || household.notes) && (
        <Card>
          <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {household.decisionMakingNotes && (
              <div>
                <div className="font-medium">Decision Making</div>
                <p className="text-muted-foreground whitespace-pre-wrap">{household.decisionMakingNotes}</p>
              </div>
            )}
            {household.familyPhilanthropyNotes && (
              <div>
                <div className="font-medium">Family Philanthropy</div>
                <p className="text-muted-foreground whitespace-pre-wrap">{household.familyPhilanthropyNotes}</p>
              </div>
            )}
            {household.notes && (
              <div>
                <div className="font-medium">General</div>
                <p className="text-muted-foreground whitespace-pre-wrap">{household.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
