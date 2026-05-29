import { useState } from "react";
import { useLocation } from "wouter";
import {
  useCreateOpportunityOrPledge,
  getListOpportunitiesAndPledgesQueryKey,
  type CreateOpportunityOrPledgeBody,
  type OpportunityStage,
  type OpportunityType,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const STAGE_OPTIONS: { value: OpportunityStage; label: string }[] = [
  { value: "cold_lead", label: "Cold lead" },
  { value: "warm_lead", label: "Warm lead" },
  { value: "in_conversation", label: "In conversation" },
  { value: "convince", label: "Convince" },
  { value: "conditional_commitment", label: "Conditional commitment" },
  { value: "probable_renewal", label: "Probable renewal" },
  { value: "verbal_commitment", label: "Verbal commitment" },
  { value: "written_commitment", label: "Written commitment" },
  { value: "cash_in", label: "Cash in" },
];

const TYPE_OPTIONS: { value: OpportunityType; label: string }[] = [
  { value: "solicitation", label: "Solicitation" },
  { value: "renewal", label: "Renewal" },
  { value: "open_application", label: "Open application" },
];

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

type FormState = {
  name: string;
  stage: OpportunityStage | "";
  type: OpportunityType | "";
  askAmount: string;
  awardedAmount: string;
  projectedCloseDate: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  stage: "",
  type: "",
  askAmount: "",
  awardedAmount: "",
  projectedCloseDate: "",
};

export function CreateOpportunityDialog({
  scope,
  mode,
}: {
  scope: LinkedRecordsScope;
  mode: "opportunity" | "pledge";
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
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
        setForm(EMPTY_FORM);
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

  const trimmedName = form.name.trim();

  function resetAndClose(next: boolean) {
    if (create.isPending) return;
    setOpen(next);
    if (!next) setForm(EMPTY_FORM);
  }

  function submit() {
    if (!trimmedName) return;
    const ask = form.askAmount.trim();
    const awarded = form.awardedAmount.trim();
    const closeDate = form.projectedCloseDate.trim();
    create.mutate({
      data: {
        name: trimmedName,
        ...donorFields(scope),
        ...(isPledge ? { wasPledge: true } : {}),
        ...(form.stage ? { stage: form.stage } : {}),
        ...(form.type ? { type: form.type } : {}),
        ...(ask ? { askAmount: ask } : {}),
        ...(awarded ? { awardedAmount: awarded } : {}),
        ...(closeDate ? { projectedCloseDate: closeDate } : {}),
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
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
            Fill in the main details now — you can edit everything else after
            creating it.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-opportunity-name">Name</Label>
            <Input
              id="new-opportunity-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              autoFocus
              required
              data-testid="input-new-opportunity-name"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Stage</Label>
              <Select
                value={form.stage || "__none__"}
                onValueChange={(v) =>
                  setForm({
                    ...form,
                    stage: v === "__none__" ? "" : (v as OpportunityStage),
                  })
                }
              >
                <SelectTrigger data-testid="select-new-opportunity-stage">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">—</SelectItem>
                  {STAGE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={form.type || "__none__"}
                onValueChange={(v) =>
                  setForm({
                    ...form,
                    type: v === "__none__" ? "" : (v as OpportunityType),
                  })
                }
              >
                <SelectTrigger data-testid="select-new-opportunity-type">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">—</SelectItem>
                  {TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-opportunity-ask">Ask amount</Label>
              <Input
                id="new-opportunity-ask"
                type="number"
                step="0.01"
                min="0"
                value={form.askAmount}
                onChange={(e) => setForm({ ...form, askAmount: e.target.value })}
                placeholder="Optional"
                data-testid="input-new-opportunity-ask"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-opportunity-awarded">Awarded amount</Label>
              <Input
                id="new-opportunity-awarded"
                type="number"
                step="0.01"
                min="0"
                value={form.awardedAmount}
                onChange={(e) =>
                  setForm({ ...form, awardedAmount: e.target.value })
                }
                placeholder="Optional"
                data-testid="input-new-opportunity-awarded"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-opportunity-close">Projected close date</Label>
            <Input
              id="new-opportunity-close"
              type="date"
              value={form.projectedCloseDate}
              onChange={(e) =>
                setForm({ ...form, projectedCloseDate: e.target.value })
              }
              data-testid="input-new-opportunity-close"
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
              disabled={!trimmedName || create.isPending}
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
