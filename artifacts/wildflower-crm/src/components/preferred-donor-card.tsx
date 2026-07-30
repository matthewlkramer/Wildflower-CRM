import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetDonorRoutingQueryKey,
  useGetDonorRouting,
  useUpdateDonorRouting,
  type DonorRecordKind,
  type DonorRoutingMode,
} from "@workspace/api-client-react";
import { RelatedCard, CardAction } from "@/components/record-layout";
import { DonorFieldPicker, type DonorType } from "@/components/entity-picker";
import {
  EntityCombobox,
  useHouseholdName,
  useHouseholdSearch,
  useIntermediaryName,
  useIntermediarySearch,
} from "@/components/entity-picker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const MODE_LABEL: Record<DonorRoutingMode, string> = {
  self: "Use this record",
  target: "Route to another donor",
  ask: "Ask each time",
};

function donorTypeFromKind(kind: DonorRecordKind): DonorType {
  return kind === "individual" ? "individual" : kind;
}

function donorKindFromType(type: DonorType): DonorRecordKind {
  return type === "individual" ? "individual" : type;
}

export function PreferredDonorCard({
  sourceKind,
  sourceId,
}: {
  sourceKind: DonorRecordKind;
  sourceId: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = getGetDonorRoutingQueryKey(sourceKind, sourceId);
  const query = useGetDonorRouting(sourceKind, sourceId, {
    query: { queryKey },
  });
  const update = useUpdateDonorRouting();
  const settings = query.data ?? null;
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<DonorRoutingMode>("self");
  const [targetType, setTargetType] = useState<DonorType>("organization");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [primaryHouseholdId, setPrimaryHouseholdId] = useState<string | null>(
    null,
  );
  const [defaultIntermediaryId, setDefaultIntermediaryId] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (!editing || !settings) return;
    setMode(settings.mode);
    setTargetType(
      settings.target
        ? donorTypeFromKind(settings.target.kind)
        : sourceKind === "organization"
          ? "organization"
          : sourceKind === "household"
            ? "household"
            : "organization",
    );
    setTargetId(settings.target?.id ?? null);
    setPrimaryHouseholdId(settings.primaryHousehold?.id ?? null);
    setDefaultIntermediaryId(settings.defaultPaymentIntermediary?.id ?? null);
  }, [editing, settings, sourceKind]);

  const cancel = () => setEditing(false);

  const save = async () => {
    if (mode === "target" && !targetId) {
      toast({
        title: "Choose a preferred donor",
        description: "Select the donor record this pathway should use.",
        variant: "destructive",
      });
      return;
    }
    try {
      await update.mutateAsync({
        sourceKind,
        sourceId,
        data: {
          mode,
          targetKind: mode === "target" ? donorKindFromType(targetType) : null,
          targetId: mode === "target" ? targetId : null,
          primaryHouseholdId:
            sourceKind === "individual" ? primaryHouseholdId : null,
          defaultPaymentIntermediaryId: defaultIntermediaryId,
        },
      });
      await queryClient.invalidateQueries({ queryKey });
      setEditing(false);
      toast({ title: "Preferred donor settings saved" });
    } catch (error) {
      toast({
        title: "Could not save preferred donor settings",
        description:
          error instanceof Error ? error.message : "Something went wrong.",
        variant: "destructive",
      });
    }
  };

  const pathwayText = !settings
    ? "Loading preferred donor settings…"
    : settings.mode === "ask"
      ? "Ask each time"
      : settings.resolved
        ? settings.resolved.id === settings.source.id &&
          settings.resolved.kind === settings.source.kind
          ? "Use this record"
          : `Use ${settings.resolved.name}`
        : "Needs a donor decision";

  return (
    <RelatedCard
      title="Preferred donor pathway"
      action={
        settings && !editing ? (
          <CardAction label="Edit" onClick={() => setEditing(true)} />
        ) : undefined
      }
    >
      {query.isLoading ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
      ) : query.isError || !settings ? (
        <p className="px-2 py-2 text-sm text-destructive">
          Preferred donor settings could not be loaded.
        </p>
      ) : editing ? (
        <div className="space-y-4 px-2 py-2">
          <div className="space-y-1.5">
            <Label>When this donor is selected</Label>
            <Select
              value={mode}
              onValueChange={(value) => setMode(value as DonorRoutingMode)}
              disabled={update.isPending}
            >
              <SelectTrigger data-testid="select-donor-routing-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(MODE_LABEL) as DonorRoutingMode[]).map(
                  (value) => (
                    <SelectItem key={value} value={value}>
                      {MODE_LABEL[value]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>

          {mode === "target" ? (
            <div className="space-y-1.5">
              <Label>Preferred donor of record</Label>
              <DonorFieldPicker
                type={targetType}
                id={targetId}
                onChange={(nextType, nextId) => {
                  setTargetType(nextType);
                  setTargetId(nextId);
                }}
                testIdBase="preferred-donor-target"
                disabled={update.isPending}
              />
            </div>
          ) : null}

          {sourceKind === "individual" ? (
            <div className="space-y-1.5">
              <Label>Primary household</Label>
              <EntityCombobox
                useSearch={useHouseholdSearch}
                useResolve={useHouseholdName}
                value={primaryHouseholdId}
                onChange={setPrimaryHouseholdId}
                placeholder="No primary household"
                testId="select-primary-household"
                disabled={update.isPending}
              />
              <p className="text-[11px] text-muted-foreground">
                This is the one current household used for related-giving rules.
              </p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label>Default payment intermediary</Label>
            <EntityCombobox
              useSearch={useIntermediarySearch}
              useResolve={useIntermediaryName}
              value={defaultIntermediaryId}
              onChange={setDefaultIntermediaryId}
              placeholder="No default intermediary"
              testId="select-default-payment-intermediary"
              disabled={update.isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              For example, Vanguard Charitable or another DAF sponsor. The
              intermediary is not the donor of record.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={cancel}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void save()}
              disabled={update.isPending || (mode === "target" && !targetId)}
              data-testid="button-save-preferred-donor"
            >
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 px-2 py-2 text-sm">
          <div>
            <div className="text-xs font-medium text-muted-foreground">
              Donor of record
            </div>
            <div>{pathwayText}</div>
          </div>
          {settings.path.length > 1 ? (
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                Pathway
              </div>
              <div className="text-xs">
                {settings.path.map((node) => node.name).join(" → ")}
              </div>
            </div>
          ) : null}
          {sourceKind === "individual" ? (
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                Primary household
              </div>
              <div>{settings.primaryHousehold?.name ?? "None"}</div>
            </div>
          ) : null}
          <div>
            <div className="text-xs font-medium text-muted-foreground">
              Default intermediary
            </div>
            <div>{settings.defaultPaymentIntermediary?.name ?? "None"}</div>
          </div>
        </div>
      )}
    </RelatedCard>
  );
}
