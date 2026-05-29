import { useState } from "react";
import { useLocation } from "wouter";
import {
  useCreateOpportunityOrPledge,
  getListOpportunitiesAndPledgesQueryKey,
  type CreateOpportunityOrPledgeBody,
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
function donorFields(scope: LinkedRecordsScope): Partial<CreateOpportunityOrPledgeBody> {
  if ("funderId" in scope) return { funderId: scope.funderId };
  if ("householdId" in scope) return { householdId: scope.householdId };
  return { individualGiverPersonId: scope.individualGiverPersonId };
}

export function CreateOpportunityDialog({
  scope,
  mode,
}: {
  scope: LinkedRecordsScope;
  mode: "opportunity" | "pledge";
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isPledge = mode === "pledge";

  const create = useCreateOpportunityOrPledge({
    mutation: {
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({
          queryKey: getListOpportunitiesAndPledgesQueryKey(),
        });
        toast({ title: isPledge ? "Pledge created" : "Opportunity created" });
        setOpen(false);
        setName("");
        if (created?.id) {
          navigate(
            isPledge ? `/pledges/${created.id}` : `/opportunities/${created.id}`,
          );
        }
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
          variant="outline"
          data-testid={isPledge ? "button-new-pledge" : "button-new-opportunity"}
        >
          {isPledge ? "New pledge" : "New opportunity"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isPledge ? "New pledge" : "New opportunity"}</DialogTitle>
          <DialogDescription>
            You can fill in the rest of the details after creating it.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!trimmed) return;
            create.mutate({
              data: {
                name: trimmed,
                ...donorFields(scope),
                ...(isPledge ? { wasPledge: true } : {}),
              },
            });
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-opportunity-name">Name</Label>
            <Input
              id="new-opportunity-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
              data-testid="input-new-opportunity-name"
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
              data-testid="button-create-opportunity"
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
