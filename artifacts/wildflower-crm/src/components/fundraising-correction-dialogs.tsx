import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetGiftOrPaymentQueryKey,
  getGetOpportunityOrPledgeQueryKey,
  getListGiftsAndPaymentsQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  useConvertPledgeToStandaloneGift,
  useDetachGiftFromPledge,
  useRevertGiftToOpportunity,
  useRevertPledgeToOpportunity,
  useRevertPledgeToVerbalGift,
  type OpportunityStage,
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const GENERAL_STAGE_OPTIONS: ReadonlyArray<{
  value: OpportunityStage;
  label: string;
}> = [
  { value: "cold_lead", label: "Cold lead" },
  { value: "warm_lead", label: "Warm lead" },
  { value: "in_conversation", label: "In conversation" },
  { value: "convince", label: "Convince" },
  { value: "probable_renewal", label: "Probable renewal" },
];

async function refreshAll(
  queryClient: ReturnType<typeof useQueryClient>,
  opportunityId?: string,
  giftId?: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: getListOpportunitiesAndPledgesQueryKey(),
    }),
    queryClient.invalidateQueries({
      queryKey: getListGiftsAndPaymentsQueryKey(),
    }),
    opportunityId
      ? queryClient.invalidateQueries({
          queryKey: getGetOpportunityOrPledgeQueryKey(opportunityId),
        })
      : Promise.resolve(),
    giftId
      ? queryClient.invalidateQueries({
          queryKey: getGetGiftOrPaymentQueryKey(giftId),
        })
      : Promise.resolve(),
  ]);
}

