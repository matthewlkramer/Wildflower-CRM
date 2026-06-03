import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Plus } from "lucide-react";
import {
  useCreateGiftOrPayment,
  getListGiftsAndPaymentsQueryKey,
  type CreateGiftOrPaymentBody,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import type { LinkedRecordsScope } from "@/components/linked-records";
import {
  DonorFieldPicker,
  donorBodyFor,
  type DonorType,
} from "@/components/entity-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Maps a donor-scoping object to an initial (type, id) pair for the donor
 * picker. Exactly one of funderId / householdId / individualGiverPersonId is
 * set on the scope, mirroring the donor XOR invariant enforced by the API/DB.
 */
function donorFromScope(scope: LinkedRecordsScope): {
  type: DonorType;
  id: string;
} {
  if ("funderId" in scope) return { type: "funder", id: scope.funderId };
  if ("householdId" in scope) return { type: "household", id: scope.householdId };
  return { type: "individual", id: scope.individualGiverPersonId };
}

export function GiftFormDialog({ scope }: { scope?: LinkedRecordsScope }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [dateReceived, setDateReceived] = useState("");
  const initialDonor = scope ? donorFromScope(scope) : null;
  const [donorType, setDonorType] = useState<DonorType>(
    initialDonor?.type ?? "funder",
  );
  const [donorId, setDonorId] = useState<string | null>(
    initialDonor?.id ?? null,
  );
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  function resetDonor() {
    if (scope) {
      const d = donorFromScope(scope);
      setDonorType(d.type);
      setDonorId(d.id);
    } else {
      setDonorType("funder");
      setDonorId(null);
    }
  }

  // Re-seed the donor from scope each time the dialog opens, so navigating
  // between donor detail pages always pre-fills the right donor.
  const scopeKey = JSON.stringify(scope ?? null);
  useEffect(() => {
    if (open) resetDonor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scopeKey]);

  const create = useCreateGiftOrPayment({
    mutation: {
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({
          queryKey: getListGiftsAndPaymentsQueryKey(),
        });
        toast({ title: "Gift created" });
        setOpen(false);
        setName("");
        setAmount("");
        setDateReceived("");
        resetDonor();
        if (created?.id) navigate(`/gifts/${created.id}`);
      },
      onError: (err: unknown) => {
        toast({
          title: "Create failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const trimmed = name.trim();

  function resetAndClose(next: boolean) {
    if (create.isPending) return;
    setOpen(next);
    if (!next) {
      setName("");
      setAmount("");
      setDateReceived("");
      resetDonor();
    }
  }

  // Label for the trigger button differs by context.
  const triggerLabel = scope ? "Add" : "New gift / payment";

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          data-testid="button-new-gift"
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New gift</DialogTitle>
          <DialogDescription>
            You can fill in the rest of the details after creating it.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!trimmed || !donorId) return;
            const amt = amount.trim();
            const date = dateReceived.trim();
            const donor = donorBodyFor(donorType, donorId);
            create.mutate({
              data: {
                name: trimmed,
                funderId: donor.funderId ?? undefined,
                individualGiverPersonId:
                  donor.individualGiverPersonId ?? undefined,
                householdId: donor.householdId ?? undefined,
                ...(amt ? { amount: amt } : {}),
                ...(date ? { dateReceived: date } : {}),
              },
            });
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-gift-name">Name</Label>
            <Input
              id="new-gift-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
              data-testid="input-new-gift-name"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Donor</Label>
            <DonorFieldPicker
              type={donorType}
              id={donorId}
              onChange={(t, id) => {
                setDonorType(t);
                setDonorId(id);
              }}
              testIdBase="new-gift-donor"
              disabled={create.isPending}
            />
            {scope ? (
              <p className="text-xs text-muted-foreground">
                Defaults to this record; pick a different funder, household, or
                individual to file it elsewhere.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Required — choose the funder, household, or individual this
                payment is from.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-gift-amount">Amount</Label>
            <Input
              id="new-gift-amount"
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Optional"
              data-testid="input-new-gift-amount"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-gift-date">Date received</Label>
            <Input
              id="new-gift-date"
              type="date"
              value={dateReceived}
              onChange={(e) => setDateReceived(e.target.value)}
              data-testid="input-new-gift-date"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => resetAndClose(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!trimmed || !donorId || create.isPending}
              data-testid="button-create-gift"
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
