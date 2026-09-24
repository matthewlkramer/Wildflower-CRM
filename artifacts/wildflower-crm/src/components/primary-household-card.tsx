import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetPersonQueryKey,
  useUpdatePerson,
} from "@workspace/api-client-react";
import {
  EntityCombobox,
  useHouseholdName,
  useHouseholdSearch,
} from "@/components/entity-picker";
import { CardAction, RelatedCard } from "@/components/record-layout";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

export function PrimaryHouseholdCard({
  personId,
  primaryHouseholdId,
}: {
  personId: string;
  primaryHouseholdId: string | null | undefined;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdatePerson();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(primaryHouseholdId ?? null);
  const householdName = useHouseholdName(primaryHouseholdId ?? null);

  useEffect(() => {
    if (editing) setDraft(primaryHouseholdId ?? null);
  }, [editing, primaryHouseholdId]);

  const save = async () => {
    try {
      await update.mutateAsync({
        id: personId,
        data: { primaryHouseholdId: draft },
      });
      await queryClient.invalidateQueries({
        queryKey: getGetPersonQueryKey(personId),
      });
      setEditing(false);
      toast({ title: "Primary household saved" });
    } catch (error) {
      toast({
        title: "Could not save the primary household",
        description:
          error instanceof Error ? error.message : "Something went wrong.",
        variant: "destructive",
      });
    }
  };

  return (
    <RelatedCard
      title="Primary household"
      empty={!primaryHouseholdId}
      action={
        !editing ? (
          <CardAction label="Edit" onClick={() => setEditing(true)} />
        ) : undefined
      }
    >
      {editing ? (
        <div className="space-y-3 px-2 py-2">
          <EntityCombobox
            useSearch={useHouseholdSearch}
            useResolve={useHouseholdName}
            value={draft}
            onChange={setDraft}
            placeholder="No primary household"
            testId="select-primary-household"
            disabled={update.isPending}
          />
          <p className="text-[11px] text-muted-foreground">
            Used by automatic donor-of-record routing and related-giving views.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setEditing(false)}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void save()}
              disabled={update.isPending}
              data-testid="button-save-primary-household"
            >
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="px-2 py-2 text-sm">
          {primaryHouseholdId
            ? householdName || "Loading household…"
            : "No primary household selected."}
        </div>
      )}
    </RelatedCard>
  );
}
