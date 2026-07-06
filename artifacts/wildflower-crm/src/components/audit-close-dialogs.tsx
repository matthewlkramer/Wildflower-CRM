import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/format";
import {
  useResolveGiftOverpay,
  useWriteOffPledge,
  getGetGiftOrPaymentQueryKey,
  getListGiftsAndPaymentsQueryKey,
  getGetOpportunityOrPledgeQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  type GiftOrPaymentDetail,
  type OpportunityOrPledgeDetail,
} from "@workspace/api-client-react";

// Audit-close resolution dialogs. Once a fiscal year closes for audit, the
// gifts and pledges booked in it are frozen (see the freeze guard). These two
// flows resolve amount discrepancies *without* touching the frozen record:
//   • an over-paid gift's surplus is booked as a NEW gift in the open year;
//   • an under-paid pledge's uncollected remainder is written off as a NEW
//     write-off pledge.
// Both amounts are derived server-side; the client only supplies an optional
// note. On success we navigate to the freshly created child record.

/** "Book surplus as a new gift" — resolves a frozen gift's over-payment. */
export function BookSurplusGiftDialog({
  open,
  onOpenChange,
  gift,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gift: GiftOrPaymentDetail;
  onDone?: (giftId: string) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const mut = useResolveGiftOverpay();
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setReason("");
  }, [open]);

  const surplus = gift.auditClose.overpaySurplus;
  const fyLabel = gift.auditClose.frozenFiscalYearLabel;
  const donorName =
    gift.organizationName ||
    gift.individualGiverPersonName ||
    gift.householdName ||
    "this donor";

  const submitting = mut.isPending;

  const handleSubmit = async () => {
    if (submitting) return;
    try {
      const result = await mut.mutateAsync({
        id: gift.id,
        data: { reason: reason.trim() || null },
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: getGetGiftOrPaymentQueryKey(gift.id) }),
        qc.invalidateQueries({ queryKey: getGetGiftOrPaymentQueryKey(result.id) }),
        qc.invalidateQueries({ queryKey: getListGiftsAndPaymentsQueryKey() }),
      ]);
      toast({
        title: "Surplus gift booked",
        description: `Recorded ${formatCurrency(surplus)} of over-payment as a new gift in the current fiscal year.`,
      });
      onOpenChange(false);
      onDone?.(result.id);
    } catch (err) {
      toast({
        title: "Could not book surplus gift",
        description: err instanceof Error ? err.message : "Something went wrong.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (submitting) return;
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Book surplus as a new gift</DialogTitle>
          <DialogDescription>
            This gift received {formatCurrency(surplus)} more than its
            allocations account for, and its fiscal year
            {fyLabel ? ` (${fyLabel})` : ""} is closed for audit. The original
            gift stays frozen, so the surplus is booked as a separate gift for{" "}
            {donorName} in the current open fiscal year. Nothing on the original
            gift changes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Surplus to book</span>
              <span
                className="font-medium tabular-nums"
                data-testid="text-surplus-amount"
              >
                {formatCurrency(surplus)}
              </span>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="surplus-reason">Note (optional)</Label>
            <Textarea
              id="surplus-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Donor paid above the grant amount"
              data-testid="input-surplus-reason"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            data-testid="button-confirm-book-surplus"
          >
            {submitting ? "Booking…" : "Book surplus gift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Write off remainder" — resolves a frozen pledge's uncollected balance. */
export function WriteOffPledgeDialog({
  open,
  onOpenChange,
  opp,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opp: OpportunityOrPledgeDetail;
  onDone?: (pledgeId: string) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const mut = useWriteOffPledge();
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setReason("");
  }, [open]);

  const remainder = opp.auditClose.uncollectedRemainder;
  const fyLabel = opp.auditClose.frozenFiscalYearLabel;
  const donorName =
    opp.organizationName ||
    opp.individualGiverPersonName ||
    opp.householdName ||
    "this donor";

  const submitting = mut.isPending;

  const handleSubmit = async () => {
    if (submitting) return;
    try {
      const result = await mut.mutateAsync({
        id: opp.id,
        data: { reason: reason.trim() || null },
      });
      await Promise.all([
        qc.invalidateQueries({
          queryKey: getGetOpportunityOrPledgeQueryKey(opp.id),
        }),
        qc.invalidateQueries({
          queryKey: getGetOpportunityOrPledgeQueryKey(result.id),
        }),
        qc.invalidateQueries({ queryKey: getListOpportunitiesAndPledgesQueryKey() }),
      ]);
      toast({
        title: "Remainder written off",
        description: `Recorded ${formatCurrency(remainder)} of uncollected pledge as a write-off.`,
      });
      onOpenChange(false);
      onDone?.(result.id);
    } catch (err) {
      toast({
        title: "Could not write off remainder",
        description: err instanceof Error ? err.message : "Something went wrong.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (submitting) return;
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Write off uncollected remainder</DialogTitle>
          <DialogDescription>
            {donorName}&apos;s pledge is short {formatCurrency(remainder)} of what
            was committed, and its fiscal year
            {fyLabel ? ` (${fyLabel})` : ""} is closed for audit. The original
            pledge stays frozen, so the shortfall is recorded as a separate
            write-off pledge. Nothing on the original pledge changes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Remainder to write off</span>
              <span
                className="font-medium tabular-nums"
                data-testid="text-writeoff-amount"
              >
                {formatCurrency(remainder)}
              </span>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="writeoff-reason">Note (optional)</Label>
            <Textarea
              id="writeoff-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Donor unable to fulfill the remaining commitment"
              data-testid="input-writeoff-reason"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            data-testid="button-confirm-write-off"
          >
            {submitting ? "Writing off…" : "Write off remainder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
