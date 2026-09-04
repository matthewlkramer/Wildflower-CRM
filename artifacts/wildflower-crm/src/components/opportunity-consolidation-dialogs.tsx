import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetOpportunityOrPledgeQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  useCombineOpportunitiesAsPledge,
  useDeduplicateOpportunitiesAndPledges,
  type OpportunityOrPledge,
  type OpportunityOrPledgeDetail,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/format";
import { allSelectedLoaded } from "@/lib/merge-gate";
import { cn } from "@/lib/utils";

function opportunityLabel(row: OpportunityOrPledge): string {
  const donor =
    row.organizationName || row.individualGiverPersonName || row.householdName;
  return [donor, row.name].filter(Boolean).join(" — ") || row.id;
}

function donorKey(row: OpportunityOrPledge): string {
  if (row.organizationId) return `org:${row.organizationId}`;
  if (row.individualGiverPersonId)
    return `person:${row.individualGiverPersonId}`;
  if (row.householdId) return `household:${row.householdId}`;
  return "none";
}

function amountOf(row: OpportunityOrPledge): string {
  return row.awardedAmount ?? row.askAmount ?? "0";
}

type DialogBaseProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opportunities: OpportunityOrPledgeDetail[];
  expectedCount: number;
  loadError?: boolean;
  onDone?: (survivorId: string) => void;
};

