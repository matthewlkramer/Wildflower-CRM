import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Plus } from "lucide-react";
import {
  useCreateOpportunityOrPledge,
  getListOpportunitiesAndPledgesQueryKey,
  type CreateOpportunityOrPledgeBody,
  type OpportunityStage,
  type OpportunityType,
  type FundraisingCategory,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { AddIconButton } from "@/components/add-icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const STAGE_OPTIONS: { value: OpportunityStage; label: string }[] = [
  { value: "cold_lead", label: "Cold lead" },
  { value: "warm_lead", label: "Warm lead" },
  { value: "in_conversation", label: "In conversation" },
  { value: "convince", label: "Convince" },
  { value: "probable_renewal", label: "Probable renewal" },
  { value: "verbal_confirmation", label: "Verbal confirmation" },
];

const TYPE_OPTIONS: { value: OpportunityType; label: string }[] = [
  { value: "solicitation", label: "Solicitation" },
  { value: "renewal", label: "Renewal" },
  { value: "open_application", label: "Open application" },
];

/**
 * Maps a donor-scoping object to an initial (type, id) pair for the donor
 * picker. Exactly one of organizationId / householdId / individualGiverPersonId is
 * set on the scope, mirroring the donor XOR invariant enforced by the API/DB.
 */
function donorFromScope(scope: LinkedRecordsScope): {
  type: DonorType;
  id: string;
} {
  if ("organizationId" in scope) return { type: "organization", id: scope.organizationId };
  if ("householdId" in scope)
    return { type: "household", id: scope.householdId };
  return { type: "individual", id: scope.individualGiverPersonId };
}

type FormState = {
  name: string;
  stage: OpportunityStage | "";
  type: OpportunityType | "";
  fundraisingCategory: FundraisingCategory;
  askAmount: string;
  awardedAmount: string;
  projectedCloseDate: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  stage: "",
  type: "",
  fundraisingCategory: "revenue",
  askAmount: "",
  awardedAmount: "",
  projectedCloseDate: "",
};

export function CreateOpportunityDialog({
  scope,
  mode,
}: {
  scope?: LinkedRecordsScope;
  mode: "opportunity" | "pledge";
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const initialDonor = scope ? donorFromScope(scope) : null;
  const [donorType, setDonorType] = useState<DonorType>(
    initialDonor?.type ?? "organization",
  );
  const [donorId, setDonorId] = useState<string | null>(
    initialDonor?.id ?? null,
  );
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isPledge = mode === "pledge";

  function resetDonor() {
    if (scope) {
      const d = donorFromScope(scope);
      setDonorType(d.type);
      setDonorId(d.id);
    } else {
      setDonorType("organization");
      setDonorId(null);
    }
  }

  // Re-seed the donor default from the page scope each time the dialog
  // opens (and if the scope changes while open). The component can stay
  // mounted across donor navigations, so initializing from scope only on
  // mount would leave a stale default — this keeps the donor's own page
  // as the default every launch.
  const scopeKey = JSON.stringify(scope ?? null);
  useEffect(() => {
    if (open) resetDonor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scopeKey]);

  const create = useCreateOpportunityOrPledge({
    mutation: {
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({
          queryKey: getListOpportunitiesAndPledgesQueryKey(),
        });
        toast({ title: isPledge ? "Pledge created" : "Opportunity created" });
        setOpen(false);
        setForm(EMPTY_FORM);
        resetDonor();
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
    if (!next) {
      setForm(EMPTY_FORM);
      resetDonor();
    }
  }

  function submit() {
    if (!trimmedName || !donorId) return;
    const ask = form.askAmount.trim();
    const awarded = form.awardedAmount.trim();
    const closeDate = form.projectedCloseDate.trim();
    const donor = donorBodyFor(donorType, donorId);
    create.mutate({
      data: {
        name: trimmedName,
        organizationId: donor.organizationId ?? undefined,
        individualGiverPersonId: donor.individualGiverPersonId ?? undefined,
        householdId: donor.householdId ?? undefined,
        ...(isPledge ? { writtenPledge: true } : {}),
        ...(form.stage ? { stage: form.stage } : {}),
        ...(form.type ? { type: form.type } : {}),
        fundraisingCategory: form.fundraisingCategory,
        ...(ask ? { askAmount: ask } : {}),
        ...(awarded ? { awardedAmount: awarded } : {}),
        ...(closeDate ? { projectedCloseDate: closeDate } : {}),
      },
    });
  }

  // Trigger differs by context: detail-page linked-record cards keep a compact
  // inline "Add" button; list-page headers use a "+" icon next to the title.
  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogTrigger asChild>
        {scope ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            data-testid={
              isPledge ? "button-new-pledge" : "button-new-opportunity"
            }
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        ) : (
          <AddIconButton
            label={isPledge ? "New pledge" : "New opportunity"}
            data-testid={
              isPledge ? "button-new-pledge" : "button-new-opportunity"
            }
          />
        )}
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

          <div className="space-y-1.5">
            <Label>Donor</Label>
            <DonorFieldPicker
              type={donorType}
              id={donorId}
              onChange={(t, id) => {
                setDonorType(t);
                setDonorId(id);
              }}
              testIdBase="new-opportunity-donor"
              disabled={create.isPending}
            />
            {scope ? (
              <p className="text-xs text-muted-foreground">
                Defaults to this record; pick a different funder, household, or
                individual to file it elsewhere.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Required — choose the funder, household, or individual this is
                for.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Fundraising category</Label>
            <Select
              value={form.fundraisingCategory}
              onValueChange={(v) =>
                setForm({ ...form, fundraisingCategory: v as FundraisingCategory })
              }
            >
              <SelectTrigger data-testid="select-new-opportunity-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="revenue">Revenue / Gifts</SelectItem>
                <SelectItem value="loan_capital">Loan Capital</SelectItem>
              </SelectContent>
            </Select>
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
            <p className="text-xs text-muted-foreground">
              Determines the fiscal year automatically.
            </p>
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
              disabled={!trimmedName || !donorId || create.isPending}
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
