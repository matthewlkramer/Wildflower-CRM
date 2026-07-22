import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ChevronDown, Plus } from "lucide-react";
import {
  useCreateGiftOrPayment,
  useCreateOrganization,
  useUpdateOpportunityOrPledge,
  useListOpportunitiesAndPledges,
  useGetPendingStagedMoneyForDonor,
  useListEntities,
  useListFiscalYears,
  useListFundableProjects,
  useListFundraisingCampaigns,
  useListPledgeAllocations,
  getGetPendingStagedMoneyForDonorQueryKey,
  getListGiftsAndPaymentsQueryKey,
  getListOrganizationsQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  getListPledgeAllocationsQueryKey,
  useGetCurrentUser,
  type OpportunityOrPledge,
  type IntendedUsage,
  type RestrictionAxis,
} from "@workspace/api-client-react";
import { Checkbox } from "@/components/ui/checkbox";
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
import { AddIconButton } from "@/components/add-icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { OppCombobox } from "@/components/opp-combobox";

/* ──────────────────────────────────────────────────────────────────────────
   Non-blocking coding capture (Task #585)
   ────────────────────────────────────────────────────────────────────────── */

const NONE = "__none__";

const INTENDED_USAGE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "gen_ops", label: "Gen ops" },
  { value: "growth", label: "Growth" },
  { value: "school_startup", label: "School startup" },
  { value: "teacher_training", label: "Teacher training" },
  { value: "project", label: "Project" },
];

const RESTRICTION_AXIS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "unrestricted", label: "Unrestricted" },
  { value: "donor_restricted", label: "Donor-restricted" },
  { value: "wf_restricted", label: "WF board-designated" },
];

/** Coding fields captured at gift creation, threaded onto the seeded allocation. */
type CodingState = {
  entityId: string;
  grantYear: string;
  intendedUsage: string;
  fundableProjectId: string;
  regionalRestrictionType: string;
  otherRestrictionType: string;
  timeRestrictionType: string;
  sourceRecordUrl: string;
};

const EMPTY_CODING: CodingState = {
  entityId: "",
  grantYear: "",
  intendedUsage: "",
  fundableProjectId: "",
  regionalRestrictionType: "unrestricted",
  otherRestrictionType: "unrestricted",
  timeRestrictionType: "unrestricted",
  sourceRecordUrl: "",
};

/* ──────────────────────────────────────────────────────────────────────────
   Utilities
   ────────────────────────────────────────────────────────────────────────── */

function buildScopeParams(
  scope: LinkedRecordsScope | undefined,
): Record<string, string> {
  if (!scope) return {};
  if ("organizationId" in scope) return { organizationId: scope.organizationId };
  if ("householdId" in scope) return { householdId: scope.householdId };
  return { individualGiverPersonId: scope.individualGiverPersonId };
}

function donorFromScope(scope: LinkedRecordsScope): {
  type: DonorType;
  id: string;
} {
  if ("organizationId" in scope) return { type: "organization", id: scope.organizationId };
  if ("householdId" in scope)
    return { type: "household", id: scope.householdId };
  return { type: "individual", id: scope.individualGiverPersonId };
}

/**
 * Returns a human-readable label for the donor on an opportunity row.
 * Individual donors don't carry a name field in the list projection, so
 * fall back to the ID. The gift-detail page will show the resolved name.
 */
function oppDonorLabel(opp: OpportunityOrPledge): string {
  if (opp.organizationName) return opp.organizationName;
  if (opp.householdName) return opp.householdName;
  if (opp.individualGiverPersonId)
    return `Individual (${opp.individualGiverPersonId})`;
  return "Unknown donor";
}

/**
 * Returns the donor FK fields to forward on the CreateGift body when
 * an opportunity has been selected. Exactly one field will be set.
 */
function oppDonorFields(opp: OpportunityOrPledge): {
  organizationId?: string;
  householdId?: string;
  individualGiverPersonId?: string;
} {
  if (opp.organizationId) return { organizationId: opp.organizationId };
  if (opp.householdId) return { householdId: opp.householdId };
  if (opp.individualGiverPersonId)
    return { individualGiverPersonId: opp.individualGiverPersonId };
  return {};
}

/* ──────────────────────────────────────────────────────────────────────────
   Post-creation follow-up prompt
   ────────────────────────────────────────────────────────────────────────── */