export function DeduplicateOpportunitiesDialog({
  open,
  onOpenChange,
  opportunities,
  expectedCount,
  loadError = false,
  onDone,
}: DialogBaseProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mutation = useDeduplicateOpportunitiesAndPledges();
  const [primaryId, setPrimaryId] = useState("");
  const selectionKey = useMemo(
    () => opportunities.map((row) => row.id).join(","),
    [opportunities],
  );

  useEffect(() => {
    if (!open || opportunities.length === 0) return;
    setPrimaryId((current) =>
      opportunities.some((row) => row.id === current)
        ? current
        : opportunities[0]!.id,
    );
  }, [open, selectionKey, opportunities]);

  if (expectedCount < 2) return null;
  const allLoaded = allSelectedLoaded(
    opportunities.length,
    expectedCount,
    loadError,
  );
  const donorMismatch = new Set(opportunities.map(donorKey)).size > 1;
  const amountMismatch =
    new Set(opportunities.map((row) => Number(amountOf(row)).toFixed(2))).size >
    1;
  const canSubmit =
    allLoaded &&
    !!primaryId &&
    !donorMismatch &&
    !amountMismatch &&
    !mutation.isPending;

  const submit = async () => {
    if (!canSubmit) return;
    const mergeIds = opportunities
      .map((row) => row.id)
      .filter((id) => id !== primaryId);
    try {
      await mutation.mutateAsync({ data: { primaryId, mergeIds } });
      await queryClient.invalidateQueries({
        queryKey: getListOpportunitiesAndPledgesQueryKey(),
      });
      toast({
        title: "Duplicate opportunities archived",
        description: `${mergeIds.length} duplicate record${mergeIds.length === 1 ? "" : "s"} collapsed into the selected survivor.`,
      });
      onOpenChange(false);
      onDone?.(primaryId);
    } catch (error) {
      toast({
        title: "Dedup failed",
        description:
          error instanceof Error ? error.message : "Something went wrong.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Deduplicate opportunities</DialogTitle>
          <DialogDescription>
            Keep one authoritative opportunity and archive the duplicate
            records. The survivor&apos;s amount and allocations are not summed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!allLoaded && (
            <p
              className={cn(
                "text-sm",
                loadError ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {loadError
                ? "Some selected opportunities could not be loaded."
                : `Loading selected opportunities (${opportunities.length}/${expectedCount})…`}
            </p>
          )}
          <Label>Keep this opportunity</Label>
          <RadioGroup
            value={primaryId}
            onValueChange={setPrimaryId}
            className="gap-2"
          >
            {opportunities.map((row) => (
              <label
                key={row.id}
                className="flex cursor-pointer items-center gap-3 rounded-md border p-2 text-sm"
              >
                <RadioGroupItem value={row.id} />
                <span className="min-w-0 flex-1 truncate">
                  {opportunityLabel(row)}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {formatCurrency(amountOf(row))}
                </span>
              </label>
            ))}
          </RadioGroup>
          {donorMismatch && (
            <p className="text-sm text-destructive">
              The selected records have different donors.
            </p>
          )}
          {amountMismatch && (
            <p className="text-sm text-destructive">
              The selected records have different amounts.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {mutation.isPending ? "Deduplicating…" : "Deduplicate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type PaymentDraft = { amount: string; expectedDate: string };

export function CombineOpportunitiesAsPledgeDialog({
  open,
  onOpenChange,
  opportunities,
  expectedCount,
  loadError = false,
  onDone,
}: DialogBaseProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mutation = useCombineOpportunitiesAsPledge();
  const [primaryId, setPrimaryId] = useState("");
  const [name, setName] = useState("");
  const [commitmentDate, setCommitmentDate] = useState("");
  const [payments, setPayments] = useState<Record<string, PaymentDraft>>({});
  const selectionKey = useMemo(
    () => opportunities.map((row) => row.id).join(","),
    [opportunities],
  );

  useEffect(() => {
    if (!open || opportunities.length === 0) return;
    const first = opportunities[0]!;
    setPrimaryId(first.id);
    setName(first.name ?? "");
    setCommitmentDate(new Date().toISOString().slice(0, 10));
    setPayments(
      Object.fromEntries(
        opportunities.map((row) => [
          row.id,
          {
            amount: amountOf(row),
            expectedDate:
              row.projectedCloseDate ?? row.applicationDeadline ?? "",
          },
        ]),
      ),
    );
  }, [open, selectionKey, opportunities]);

  if (expectedCount < 2) return null;
  const allLoaded = allSelectedLoaded(
    opportunities.length,
    expectedCount,
    loadError,
  );
  const donorMismatch = new Set(opportunities.map(donorKey)).size > 1;
  const paymentRowsValid = opportunities.every((row) => {
    const draft = payments[row.id];
    return !!draft?.expectedDate && Number(draft.amount) > 0;
  });
  const total = opportunities.reduce(
    (sum, row) => sum + Number(payments[row.id]?.amount ?? 0),
    0,
  );
  const canSubmit =
    allLoaded &&
    !donorMismatch &&
    !!primaryId &&
    !!commitmentDate &&
    paymentRowsValid &&
    !mutation.isPending;

  const updatePayment = (id: string, patch: Partial<PaymentDraft>) => {
    setPayments((current) => ({
      ...current,
      [id]: { ...current[id]!, ...patch },
    }));
  };

  const submit = async () => {
    if (!canSubmit) return;
    const mergeIds = opportunities
      .map((row) => row.id)
      .filter((id) => id !== primaryId);
    try {
      const result = await mutation.mutateAsync({
        data: {
          primaryId,
          mergeIds,
          name: name.trim() || null,
          commitmentDate,
          expectedPayments: opportunities.map((row) => ({
            sourceOpportunityId: row.id,
            amount: payments[row.id]!.amount,
            expectedDate: payments[row.id]!.expectedDate,
          })),
        },
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getListOpportunitiesAndPledgesQueryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: getGetOpportunityOrPledgeQueryKey(result.pledgeId),
        }),
      ]);
      toast({
        title: "Pledge created",
        description: `${opportunities.length} opportunities are now ${opportunities.length} payment expectations on one ${formatCurrency(String(total))} pledge.`,
      });
      onOpenChange(false);
      onDone?.(result.pledgeId);
    } catch (error) {
      toast({
        title: "Could not combine opportunities",
        description:
          error instanceof Error ? error.message : "Something went wrong.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Combine as pledge</DialogTitle>
          <DialogDescription>
            The selected opportunities become one pledge. Each selected row
            becomes an explicit expected payment; allocations move onto the
            surviving pledge and the other opportunity headers are archived.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!allLoaded && (
            <p
              className={cn(
                "text-sm",
                loadError ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {loadError
                ? "Some selected opportunities could not be loaded."
                : `Loading selected opportunities (${opportunities.length}/${expectedCount})…`}
            </p>
          )}
          {donorMismatch && (
            <p className="text-sm text-destructive">
              All selected opportunities must have the same donor.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="combine-pledge-name">Pledge name</Label>
              <Input
                id="combine-pledge-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="combine-pledge-date">Commitment date</Label>
              <Input
                id="combine-pledge-date"
                type="date"
                value={commitmentDate}
                onChange={(event) => setCommitmentDate(event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Keep this record as the pledge</Label>
            <RadioGroup
              value={primaryId}
              onValueChange={setPrimaryId}
              className="gap-2"
            >
              {opportunities.map((row) => (
                <label
                  key={row.id}
                  className="flex cursor-pointer items-center gap-3 rounded-md border p-2 text-sm"
                >
                  <RadioGroupItem value={row.id} />
                  <span className="truncate">{opportunityLabel(row)}</span>
                </label>
              ))}
            </RadioGroup>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Expected payments</Label>
              <span className="text-sm font-medium">
                Total {formatCurrency(String(total))}
              </span>
            </div>
            {opportunities.map((row) => (
              <div
                key={row.id}
                className="grid items-end gap-2 rounded-md border p-2 sm:grid-cols-[1fr_9rem_10rem]"
              >
                <span className="truncate text-sm">
                  {opportunityLabel(row)}
                </span>
                <div className="space-y-1">
                  <Label className="text-xs">Amount</Label>
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={payments[row.id]?.amount ?? ""}
                    onChange={(event) =>
                      updatePayment(row.id, { amount: event.target.value })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Expected date</Label>
                  <Input
                    type="date"
                    value={payments[row.id]?.expectedDate ?? ""}
                    onChange={(event) =>
                      updatePayment(row.id, {
                        expectedDate: event.target.value,
                      })
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {mutation.isPending ? "Combining…" : "Combine as pledge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
