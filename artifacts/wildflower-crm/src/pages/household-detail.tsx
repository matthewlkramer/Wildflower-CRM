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
import {
  EditPeopleEntityRoleDialog,
  AddHouseholdMemberDialog,
} from "@/components/add-role-dialogs";
import { UnifiedActivityFeed } from "@/components/unified-activity-feed";
import { TasksPanel } from "@/components/tasks-panel";
import {
  LinkedGiftsCard,
  LinkedOpportunitiesCard,
} from "@/components/linked-records";
import {
  RecordLayout,
  FieldCard,
  RelatedCard,
  AffiliationRow,
  type Highlight,
} from "@/components/record-layout";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate, formatEnum } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
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
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(household.name);

  const update = useUpdateHousehold({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetHouseholdQueryKey(household.id) }),
          queryClient.invalidateQueries({ queryKey: getListHouseholdsQueryKey() }),
        ]);
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

  function toggleActive() {
    const body: UpdateHouseholdBody = { active: !household.active };
    update.mutate({ id: household.id, data: body });
  }

  async function saveName() {
    const trimmed = nameValue.trim();
    if (!trimmed || trimmed === household.name) {
      setEditingName(false);
      return;
    }
    await update.mutateAsync({ id: household.id, data: { name: trimmed } });
    setEditingName(false);
  }

  const title = editingName ? (
    <Input
      value={nameValue}
      onChange={(e) => setNameValue(e.target.value)}
      className="h-11 max-w-md font-serif text-2xl font-bold"
      aria-label="Household name"
      data-testid="input-household-name"
      autoFocus
    />
  ) : (
    household.name
  );

  const actions = editingName ? (
    <>
      <Button
        onClick={saveName}
        disabled={update.isPending}
        data-testid="button-save-household-name"
      >
        {update.isPending ? "Saving…" : "Save"}
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setNameValue(household.name);
          setEditingName(false);
        }}
        disabled={update.isPending}
      >
        Cancel
      </Button>
    </>
  ) : (
    <>
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
        onClick={() => setEditingName(true)}
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
    </>
  );

  const members = household.people ?? [];

  const highlights: Highlight[] = [
    {
      label: "Status",
      value: (
        <Badge variant={household.active ? "default" : "outline"}>
          {household.active ? "Active" : "Inactive"}
        </Badge>
      ),
    },
    { label: "Members", value: members.length, accent: true },
  ];

  return (
    <RecordLayout
      backHref="/households"
      backLabel="Back to households"
      title={title}
      typeBadge="Household"
      actions={actions}
      highlights={highlights}
      left={
        <>
          <FieldCard title="Contact info">
            <div className="space-y-4">
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
            </div>
          </FieldCard>

          <div className="px-1 text-xs text-muted-foreground">
            Created {formatDate(household.createdAt)} • Updated {formatDate(household.updatedAt)}
          </div>
        </>
      }
      center={
        <>
          <TasksPanel householdId={household.id} />
          <UnifiedActivityFeed householdId={household.id} hideTasks />
        </>
      }
      right={
        <>
          <RelatedCard
            title="Members"
            count={members.length}
            action={<AddHouseholdMemberDialog householdId={household.id} />}
          >
            {members.length > 0 ? (
              <div>
                {members.map((p) => (
                  <div key={p.id} data-testid={`row-household-member-${p.id}`}>
                    <AffiliationRow
                      name={p.personName ?? `Person ${p.personId}`}
                      href={`/individuals/${p.personId}`}
                      role={p.externalTitleOrRole ?? formatEnum(p.connection)}
                      status={
                        p.current === "current"
                          ? "active"
                          : p.current
                            ? "past"
                            : undefined
                      }
                      primary={p.primaryContact ?? false}
                      action={<EditPeopleEntityRoleDialog role={p} />}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-2 py-2 text-sm text-muted-foreground">No members linked.</p>
            )}
          </RelatedCard>

          <LinkedOpportunitiesCard
            scope={{ householdId: household.id }}
            title="Pledges"
            pledgeView="pledges"
            emptyLabel="No pledges from this household."
          />

          <LinkedOpportunitiesCard
            scope={{ householdId: household.id }}
            title="Open opportunities"
            pledgeView="opportunities"
            status="open"
            emptyLabel="No open opportunities."
          />

          <LinkedGiftsCard scope={{ householdId: household.id }} />
        </>
      }
    />
  );
}