export function ConvertPledgeToGiftDialog({
  pledgeId,
  open,
  onOpenChange,
  onConverted,
}: {
  pledgeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConverted: (giftId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const convert = useConvertPledgeToStandaloneGift({
    mutation: {
      onSuccess: async (result) => {
        await refreshAll(queryClient, pledgeId, result.giftId);
        onOpenChange(false);
        toast({
          title: "Converted to stand-alone gift",
          description:
            "The surviving gift now reads as though it was originally recorded as a stand-alone gift. Payment and accounting evidence were preserved.",
        });
        onConverted(result.giftId);
      },
      onError: (error: unknown) =>
        toast({
          title: "Pledge cannot be converted",
          description:
            error instanceof Error ? error.message : "Something went wrong.",
          variant: "destructive",
        }),
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !convert.isPending && onOpenChange(next)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Convert pledge and payment to stand-alone gift?
          </DialogTitle>
          <DialogDescription>
            Use only when this was never really a pledge: one payment fully paid
            the amount, and the record should have been a stand-alone gift from
            the beginning. The gift, allocations, documents, activity, and
            payment evidence are preserved. The originating fundraising record
            is rewritten as a completed gift opportunity rather than a pledge.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="convert-pledge-reason">
            Correction reason (optional)
          </Label>
          <Textarea
            id="convert-pledge-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={4}
            placeholder="Explain how the pledge was mischaracterized…"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={convert.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() =>
              convert.mutate({
                id: pledgeId,
                data: { reason: reason.trim() || null },
              })
            }
            disabled={convert.isPending}
            data-testid="button-confirm-convert-pledge-to-gift"
          >
            {convert.isPending ? "Converting…" : "Convert to stand-alone gift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RevertPledgeToVerbalGiftDialog({
  pledgeId,
  open,
  onOpenChange,
  onReverted,
  initialCommitmentDate,
  initialExpectedDate,
}: {
  pledgeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReverted?: () => void;
  initialCommitmentDate?: string | null;
  initialExpectedDate?: string | null;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [commitmentDate, setCommitmentDate] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setCommitmentDate(
      initialCommitmentDate ?? new Date().toISOString().slice(0, 10),
    );
    setExpectedDate(initialExpectedDate ?? "");
    setReason("");
  }, [open, initialCommitmentDate, initialExpectedDate]);

  const revert = useRevertPledgeToVerbalGift({
    mutation: {
      onSuccess: async () => {
        await refreshAll(queryClient, pledgeId);
        onOpenChange(false);
        toast({ title: "Reverted to pending gift opportunity" });
        onReverted?.();
      },
      onError: (error: unknown) =>
        toast({
          title: "Pledge cannot be reverted",
          description:
            error instanceof Error ? error.message : "Something went wrong.",
          variant: "destructive",
        }),
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !revert.isPending && onOpenChange(next)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revert to verbal gift commitment?</DialogTitle>
          <DialogDescription>
            Use when the donor verbally committed to make one stand-alone gift,
            but no payment has arrived and this was incorrectly finalized as a
            pledge. The record returns to the opportunity list awaiting payment.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="revert-verbal-date">Commitment date</Label>
              <Input
                id="revert-verbal-date"
                type="date"
                value={commitmentDate}
                onChange={(event) => setCommitmentDate(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="revert-verbal-expected">
                Expected payment date
              </Label>
              <Input
                id="revert-verbal-expected"
                type="date"
                value={expectedDate}
                onChange={(event) => setExpectedDate(event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="revert-verbal-reason">
              Correction reason (optional)
            </Label>
            <Textarea
              id="revert-verbal-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={revert.isPending}
          >
            Cancel
          </Button>
          <Button
            disabled={!commitmentDate || revert.isPending}
            onClick={() =>
              revert.mutate({
                id: pledgeId,
                data: {
                  commitmentDate,
                  expectedDate: expectedDate || null,
                  reason: reason.trim() || null,
                },
              })
            }
            data-testid="button-confirm-revert-verbal-gift"
          >
            {revert.isPending ? "Reverting…" : "Revert to pending gift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RevertPledgeToOpportunityDialog({
  pledgeId,
  open,
  onOpenChange,
  onReverted,
  initialStage,
  initialProjectedCloseDate,
}: {
  pledgeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReverted?: () => void;
  initialStage?: OpportunityStage | null;
  initialProjectedCloseDate?: string | null;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [stage, setStage] = useState<OpportunityStage>("in_conversation");
  const [projectedCloseDate, setProjectedCloseDate] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setStage(
      initialStage && initialStage !== "verbal_confirmation"
        ? initialStage
        : "in_conversation",
    );
    setProjectedCloseDate(initialProjectedCloseDate ?? "");
    setReason("");
  }, [open, initialProjectedCloseDate, initialStage]);

  const revert = useRevertPledgeToOpportunity({
    mutation: {
      onSuccess: async () => {
        await refreshAll(queryClient, pledgeId);
        onOpenChange(false);
        toast({ title: "Reverted to opportunity" });
        onReverted?.();
      },
      onError: (error: unknown) =>
        toast({
          title: "Pledge cannot be reverted",
          description:
            error instanceof Error ? error.message : "Something went wrong.",
          variant: "destructive",
        }),
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !revert.isPending && onOpenChange(next)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revert to general opportunity?</DialogTitle>
          <DialogDescription>
            Use when the commitment was not actually established. The pledge
            amount returns to an ask amount, the pledge schedule is removed, and
            the record returns to the selected cultivation stage.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Opportunity stage</Label>
            <Select
              value={stage}
              onValueChange={(value) => setStage(value as OpportunityStage)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GENERAL_STAGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="revert-opportunity-close">
              Projected close date (optional)
            </Label>
            <Input
              id="revert-opportunity-close"
              type="date"
              value={projectedCloseDate}
              onChange={(event) => setProjectedCloseDate(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="revert-opportunity-reason">
              Correction reason (optional)
            </Label>
            <Textarea
              id="revert-opportunity-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={revert.isPending}
          >
            Cancel
          </Button>
          <Button
            disabled={revert.isPending}
            onClick={() =>
              revert.mutate({
                id: pledgeId,
                data: {
                  stage,
                  projectedCloseDate: projectedCloseDate || null,
                  reason: reason.trim() || null,
                },
              })
            }
            data-testid="button-confirm-revert-opportunity"
          >
            {revert.isPending ? "Reverting…" : "Revert to opportunity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DetachGiftFromPledgeDialog({
  giftId,
  opportunityId,
  open,
  onOpenChange,
  onDetached,
}: {
  giftId: string;
  opportunityId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDetached?: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const detach = useDetachGiftFromPledge({
    mutation: {
      onSuccess: async () => {
        await refreshAll(queryClient, opportunityId, giftId);
        onOpenChange(false);
        toast({
          title: "Gift detached from pledge",
          description: "The gift and all payment evidence remain intact.",
        });
        onDetached?.();
      },
      onError: (error: unknown) =>
        toast({
          title: "Gift cannot be detached",
          description:
            error instanceof Error ? error.message : "Something went wrong.",
          variant: "destructive",
        }),
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !detach.isPending && onOpenChange(next)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Treat this payment as a stand-alone gift?</DialogTitle>
          <DialogDescription>
            This removes only the gift-to-pledge relationship. It does not alter
            the received payment, amount, date, allocations, intermediary, or
            accounting evidence.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="detach-gift-reason">
            Correction reason (optional)
          </Label>
          <Textarea
            id="detach-gift-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={4}
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={detach.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() =>
              detach.mutate({
                id: giftId,
                data: { reason: reason.trim() || null },
              })
            }
            disabled={detach.isPending}
            data-testid="button-confirm-detach-gift"
          >
            {detach.isPending ? "Detaching…" : "Treat as stand-alone gift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RevertGiftToOpportunityDialog({
  giftId,
  giftName,
  open,
  onOpenChange,
  onReverted,
}: {
  giftId: string;
  giftName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReverted?: (opportunityId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) setName(giftName ?? "");
  }, [giftName, open]);

  const revert = useRevertGiftToOpportunity({
    mutation: {
      onSuccess: async (result) => {
        await refreshAll(queryClient, result.opportunityId, giftId);
        onOpenChange(false);
        toast({
          title: "Gift reverted to opportunity",
          description:
            "The gift was archived because the money did not actually arrive. Its donor, amount, and allocations were carried into the new opportunity.",
        });
        onReverted?.(result.opportunityId);
      },
      onError: (error: unknown) =>
        toast({
          title: "Gift cannot be reverted",
          description:
            error instanceof Error ? error.message : "Something went wrong.",
          variant: "destructive",
        }),
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!revert.isPending) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revert gift to opportunity?</DialogTitle>
          <DialogDescription>
            Use only when this record was created as a gift but the money never
            arrived. This action is unavailable once received payment evidence
            is linked. The gift is archived and a new open opportunity is
            created with the same donor, amount, and allocation plan.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="revert-gift-opportunity-name">Opportunity name</Label>
          <Input
            id="revert-gift-opportunity-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Opportunity name"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={revert.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() =>
              revert.mutate({
                id: giftId,
                data: { asPledge: false, name: name.trim() || null },
              })
            }
            disabled={revert.isPending}
            data-testid="button-confirm-revert-gift-opportunity"
          >
            {revert.isPending ? "Reverting…" : "Revert to opportunity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
