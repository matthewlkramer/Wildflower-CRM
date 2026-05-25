import { useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetHousehold,
  useUpdateHousehold,
  useDeleteHousehold,
  getGetHouseholdQueryKey,
  getListHouseholdsQueryKey,
  type HouseholdDetail,
  type UpdateHouseholdBody,
} from "@workspace/api-client-react";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { ActivityTimeline } from "@/components/activity-timeline";
import {
  LinkedGiftsCard,
  LinkedOpportunitiesCard,
} from "@/components/linked-records";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate, formatEnum } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

export default function HouseholdDetail() {
  const [, params] = useRoute<{ id: string }>("/households/:id");
  const id = params?.id ?? "";

  const { data, isLoading, isError, error } = useGetHousehold(id, {
    query: { queryKey: getGetHouseholdQueryKey(id), enabled: !!id },
  });

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading household…</div>;
  if (isError || !data) {
    return (
      <div className="space-y-4">
        <Link href="/households" className="text-sm text-primary hover:underline">← Back to households</Link>
        <div className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Household not found."}
        </div>
      </div>
    );
  }
  return <HouseholdView household={data} />;
}

function HouseholdView({ household }: { household: HouseholdDetail }) {
  return (
    <div className="space-y-6">
      <div>
        <Link href="/households" className="text-sm text-primary hover:underline">← Back to households</Link>
      </div>

      <NameHeader household={household} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Members</CardTitle></CardHeader>
          <CardContent>
            {household.people && household.people.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {household.people.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-2"
                    data-testid={`row-household-member-${p.id}`}
                  >
                    <Link
                      href={`/individuals/${p.personId}`}
                      className="text-primary hover:underline truncate"
                    >
                      {p.externalTitleOrRole ?? `Person ${p.personId}`}
                    </Link>
                    <span className="text-muted-foreground text-xs whitespace-nowrap">
                      {formatEnum(p.connection)}
                      {p.current && p.current !== "current" ? ` (${formatEnum(p.current)})` : ""}
                      {p.primaryContact ? " • primary" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No members linked.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Contact info</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Emails</div>
              {household.emails && household.emails.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {household.emails.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{e.email}</span>
                      <span className="text-muted-foreground text-xs">
                        {e.isPreferred ? "preferred • " : ""}
                        {formatEnum(e.validity)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (<p className="text-sm text-muted-foreground">No emails.</p>)}
            </div>
            <Separator />
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Addresses</div>
              {household.addresses && household.addresses.length > 0 ? (
                <ul className="space-y-2 text-sm">
                  {household.addresses.map((a) => (
                    <li key={a.id}>
                      {[a.street, a.cityName, a.stateCode, a.postalCode].filter(Boolean).join(", ") || "—"}
                    </li>
                  ))}
                </ul>
              ) : (<p className="text-sm text-muted-foreground">No addresses.</p>)}
            </div>
          </CardContent>
        </Card>
      </div>

      <LinkedOpportunitiesCard
        scope={{ householdId: household.id }}
        title="Pledges"
        status="won"
        emptyLabel="No pledges from this household."
      />

      <LinkedOpportunitiesCard
        scope={{ householdId: household.id }}
        title="Open opportunities"
        status="open"
        emptyLabel="No open opportunities."
      />

      <LinkedGiftsCard scope={{ householdId: household.id }} />

      <ActivityTimeline householdId={household.id} />

      <div className="text-xs text-muted-foreground">
        Created {formatDate(household.createdAt)} • Updated {formatDate(household.updatedAt)}
      </div>
    </div>
  );
}

function NameHeader({ household }: { household: HouseholdDetail }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(household.name);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const del = useDeleteHousehold({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListHouseholdsQueryKey() });
        toast({ title: "Household deleted" });
        navigate("/households");
      },
      onError: (err: unknown) => {
        toast({
          title: "Delete failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });
  const update = useUpdateHousehold({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetHouseholdQueryKey(household.id) }),
          queryClient.invalidateQueries({ queryKey: getListHouseholdsQueryKey() }),
        ]);
        setEditing(false);
        toast({ title: "Household updated" });
      },
      onError: (err: unknown) => {
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  function toggleActive() {
    const body: UpdateHouseholdBody = { active: !household.active };
    update.mutate({ id: household.id, data: body });
  }

  if (editing) {
    const trimmed = value.trim();
    const dirty = trimmed.length > 0 && trimmed !== household.name;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="text-2xl font-serif font-bold h-12 max-w-xl"
          aria-label="Household name"
          data-testid="input-household-name"
          autoFocus
        />
        <Button
          onClick={() => {
            const body: UpdateHouseholdBody = { name: trimmed };
            update.mutate({ id: household.id, data: body });
          }}
          disabled={!dirty || update.isPending}
          data-testid="button-save-household-name"
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => { setValue(household.name); setEditing(false); }}
          disabled={update.isPending}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-3xl font-serif font-bold text-foreground">{household.name}</h1>
        <Badge variant={household.active ? "default" : "outline"}>
          {household.active ? "Active" : "Inactive"}
        </Badge>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={toggleActive}
          disabled={update.isPending}
          data-testid="button-toggle-household-active"
        >
          {household.active ? "Mark inactive" : "Mark active"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing(true)}
          data-testid="button-edit-household-name"
        >
          Edit name
        </Button>
        <ConfirmDeleteDialog
          title={`Delete ${household.name}?`}
          description="This household record will be removed. Member links from people and references from opportunities or gifts may need to be reassigned."
          onConfirm={() => del.mutateAsync({ id: household.id })}
          disabled={del.isPending}
          triggerTestId="button-delete-household"
          confirmTestId="button-confirm-delete-household"
        />
      </div>
    </div>
  );
}
