import { useState } from "react";
import {
  useCreatePledgeExpectedPayment,
  useUpdatePledgeExpectedPayment,
  useDeletePledgeExpectedPayment,
  useCloseAward,
  useReopenAward,
  getGetOpportunityOrPledgeQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  AwardCloseReason,
  type OpportunityOrPledgeDetail,
  type PledgeExpectedPayment,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

/**
 * Planning badge: shown post-win only (planningComplete is present in the
 * detail response for won pledges). Derived server-side — never computed here.
 */
export function PlanningBadge({ opp }: { opp: OpportunityOrPledgeDetail }) {
  if (opp.planningComplete == null) return null;
  if (opp.planningComplete) {
    return (
      <Badge variant="outline" data-testid="badge-planning-complete">
        Planning complete
      </Badge>
    );
  }
  const gaps = opp.planningGaps ?? [];
  return (
    <Badge
      variant="outline"
      className="border-amber-500 text-amber-700 dark:text-amber-400"
      title={gaps.join("; ")}
      data-testid="badge-planning-incomplete"
    >
      Planning incomplete{gaps.length > 0 ? ` (${gaps.length})` : ""}
    </Badge>
  );
}

/**
 * Installment schedule editor (pledge_expected_payments). Fixed commitments
 * are expected to carry a full schedule; cost-reimbursement pledges normally
 * have none (an optional row is allowed when a payment is known imminent).
 * Amount is optional — "date known, amount TBD" is a legal row.
 */
export function InstallmentSchedule({ opp }: { opp: OpportunityOrPledgeDetail }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const rows = opp.expectedPayments ?? [];
  const [editing, setEditing] = useState<PledgeExpectedPayment | "new" | null>(null);
  const [date, setDate] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetOpportunityOrPledgeQueryKey(opp.id) }),
      queryClient.invalidateQueries({ queryKey: getListOpportunitiesAndPledgesQueryKey() }),
    ]);
  };
  const onError = (err: unknown) =>
    toast({
      title: "Could not save installment",
      description: err instanceof Error ? err.message : String(err),
      variant: "destructive",
    });

  const create = useCreatePledgeExpectedPayment({
    mutation: { onSuccess: invalidate, onError },
  });
  const update = useUpdatePledgeExpectedPayment({
    mutation: { onSuccess: invalidate, onError },
  });
  const remove = useDeletePledgeExpectedPayment({
    mutation: { onSuccess: invalidate, onError },
  });

  const openEditor = (row: PledgeExpectedPayment | "new") => {
    if (row === "new") {
      setDate("");
      setAmount("");
      setNotes("");
    } else {
      setDate(row.expectedDate);
      setAmount(row.amount ?? "");
      setNotes(row.notes ?? "");
    }
    setEditing(row);
  };

  const save = async () => {
    if (!date) return;
    const trimmedAmount = amount.trim();
    const trimmedNotes = notes.trim();
    if (editing === "new") {
      await create.mutateAsync({
        data: {
          pledgeOrOpportunityId: opp.id,
          expectedDate: date,
          ...(trimmedAmount ? { amount: trimmedAmount } : {}),
          ...(trimmedNotes ? { notes: trimmedNotes } : {}),
        },
      });
    } else if (editing) {
      await update.mutateAsync({
        id: editing.id,
        data: {
          expectedDate: date,
          amount: trimmedAmount || null,
          notes: trimmedNotes || null,
        },
      });
    }
    setEditing(null);
  };

  const pending = create.isPending || update.isPending || remove.isPending;

  return (
    <div className="space-y-2">
      {rows.length > 0 ? (
        <div className="divide-y">
          {rows.map((row) => (
            <div
              key={row.id}
              className="group flex items-center gap-2 px-2 py-1.5 text-sm"
              data-testid={`row-installment-${row.id}`}
            >
              <span className="w-28 shrink-0">{formatDate(row.expectedDate)}</span>
              <span className="w-28 shrink-0 tabular-nums">
                {row.amount != null ? (
                  formatCurrency(row.amount)
                ) : (
                  <span className="text-muted-foreground">Amount TBD</span>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {row.notes ?? ""}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 opacity-0 group-hover:opacity-100"
                onClick={() => openEditor(row)}
                disabled={pending}
                data-testid={`button-edit-installment-${row.id}`}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 opacity-0 group-hover:opacity-100"
                onClick={() => remove.mutate({ id: row.id })}
                disabled={pending}
                data-testid={`button-delete-installment-${row.id}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-2 py-2 text-sm text-muted-foreground">
          {opp.disbursementModel === "cost_reimbursement"
            ? "No expected payments. Cost-reimbursement pledges usually have none — add one only when a payment is known to be imminent."
            : "No installments scheduled yet."}
        </p>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => openEditor("new")}
        disabled={pending}
        data-testid="button-add-installment"
      >
        <Plus className="mr-1 h-4 w-4" />
        Add installment
      </Button>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing === "new" ? "Add installment" : "Edit installment"}
            </DialogTitle>
            <DialogDescription>
              Expected date is required; amount may be left blank when it is
              not yet known.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="installment-date">Expected date</Label>
              <Input
                id="installment-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                data-testid="input-installment-date"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="installment-amount">Amount (optional)</Label>
              <Input
                id="installment-amount"
                type="number"
                step="0.01"
                min="0"
                placeholder="e.g. 25000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="input-installment-amount"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="installment-notes">Notes (optional)</Label>
              <Input
                id="installment-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                data-testid="input-installment-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={!date || pending}
              data-testid="button-save-installment"
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const CLOSE_REASON_LABELS: Record<keyof typeof AwardCloseReason, string> = {
  fully_collected: "Fully collected",
  award_period_ended: "Award period ended",
  unused_balance: "Unused balance",
  terminated: "Terminated",
};

/**
 * Close-award dialog for cost-reimbursement pledges. Finance-gated: the
 * caller renders the trigger disabled (with a labeled reason) when the
 * viewer lacks the finance/admin role; the endpoint enforces with a 403.
 */
export function CloseAwardDialog({
  opp,
  open,
  onOpenChange,
}: {
  opp: OpportunityOrPledgeDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [closedAt, setClosedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState<keyof typeof AwardCloseReason | "">("");

  const closeAward = useCloseAward({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetOpportunityOrPledgeQueryKey(opp.id) }),
          queryClient.invalidateQueries({ queryKey: getListOpportunitiesAndPledgesQueryKey() }),
        ]);
        toast({ title: "Award closed" });
        onOpenChange(false);
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not close award",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Close award</DialogTitle>
          <DialogDescription>
            Ends this cost-reimbursement award. Requires all projected
            allocations to be resolved (drawn as gifts or reduced) first.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="close-award-date">Closure date</Label>
            <Input
              id="close-award-date"
              type="date"
              value={closedAt}
              onChange={(e) => setClosedAt(e.target.value)}
              data-testid="input-close-award-date"
            />
          </div>
          <div className="space-y-1">
            <Label>Reason</Label>
            <RadioGroup
              value={reason}
              onValueChange={(v) => setReason(v as keyof typeof AwardCloseReason)}
            >
              {(Object.keys(CLOSE_REASON_LABELS) as Array<keyof typeof AwardCloseReason>).map(
                (key) => (
                  <div key={key} className="flex items-center space-x-2">
                    <RadioGroupItem
                      value={key}
                      id={`close-reason-${key}`}
                      data-testid={`radio-close-reason-${key}`}
                    />
                    <Label htmlFor={`close-reason-${key}`} className="font-normal">
                      {CLOSE_REASON_LABELS[key]}
                    </Label>
                  </div>
                ),
              )}
            </RadioGroup>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              reason &&
              closeAward.mutate({ id: opp.id, data: { closedAt, reason } })
            }
            disabled={!closedAt || !reason || closeAward.isPending}
            data-testid="button-confirm-close-award"
          >
            Close award
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function useReopenAwardAction(oppId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useReopenAward({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetOpportunityOrPledgeQueryKey(oppId) }),
          queryClient.invalidateQueries({ queryKey: getListOpportunitiesAndPledgesQueryKey() }),
        ]);
        toast({ title: "Award reopened" });
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not reopen award",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });
}