function OppFollowUpDialog({
  opp,
  onDone,
}: {
  opp: { id: string; name: string | null };
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const updateOpp = useUpdateOpportunityOrPledge({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListOpportunitiesAndPledgesQueryKey(),
        });
        onDone();
      },
      onError: (err: unknown) => {
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
        onDone();
      },
    },
  });

  function markWrittenPledge() {
    updateOpp.mutate({ id: opp.id, data: { writtenPledge: true } });
  }

  return (
    <Dialog open onOpenChange={() => onDone()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update the linked opportunity?</DialogTitle>
          <DialogDescription>
            The gift was created and linked to{" "}
            <span className="font-medium">{opp.name ?? opp.id}</span>. The
            payment is now counted toward this opportunity — its status updates
            automatically. Mark it as a written pledge if the funder has made a
            written commitment.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 pt-1">
          <Button
            onClick={markWrittenPledge}
            disabled={updateOpp.isPending}
            data-testid="button-opp-followup-pledge"
          >
            Mark as a written pledge
          </Button>
          <Button
            variant="ghost"
            onClick={onDone}
            disabled={updateOpp.isPending}
            data-testid="button-opp-followup-no-change"
          >
            No change
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Main dialog
   ────────────────────────────────────────────────────────────────────────── */

export function GiftFormDialog({ scope }: { scope?: LinkedRecordsScope }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [dateReceived, setDateReceived] = useState("");
  const [titleReference, setTitleReference] = useState("");
  const [memoDescription, setMemoDescription] = useState("");
  const [campaignSlug, setCampaignSlug] = useState("");

  // Opportunity link
  const [linkedOpp, setLinkedOpp] = useState<OpportunityOrPledge | null>(null);
  // Evidence-only rule: gifts against a pledge are minted from payment
  // evidence (reconciliation) — manual creation is blocked server-side
  // (409 manual_gift_on_pledge_blocked) unless a finance/admin user
  // explicitly claims the off-books exception (money that will never
  // appear in QuickBooks or Stripe).
  const [offBooksException, setOffBooksException] = useState(false);
  const viewerRole = useGetCurrentUser().data?.role;
  const viewerIsFinance = viewerRole === "finance" || viewerRole === "admin";
  // "auto" = donor derived from the linked opp; "manual" = user picks the donor
  const [donorMode, setDonorMode] = useState<"auto" | "manual">("auto");

  // Manual donor picker fields (used when donorMode === "manual")
  const initialDonor = scope ? donorFromScope(scope) : null;
  const [donorType, setDonorType] = useState<DonorType>(
    initialDonor?.type ?? "organization",
  );
  const [donorId, setDonorId] = useState<string | null>(
    initialDonor?.id ?? null,
  );

  // Reimbursable-placeholder guard: a reimbursable grant is a pledge paid as
  // many real 1:1 reimbursement checks, so booking a single gift for the full
  // awarded amount recreates the placeholder that migration 0101 cleaned up.
  // Non-blocking — we only warn.
  const reimbursablePlaceholderWarning = useMemo(() => {
    if (!linkedOpp?.reimbursable) return false;
    const gift = Number(amount.trim());
    const awarded = Number(linkedOpp.awardedAmount ?? "");
    return (
      Number.isFinite(gift) &&
      Number.isFinite(awarded) &&
      awarded > 0 &&
      gift === awarded
    );
  }, [linkedOpp, amount]);

  // Duplicate guard: when the fundraiser hand-picks a donor (no linked opp),
  // surface any reconciliation money (QuickBooks/Stripe) already staged for that
  // donor so they don't double-enter money that's about to be booked.
  const dupGuardActive =
    open && linkedOpp === null && donorMode === "manual" && !!donorId;
  const pendingMoney = useGetPendingStagedMoneyForDonor(
    { donorType, donorId: donorId ?? "" },
    {
      query: {
        enabled: dupGuardActive,
        queryKey: getGetPendingStagedMoneyForDonorQueryKey({
          donorType,
          donorId: donorId ?? "",
        }),
      },
    },
  );
  const pendingCount = dupGuardActive ? (pendingMoney.data?.count ?? 0) : 0;

  // Non-blocking coding capture (Task #585) — folded into a collapsible section.
  const [coding, setCoding] = useState<CodingState>(EMPTY_CODING);
  const [codingOpen, setCodingOpen] = useState(false);
  // Track whether the user has hand-edited coding so opp-prefill never clobbers
  // a deliberate choice.
  const [codingDirty, setCodingDirty] = useState(false);
  function setCode<K extends keyof CodingState>(k: K, v: CodingState[K]) {
    setCodingDirty(true);
    setCoding((c) => ({ ...c, [k]: v }));
  }

  // Follow-up state — set after creation when the linked opp was "open"
  const [followUpOpp, setFollowUpOpp] = useState<{
    id: string;
    name: string | null;
  } | null>(null);
  const [pendingNavGiftId, setPendingNavGiftId] = useState<string | null>(null);

  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // ── Option sources ───────────────────────────────────────────────────────
  const campaignOptions = (useListFundraisingCampaigns().data ?? []).map((c) => ({
    value: c.slug,
    label: c.name,
  }));
  const entityOptions = (useListEntities().data ?? []).map((e) => ({
    value: e.id,
    label: e.name,
  }));
  const fiscalYearOptions = (useListFiscalYears().data ?? [])
    .slice()
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map((fy) => ({ value: fy.id, label: fy.label }));
  const fundableProjectOptions = (useListFundableProjects().data ?? [])
    .filter((p) => p.active || p.id === coding.fundableProjectId)
    .map((p) => ({
      value: p.id,
      label: p.active ? p.name : `${p.name} (retired)`,
    }));

  // ── Prefill coding from the linked opportunity's first pledge allocation ────
  const prefillOppId = open && linkedOpp ? linkedOpp.id : "";
  const oppAllocations = useListPledgeAllocations(
    { pledgeOrOpportunityId: prefillOppId },
    {
      query: {
        enabled: !!prefillOppId,
        queryKey: getListPledgeAllocationsQueryKey({
          pledgeOrOpportunityId: prefillOppId,
        }),
      },
    },
  );
  const firstOppAlloc = oppAllocations.data?.data?.[0] ?? null;
  useEffect(() => {
    // Only prefill when the user hasn't touched coding yet — never overwrite an
    // explicit choice. Capture is a convenience, not a source of truth.
    if (!firstOppAlloc || codingDirty) return;
    setCoding((c) => ({
      ...c,
      entityId: firstOppAlloc.entityId ?? c.entityId,
      grantYear: firstOppAlloc.grantYear ?? c.grantYear,
      intendedUsage: firstOppAlloc.intendedUsage ?? c.intendedUsage,
      fundableProjectId: firstOppAlloc.fundableProjectId ?? c.fundableProjectId,
      regionalRestrictionType:
        firstOppAlloc.regionalRestrictionType ?? c.regionalRestrictionType,
      otherRestrictionType:
        firstOppAlloc.otherRestrictionType ?? c.otherRestrictionType,
      timeRestrictionType:
        firstOppAlloc.timeRestrictionType ?? c.timeRestrictionType,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstOppAlloc?.id, codingDirty]);

  const scopeParams = useMemo(
    () => buildScopeParams(scope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(scope ?? null)],
  );

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

  function resetCoding() {
    setCoding(EMPTY_CODING);
    setCodingOpen(false);
    setCodingDirty(false);
  }

  function resetForm() {
    setName("");
    setAmount("");
    setDateReceived("");
    setTitleReference("");
    setMemoDescription("");
    setCampaignSlug("");
    setLinkedOpp(null);
    setOffBooksException(false);
    setDonorMode("auto");
    resetDonor();
    resetCoding();
  }

  // Re-seed donor + opp state each time the dialog opens
  const scopeKey = JSON.stringify(scope ?? null);
  useEffect(() => {
    if (open) {
      resetDonor();
      setLinkedOpp(null);
      setOffBooksException(false);
      setDonorMode("auto");
      resetCoding();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scopeKey]);

  // ── Inline funder creation ────────────────────────────────────────────────

  const createFunder = useCreateOrganization({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListOrganizationsQueryKey(),
        });
      },
      onError: (err: unknown) => {
        toast({
          title: "Create organization failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const onCreateOrganization = async (
    organizationName: string,
  ): Promise<string | null> => {
    return new Promise((resolve) => {
      createFunder.mutate(
        { data: { name: organizationName } },
        {
          onSuccess: (created) => resolve(created?.id ?? null),
          onError: () => resolve(null),
        },
      );
    });
  };

  // ── Gift creation ─────────────────────────────────────────────────────────

  const create = useCreateGiftOrPayment({
    mutation: {
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({
          queryKey: getListGiftsAndPaymentsQueryKey(),
        });
        toast({ title: "Gift created" });
        const giftId = created?.id ?? null;
        // If the linked opportunity was still "open", prompt the user to
        // advance its stage before navigating to the new gift.
        if (giftId && linkedOpp && linkedOpp.status === "open") {
          setOpen(false);
          const oppSnap = { id: linkedOpp.id, name: linkedOpp.name ?? null };
          resetForm();
          setPendingNavGiftId(giftId);
          setFollowUpOpp(oppSnap);
        } else {
          setOpen(false);
          resetForm();
          if (giftId) navigate(`/gifts/${giftId}`);
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

  // ── Validation ────────────────────────────────────────────────────────────

  const trimmed = name.trim();

  function canSubmit(): boolean {
    if (!trimmed) return false;
    if (linkedOpp !== null) {
      // Evidence-only rule: manual gifts on a pledge require the finance
      // off-books exception (the server 409s otherwise).
      if (!offBooksException || !viewerIsFinance) return false;
      const d = oppDonorFields(linkedOpp);
      return !!(d.organizationId || d.householdId || d.individualGiverPersonId);
    }
    if (donorMode === "manual") return !!donorId;
    return false;
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || !canSubmit()) return;
    const amt = amount.trim();
    const date = dateReceived.trim();

    let donorFields: {
      organizationId?: string;
      householdId?: string;
      individualGiverPersonId?: string;
    };

    if (linkedOpp !== null) {
      donorFields = oppDonorFields(linkedOpp);
    } else {
      const body = donorBodyFor(donorType, donorId);
      donorFields = {
        ...(body.organizationId != null ? { organizationId: body.organizationId } : {}),
        ...(body.householdId != null ? { householdId: body.householdId } : {}),
        ...(body.individualGiverPersonId != null
          ? { individualGiverPersonId: body.individualGiverPersonId }
          : {}),
      };
    }

    // Non-blocking coding capture — only send fields the human actually set.
    const srcUrl = coding.sourceRecordUrl.trim();
    const codingFields = {
      ...(coding.entityId ? { entityId: coding.entityId } : {}),
      ...(coding.grantYear ? { grantYear: coding.grantYear } : {}),
      ...(coding.intendedUsage
        ? { intendedUsage: coding.intendedUsage as IntendedUsage }
        : {}),
      ...(coding.intendedUsage === "project" && coding.fundableProjectId
        ? { fundableProjectId: coding.fundableProjectId }
        : {}),
      ...(coding.regionalRestrictionType !== "unrestricted"
        ? { regionalRestrictionType: coding.regionalRestrictionType as RestrictionAxis }
        : {}),
      ...(coding.otherRestrictionType !== "unrestricted"
        ? { otherRestrictionType: coding.otherRestrictionType as RestrictionAxis }
        : {}),
      ...(coding.timeRestrictionType !== "unrestricted"
        ? { timeRestrictionType: coding.timeRestrictionType as RestrictionAxis }
        : {}),
      ...(srcUrl ? { sourceRecordUrl: srcUrl } : {}),
    };

    create.mutate({
      data: {
        name: trimmed,
        ...donorFields,
        ...(linkedOpp ? { opportunityId: linkedOpp.id, offBooksException: true } : {}),
        ...(amt ? { amount: amt } : {}),
        ...(date ? { dateReceived: date } : {}),
        ...(titleReference.trim() ? { titleReference: titleReference.trim() } : {}),
        ...(memoDescription.trim()
          ? { memoDescription: memoDescription.trim() }
          : {}),
        ...(campaignSlug ? { campaignSlug } : {}),
        ...codingFields,
      },
    });
  }

  function resetAndClose(next: boolean) {
    if (create.isPending) return;
    setOpen(next);
    if (!next) resetForm();
  }


  return (
    <>
      {/* Follow-up prompt rendered outside the main dialog so both can coexist */}
      {followUpOpp && pendingNavGiftId ? (
        <OppFollowUpDialog
          opp={followUpOpp}
          onDone={() => {
            const giftId = pendingNavGiftId;
            setFollowUpOpp(null);
            setPendingNavGiftId(null);
            if (giftId) navigate(`/gifts/${giftId}`);
          }}
        />
      ) : null}

      <Dialog open={open} onOpenChange={resetAndClose}>
        <DialogTrigger asChild>
          {scope ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              data-testid="button-new-gift"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add
            </Button>
          ) : (
            <AddIconButton
              label="New gift / payment"
              data-testid="button-new-gift"
            />
          )}
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New gift</DialogTitle>
            <DialogDescription>
              You can fill in the rest of the details after creating it.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3">

            {/* ── Step 1: Link to an opportunity or pledge ── */}
            <div className="space-y-1.5">
              <Label>Linked opportunity or pledge</Label>
              <OppCombobox
                scopeParams={scopeParams}
                selected={linkedOpp}
                onSelect={(opp) => {
                  setLinkedOpp(opp);
                  setDonorMode("auto");
                }}
                onSkip={() => {
                  setLinkedOpp(null);
                  setDonorMode("manual");
                }}
                disabled={create.isPending}
              />
              <p className="text-xs text-muted-foreground">
                Optional — link to an existing opportunity or pledge, or
                choose &ldquo;No linked opportunity&rdquo; to pick a donor
                directly.
              </p>
              {linkedOpp !== null ? (
                <div
                  className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
                  data-testid="notice-evidence-only"
                >
                  <p>
                    Gifts against a pledge are created from payment evidence in
                    the reconciliation workbench, not entered by hand. The only
                    exception is off-books money that will never appear in
                    QuickBooks or Stripe.
                  </p>
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="off-books-exception"
                      checked={offBooksException}
                      disabled={!viewerIsFinance || create.isPending}
                      onCheckedChange={(v) => setOffBooksException(v === true)}
                      data-testid="checkbox-off-books-exception"
                    />
                    <Label
                      htmlFor="off-books-exception"
                      className={`text-xs font-normal ${!viewerIsFinance ? "text-muted-foreground" : ""}`}
                    >
                      This is off-books money (no QuickBooks/Stripe record will
                      ever exist)
                      {!viewerIsFinance ? " — finance role required" : ""}
                    </Label>
                  </div>
                </div>
              ) : null}
            </div>

            {/* ── Step 2: Donor — read-only chip or manual picker ── */}
            {linkedOpp !== null ? (
              <div className="space-y-1.5">
                <Label>Donor</Label>
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <span>{oppDonorLabel(linkedOpp)}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    (from linked record)
                  </span>
                </div>
              </div>
            ) : donorMode === "manual" ? (
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
                  onCreateOrganization={onCreateOrganization}
                />
                {scope ? (
                  <p className="text-xs text-muted-foreground">
                    Defaults to this record; pick a different organization,
                    household, or individual to file it elsewhere.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Required — choose the organization, household, or individual
                    this payment is from.
                  </p>
                )}
                {pendingCount > 0 ? (
                  <div
                    className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                    data-testid="warning-pending-staged-money"
                  >
                    <p className="font-medium">
                      {pendingCount} pending payment
                      {pendingCount === 1 ? "" : "s"} for this donor are awaiting
                      reconciliation.
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {(pendingMoney.data?.items ?? []).map((it, i) => (
                        <li key={i} className="flex justify-between gap-2">
                          <span className="truncate">
                            {it.payerName || "—"}
                            <span className="ml-1 uppercase text-amber-700/70">
                              {it.source}
                            </span>
                          </span>
                          <span className="whitespace-nowrap tabular-nums">
                            {it.amount ? `$${it.amount}` : "—"}
                            {it.dateReceived ? ` · ${it.dateReceived}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1 text-amber-700">
                      This money may already be on its way in via Finance
                      Reconciliation — only enter a new gift if it's separate.
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* ── Gift details ── */}
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
              {reimbursablePlaceholderWarning ? (
                <p
                  className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
                  data-testid="warning-reimbursable-placeholder"
                >
                  This is a <strong>reimbursable grant</strong> — a pledge paid
                  as individual reimbursement checks. Booking one gift for the
                  full awarded amount creates a placeholder, not real money.
                  Record each actual QuickBooks/Stripe check as its own payment
                  instead.
                </p>
              ) : null}
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
            <div className="space-y-1.5">
              <Label htmlFor="new-gift-title-reference">Title / reference</Label>
              <Input
                id="new-gift-title-reference"
                value={titleReference}
                onChange={(e) => setTitleReference(e.target.value)}
                placeholder="Optional — e.g. grant name or check number"
                data-testid="input-new-gift-title-reference"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-gift-memo">Memo / description</Label>
              <Input
                id="new-gift-memo"
                value={memoDescription}
                onChange={(e) => setMemoDescription(e.target.value)}
                placeholder="Optional — short memo for the finance report"
                data-testid="input-new-gift-memo"
              />
            </div>
            {campaignOptions.length > 0 ? (
              <div className="space-y-1.5">
                <Label>Campaign</Label>
                <Select
                  value={campaignSlug || NONE}
                  onValueChange={(v) => setCampaignSlug(v === NONE ? "" : v)}
                >
                  <SelectTrigger
                    className="h-8 text-sm"
                    data-testid="select-new-gift-campaign"
                  >
                    <SelectValue placeholder="— None —" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value={NONE}>— None —</SelectItem>
                    {campaignOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {/* ── Coding capture (optional, non-blocking) ── */}
            <Collapsible open={codingOpen} onOpenChange={setCodingOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="px-1 text-muted-foreground"
                  data-testid="button-gift-coding"
                >
                  <ChevronDown
                    className={`mr-1 h-4 w-4 transition-transform ${codingOpen ? "rotate-180" : ""}`}
                  />
                  Coding for QuickBooks (optional)
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-2">
                <p className="text-xs text-muted-foreground">
                  Capture what you know now — entity, fiscal year, restriction,
                  and intended usage. Anything left blank lands the gift in the
                  Incomplete gift record queue to finish later. Nothing here
                  blocks creating the gift.
                </p>

                <div className="space-y-1.5">
                  <Label>Fund entity</Label>
                  <Select
                    value={coding.entityId || NONE}
                    onValueChange={(v) => setCode("entityId", v === NONE ? "" : v)}
                  >
                    <SelectTrigger className="h-8 text-sm" data-testid="select-gift-entity">
                      <SelectValue placeholder="— None —" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value={NONE}>— None —</SelectItem>
                      {entityOptions.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>Fiscal year</Label>
                  <Select
                    value={coding.grantYear || NONE}
                    onValueChange={(v) => setCode("grantYear", v === NONE ? "" : v)}
                  >
                    <SelectTrigger className="h-8 text-sm" data-testid="select-gift-fy">
                      <SelectValue placeholder="— From gift date —" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value={NONE}>— From gift date —</SelectItem>
                      {fiscalYearOptions.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>Intended usage</Label>
                  <Select
                    value={coding.intendedUsage || NONE}
                    onValueChange={(v) =>
                      setCode("intendedUsage", v === NONE ? "" : v)
                    }
                  >
                    <SelectTrigger className="h-8 text-sm" data-testid="select-gift-usage">
                      <SelectValue placeholder="— None —" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value={NONE}>— None —</SelectItem>
                      {INTENDED_USAGE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {coding.intendedUsage === "project" ? (
                  <div className="space-y-1.5">
                    <Label>Fundable project</Label>
                    <Select
                      value={coding.fundableProjectId || NONE}
                      onValueChange={(v) =>
                        setCode("fundableProjectId", v === NONE ? "" : v)
                      }
                    >
                      <SelectTrigger
                        className="h-8 text-sm"
                        data-testid="select-gift-project"
                      >
                        <SelectValue placeholder="— None —" />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        <SelectItem value={NONE}>— None —</SelectItem>
                        {fundableProjectOptions.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}

                <div className="space-y-3 rounded-md border border-border/60 p-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    Restriction
                  </p>
                  {(
                    [
                      ["regionalRestrictionType", "Regional"],
                      ["otherRestrictionType", "Other restriction"],
                      ["timeRestrictionType", "Time"],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key} className="space-y-1.5">
                      <Label>{label}</Label>
                      <Select
                        value={coding[key] || "unrestricted"}
                        onValueChange={(v) => setCode(key, v)}
                      >
                        <SelectTrigger
                          className="h-8 text-sm"
                          data-testid={`select-gift-${key}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="max-h-72">
                          {RESTRICTION_AXIS_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                  <div className="space-y-1.5">
                    <Label htmlFor="new-gift-source-url">Source record link</Label>
                    <Input
                      id="new-gift-source-url"
                      type="url"
                      value={coding.sourceRecordUrl}
                      onChange={(e) => setCode("sourceRecordUrl", e.target.value)}
                      placeholder="e.g. Donorbox donation URL"
                      data-testid="input-gift-source-url"
                    />
                    <p className="text-xs text-muted-foreground">
                      For a donor-restricted gift, provide either a grant letter
                      (upload it on the gift after creating) or a link to the
                      online source record here.
                    </p>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

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
                disabled={!canSubmit() || create.isPending}
                data-testid="button-create-gift"
              >
                {create.isPending ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
