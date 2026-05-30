import { useState } from "react";
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
 * Maps a donor-scoping object to the XOR donor field on the create body.
 * Exactly one of funderId / householdId / individualGiverPersonId is set,
 * mirroring the donor XOR invariant enforced by the API/DB.
 */
function donorFields(scope: LinkedRecordsScope): Partial<CreateGiftOrPaymentBody> {
  if ("funderId" in scope) return { funderId: scope.funderId };
  if ("householdId" in scope) return { householdId: scope.householdId };
  return { individualGiverPersonId: scope.individualGiverPersonId };
}

export function GiftFormDialog({ scope }: { scope: LinkedRecordsScope }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [dateReceived, setDateReceived] = useState("");
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

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

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!create.isPending) setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          data-testid="button-new-gift"
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add
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
            if (!trimmed) return;
            const amt = amount.trim();
            const date = dateReceived.trim();
            create.mutate({
              data: {
                name: trimmed,
                ...donorFields(scope),
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
              onClick={() => setOpen(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!trimmed || create.isPending}
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
