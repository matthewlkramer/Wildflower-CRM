import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetOpportunityOrPledgeQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  useFinalizePledge,
  useRecordVerbalCommitment,
  type OpportunityCommitmentPath,
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
import { useToast } from "@/hooks/use-toast";

const PATH_TITLE: Record<OpportunityCommitmentPath, string> = {
  gift: "Record verbal commitment to make a gift",
  written_pledge: "Record verbal commitment to make a written pledge",
  verbal_pledge: "Set up informal verbal pledge",
};

const PATH_DESCRIPTION: Record<OpportunityCommitmentPath, string> = {
  gift: "This remains an opportunity awaiting actual payment. The gift will be created only when received payment evidence is selected.",
  written_pledge:
    "This remains an opportunity awaiting the pledge document and completed pledge plan. It is not a pledge until finalized.",
  verbal_pledge:
    "Record the informal verbal pledge terms. Complete its amount, allocations, payment plan, and conditions before finalizing it as a pledge.",
};

async function refreshOpportunity(
  queryClient: ReturnType<typeof useQueryClient>,
  id: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: getGetOpportunityOrPledgeQueryKey(id),
    }),
    queryClient.invalidateQueries({
      queryKey: getListOpportunitiesAndPledgesQueryKey(),
    }),
  ]);
}

export function VerbalCommitmentDialog({
  opp,
  path,
  open,
  onOpenChange,
}: {
  opp: OpportunityOrPledgeDetail;
  path: OpportunityCommitmentPath;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [commitmentDate, setCommitmentDate] = useState("");
  const [confirmedAmount, setConfirmedAmount] = useState("");
  const [expectedDate, setExpectedDate] = useState("");

  useEffect(() => {
    if (!open) return;
    setCommitmentDate(
      opp.verbalCommitmentAt ?? new Date().toISOString().slice(0, 10),
    );
    setConfirmedAmount(opp.awardedAmount ?? opp.askAmount ?? "");
    setExpectedDate(opp.projectedCloseDate ?? "");
  }, [
    open,
    opp.awardedAmount,
    opp.askAmount,
    opp.projectedCloseDate,
    opp.verbalCommitmentAt,
  ]);

  const record = useRecordVerbalCommitment({
    mutation: {
      onSuccess: async () => {
        await refreshOpportunity(queryClient, opp.id);
        onOpenChange(false);
        toast({
          title:
            path === "verbal_pledge"
              ? "Informal verbal pledge setup recorded"
              : "Verbal commitment recorded",
        });
      },
      onError: (error: unknown) =>
        toast({
          title: "Could not record commitment",
          description:
            error instanceof Error ? error.message : "Something went wrong.",
          variant: "destructive",
        }),
    },
  });

  const canSubmit =
    !!commitmentDate && Number(confirmedAmount) > 0 && !record.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!record.isPending) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{PATH_TITLE[path]}</DialogTitle>
          <DialogDescription>{PATH_DESCRIPTION[path]}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={`commitment-date-${path}`}>Commitment date</Label>
              <Input
                id={`commitment-date-${path}`}
                type="date"
                value={commitmentDate}
                onChange={(event) => setCommitmentDate(event.target.value)}
                data-testid={`input-commitment-date-${path}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`commitment-amount-${path}`}>
                Confirmed amount
              </Label>
              <Input
                id={`commitment-amount-${path}`}
                type="number"
                min="0.01"
                step="0.01"
                value={confirmedAmount}
                onChange={(event) => setConfirmedAmount(event.target.value)}
                data-testid={`input-commitment-amount-${path}`}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`commitment-expected-${path}`}>
              {path === "gift"
                ? "Expected payment date (optional)"
                : path === "written_pledge"
                  ? "Expected pledge-document date (optional)"
                  : "Expected first-payment or finalization date (optional)"}
            </Label>
            <Input
              id={`commitment-expected-${path}`}
              type="date"
              value={expectedDate}
              onChange={(event) => setExpectedDate(event.target.value)}
              data-testid={`input-commitment-expected-${path}`}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={record.isPending}
          >
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() =>
              record.mutate({
                id: opp.id,
                data: {
                  commitmentPath: path,
                  verbalCommitmentAt: commitmentDate,
                  confirmedAmount,
                  expectedDate: expectedDate || null,
                },
              })
            }
            data-testid={`button-save-commitment-${path}`}
          >
            {record.isPending ? "Saving…" : "Save commitment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FinalizePledgeDialog({
  opp,
  open,
  onOpenChange,
  onFinalized,
}: {
  opp: OpportunityOrPledgeDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFinalized?: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pledgeDate, setPledgeDate] = useState("");

  useEffect(() => {
    if (open) {
      setPledgeDate(
        opp.verbalCommitmentAt ?? new Date().toISOString().slice(0, 10),
      );
    }
  }, [open, opp.verbalCommitmentAt]);

  const finalize = useFinalizePledge({
    mutation: {
      onSuccess: async () => {
        await refreshOpportunity(queryClient, opp.id);
        onOpenChange(false);
        toast({ title: "Pledge finalized" });
        onFinalized?.();
      },
      onError: (error: unknown) =>
        toast({
          title: "Pledge is not ready",
          description:
            error instanceof Error ? error.message : "Something went wrong.",
          variant: "destructive",
        }),
    },
  });

  const written = opp.commitmentPath === "written_pledge";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!finalize.isPending) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Finalize {written ? "written" : "informal verbal"} pledge
          </DialogTitle>
          <DialogDescription>
            The system will verify the committed amount, allocations, payment
            plan, conditions, and {written ? "pledge document" : "pledge terms"}
            .
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="finalize-pledge-date">Pledge commitment date</Label>
          <Input
            id="finalize-pledge-date"
            type="date"
            value={pledgeDate}
            onChange={(event) => setPledgeDate(event.target.value)}
            data-testid="input-finalize-pledge-date"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={finalize.isPending}
          >
            Cancel
          </Button>
          <Button
            disabled={!pledgeDate || finalize.isPending}
            onClick={() =>
              finalize.mutate({
                id: opp.id,
                data: { pledgeCommittedAt: pledgeDate },
              })
            }
            data-testid="button-finalize-pledge"
          >
            {finalize.isPending ? "Checking…" : "Finalize pledge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
