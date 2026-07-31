import { useState } from "react";
import {
  useRecordVerbalCommitment,
  useFinalizePledge,
  getGetOpportunityOrPledgeQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  type OpportunityCommitmentPath,
  type OpportunityOrPledgeDetail,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { RelatedCard } from "@/components/record-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";

const PATH_LABEL: Record<OpportunityCommitmentPath, string> = {
  gift: "Gift",
  written_pledge: "Written pledge",
  verbal_pledge: "Verbal pledge",
};

export function CommitmentLifecycleCard({
  opp,
  onPledgeFinalized,
}: {
  opp: OpportunityOrPledgeDetail;
  onPledgeFinalized?: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [recordOpen, setRecordOpen] = useState(false);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [path, setPath] = useState<OpportunityCommitmentPath>("gift");
  const [commitmentDate, setCommitmentDate] = useState("");
  const [confirmedAmount, setConfirmedAmount] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [pledgeDate, setPledgeDate] = useState("");

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: getGetOpportunityOrPledgeQueryKey(opp.id),
      }),
      queryClient.invalidateQueries({
        queryKey: getListOpportunitiesAndPledgesQueryKey(),
      }),
    ]);
  };

  const record = useRecordVerbalCommitment({
    mutation: {
      onSuccess: async () => {
        await refresh();
        setRecordOpen(false);
        toast({ title: "Verbal commitment recorded" });
      },
      onError: (err: unknown) =>
        toast({
          title: "Could not record commitment",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  const finalize = useFinalizePledge({
    mutation: {
      onSuccess: async () => {
        await refresh();
        setFinalizeOpen(false);
        toast({ title: "Pledge finalized" });
        onPledgeFinalized?.();
      },
      onError: (err: unknown) =>
        toast({
          title: "Pledge is not ready",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  const pendingPledge =
    !opp.pledgeCommittedAt &&
    (opp.commitmentPath === "written_pledge" ||
      opp.commitmentPath === "verbal_pledge");
  const awaitingGift =
    !opp.pledgeCommittedAt &&
    opp.commitmentPath === "gift" &&
    Number(opp.paidAmount ?? 0) <= 0;

  const summary = opp.pledgeCommittedAt
    ? `${PATH_LABEL[opp.commitmentPath as OpportunityCommitmentPath] ?? "Pledge"} finalized ${formatDate(opp.pledgeCommittedAt)}`
    : awaitingGift
      ? "Verbally confirmed gift; waiting for money to arrive."
      : pendingPledge
        ? `${PATH_LABEL[opp.commitmentPath as OpportunityCommitmentPath]} anticipated; finish the pledge requirements below.`
        : Number(opp.paidAmount ?? 0) > 0
          ? "Completed as a gift when the money arrived."
          : "No positive commitment recorded yet.";

  return (
    <>
      <RelatedCard
        title="Commitment lifecycle"
        action={
          opp.pledgeCommittedAt ? undefined : (
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPath(
                    (opp.commitmentPath as OpportunityCommitmentPath | null) ??
                      "gift",
                  );
                  setCommitmentDate(
                    opp.verbalCommitmentAt ??
                      new Date().toISOString().slice(0, 10),
                  );
                  setConfirmedAmount(
                    opp.awardedAmount ?? opp.askAmount ?? "",
                  );
                  setExpectedDate(opp.projectedCloseDate ?? "");
                  setRecordOpen(true);
                }}
              >
                {opp.commitmentPath
                  ? "Edit verbal commitment"
                  : "Record verbal commitment"}
              </Button>
              {pendingPledge ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setPledgeDate(new Date().toISOString().slice(0, 10));
                    setFinalizeOpen(true);
                  }}
                >
                  Finalize pledge
                </Button>
              ) : null}
            </div>
          )
        }
      >
        <div className="space-y-3 px-2 py-1 text-sm">
          <p>{summary}</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <div>
              <div className="text-muted-foreground">Expected path</div>
              <div>
                {opp.commitmentPath
                  ? PATH_LABEL[opp.commitmentPath]
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Verbal confirmation</div>
              <div>{formatDate(opp.verbalCommitmentAt)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Actual outcome</div>
              <div>
                {opp.outcomeType ? (
                  <Badge variant="outline">{formatEnum(opp.outcomeType)}</Badge>
                ) : (
                  "—"
                )}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Confirmed amount</div>
              <div>{formatCurrency(opp.awardedAmount)}</div>
            </div>
          </div>
          {pendingPledge ? (
            <p className="text-xs text-muted-foreground">
              Written pledges require a pledge document. Fixed commitments
              require allocations and an expected-payment schedule totaling the
              confirmed amount. Conditional allocations require condition text.
            </p>
          ) : null}
        </div>
      </RelatedCard>

      <Dialog open={recordOpen} onOpenChange={setRecordOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record verbal commitment</DialogTitle>
            <DialogDescription>
              Record what the donor said will happen. This does not create a
              pledge or gift by itself.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Expected outcome</Label>
              <Select
                value={path}
                onValueChange={(value) =>
                  setPath(value as OpportunityCommitmentPath)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gift">Gift</SelectItem>
                  <SelectItem value="written_pledge">Written pledge</SelectItem>
                  <SelectItem value="verbal_pledge">
                    Informal verbal pledge
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="verbal-commitment-date">
                  Commitment date
                </Label>
                <Input
                  id="verbal-commitment-date"
                  type="date"
                  value={commitmentDate}
                  onChange={(e) => setCommitmentDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="verbal-commitment-amount">
                  Confirmed amount
                </Label>
                <Input
                  id="verbal-commitment-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={confirmedAmount}
                  onChange={(e) => setConfirmedAmount(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="verbal-commitment-expected">
                Expected money or documentation date
              </Label>
              <Input
                id="verbal-commitment-expected"
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRecordOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                !commitmentDate ||
                Number(confirmedAmount) <= 0 ||
                record.isPending
              }
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
            >
              {record.isPending ? "Saving…" : "Record commitment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={finalizeOpen} onOpenChange={setFinalizeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Finalize{" "}
              {opp.commitmentPath === "written_pledge"
                ? "written"
                : "verbal"}{" "}
              pledge
            </DialogTitle>
            <DialogDescription>
              The system will verify the amount, allocations, payment plan,
              pledge document when required, and any allocation conditions.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="pledge-committed-date">
              Pledge commitment date
            </Label>
            <Input
              id="pledge-committed-date"
              type="date"
              value={pledgeDate}
              onChange={(e) => setPledgeDate(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFinalizeOpen(false)}>
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
            >
              {finalize.isPending ? "Checking…" : "Finalize pledge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
