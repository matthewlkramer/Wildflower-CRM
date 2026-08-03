import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetDonorRoutingQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  useCreateOpportunityOrPledge,
  useGetDonorRouting,
  type DonorRecordKind,
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
import { useToast } from "@/hooks/use-toast";
import {
  DonorFieldPicker,
  donorBodyFor,
  type DonorType,
} from "@/components/entity-picker";

function routingKind(type: DonorType): DonorRecordKind {
  return type === "individual" ? "individual" : type;
}

export function PendingGiftDialog({
  open,
  onOpenChange,
  donor,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  donor: { type: DonorType; id: string; name?: string | null };
  onComplete?: (opportunityId: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [donorType, setDonorType] = useState<DonorType>(donor.type);
  const [donorId, setDonorId] = useState<string | null>(donor.id);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [commitmentDate, setCommitmentDate] = useState("");
  const [expectedDate, setExpectedDate] = useState("");

  useEffect(() => {
    if (!open) return;
    setDonorType(donor.type);
    setDonorId(donor.id);
    setName("");
    setAmount("");
    setCommitmentDate(new Date().toISOString().slice(0, 10));
    setExpectedDate("");
  }, [open, donor.id, donor.type]);

  const sourceKind = routingKind(donorType);
  const routing = useGetDonorRouting(sourceKind, donorId ?? "", {
    query: {
      enabled: open && !!donorId,
      queryKey: getGetDonorRoutingQueryKey(sourceKind, donorId ?? ""),
    },
  });
  const resolved = routing.data?.resolved ?? null;
  const requiresDecision = routing.data?.requiresDecision === true;
  const effectiveDonor = resolved
    ? {
        type: (resolved.kind === "individual"
          ? "individual"
          : resolved.kind) as DonorType,
        id: resolved.id,
        name: resolved.name,
      }
    : donorId && !routing.isLoading && !requiresDecision
      ? { type: donorType, id: donorId, name: null }
      : null;

  const create = useCreateOpportunityOrPledge({
    mutation: {
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({
          queryKey: getListOpportunitiesAndPledgesQueryKey(),
        });
        onOpenChange(false);
        toast({
          title: "Pending gift recorded",
          description:
            "This is a verbally committed opportunity awaiting actual payment. No gift has been created yet.",
        });
        if (created?.id) onComplete?.(created.id);
      },
      onError: (error: unknown) =>
        toast({
          title: "Could not record pending gift",
          description:
            error instanceof Error ? error.message : "Something went wrong.",
          variant: "destructive",
        }),
    },
  });

  const validAmount = Number(amount) > 0;
  const canSubmit =
    name.trim().length > 0 &&
    validAmount &&
    !!commitmentDate &&
    !!effectiveDonor &&
    !routing.isLoading &&
    !requiresDecision &&
    !create.isPending;

  const submit = () => {
    if (!canSubmit || !effectiveDonor) return;
    const donorBody = donorBodyFor(effectiveDonor.type, effectiveDonor.id);
    create.mutate({
      data: {
        name: name.trim(),
        organizationId: donorBody.organizationId ?? undefined,
        individualGiverPersonId: donorBody.individualGiverPersonId ?? undefined,
        householdId: donorBody.householdId ?? undefined,
        stage: "verbal_confirmation",
        commitmentPath: "gift",
        verbalCommitmentAt: commitmentDate,
        awardedAmount: amount,
        ...(expectedDate ? { projectedCloseDate: expectedDate } : {}),
      },
    });
  };

  const donorName =
    effectiveDonor?.name?.trim() || donor.name?.trim() || "this donor";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record pending gift</DialogTitle>
          <DialogDescription>
            Record {donorName}&apos;s verbal commitment to make a stand-alone
            gift. This creates an opportunity awaiting payment; the gift will be
            created only when an actual payment or deposit is selected.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Donor</Label>
            <DonorFieldPicker
              type={donorType}
              id={donorId}
              onChange={(type, id) => {
                setDonorType(type);
                setDonorId(id);
              }}
              testIdBase="pending-gift-donor"
              disabled={create.isPending}
            />
            {donorId && routing.isLoading ? (
              <p className="text-xs text-muted-foreground">
                Resolving the preferred donor pathway…
              </p>
            ) : requiresDecision ? (
              <p className="text-xs text-destructive">
                This donor is set to ask each time. Choose the intended donor of
                record directly before continuing.
              </p>
            ) : resolved &&
              (resolved.id !== donorId || resolved.kind !== sourceKind) ? (
              <p className="text-xs text-muted-foreground">
                The preferred donor pathway records this opportunity under{" "}
                {resolved.name}.
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pending-gift-name">Opportunity name</Label>
            <Input
              id="pending-gift-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. 2026 general support gift"
              autoFocus
              data-testid="input-pending-gift-name"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pending-gift-amount">Confirmed amount</Label>
              <Input
                id="pending-gift-amount"
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                data-testid="input-pending-gift-amount"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pending-gift-commitment-date">
                Verbal commitment date
              </Label>
              <Input
                id="pending-gift-commitment-date"
                type="date"
                value={commitmentDate}
                onChange={(event) => setCommitmentDate(event.target.value)}
                data-testid="input-pending-gift-commitment-date"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pending-gift-expected-date">
              Expected payment date (optional)
            </Label>
            <Input
              id="pending-gift-expected-date"
              type="date"
              value={expectedDate}
              onChange={(event) => setExpectedDate(event.target.value)}
              data-testid="input-pending-gift-expected-date"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!canSubmit}
            data-testid="button-record-pending-gift"
          >
            {create.isPending ? "Saving…" : "Record pending gift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
