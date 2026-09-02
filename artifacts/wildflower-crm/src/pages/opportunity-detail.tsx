import { useState, type ReactNode } from "react";
import { DetailSkeleton } from "@/components/ui/skeleton";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetOpportunityOrPledge,
  useUpdateOpportunityOrPledge,
  useArchiveOpportunityOrPledge,
  useUnarchiveOpportunityOrPledge,
  useGetOrganization,
  useGetHousehold,
  getGetOpportunityOrPledgeQueryKey,
  getGetOrganizationQueryKey,
  getGetHouseholdQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  type OpportunityOrPledgeDetail,
  type UpdateOpportunityOrPledgeBody,
  type OpportunityStage,
  type OpportunityStatus,
  type OpportunityLossType,
  type OpportunityCommitmentPath,
  type OpportunityType,
  type OpportunityConditional,
  type OpportunityConditionsMet,
  type LoanOrGrant,
  type PeopleEntityRole,
  type DisbursementModel,
  useGetCurrentUser,
} from "@workspace/api-client-react";
import {
  PlanningBadge,
  InstallmentSchedule,
  CloseAwardDialog,
  useReopenAwardAction,
} from "@/components/pledge-payment-plan";
import { PledgeAllocationsEditor } from "@/components/allocation-editors";
import { UnifiedActivityFeed } from "@/components/unified-activity-feed";
import { TasksPanel } from "@/components/tasks-panel";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { FlagForResearchDialog } from "@/components/flag-for-research-dialog";
import { EditPeopleEntityRoleDialog } from "@/components/add-role-dialogs";
import { FileUploadField } from "@/components/grant-letter-upload";
import { ReportingDeadlinesDialog } from "@/components/reporting-deadlines-dialog";
import { CommitmentLifecycleCard } from "@/components/commitment-lifecycle-card";
import {
  FinalizePledgeDialog,
  VerbalCommitmentDialog,
} from "@/components/commitment-action-dialogs";
import { PaymentEvidencePickerDialog } from "@/components/payment-evidence-picker-dialog";
import {
  ConvertPledgeToGiftDialog,
  RevertPledgeToOpportunityDialog,
  RevertPledgeToVerbalGiftDialog,
} from "@/components/fundraising-correction-dialogs";
import { WriteOffPledgeDialog } from "@/components/audit-close-dialogs";
import {
  InlineEditBoolean,
  InlineEditDate,
  InlineEditSelect,
  InlineEditText,
  InlineEditTextarea,
  EditTriggerRow,
  ActionButtons,
  useSaveRunner,
  type InlineSelectOption,
  type SaveResult,
} from "@/components/inline-edit";
import { InlineEditUserPicker, useUserNameMap } from "@/components/user-picker";
import {
  InlineEditPersonPicker,
  InlineEditDonor,
  usePersonName,
  useOrganizationName,
  useHouseholdName,
  type DonorSaveBody,
} from "@/components/entity-picker";
import {
  RecordLayout,
  FieldCard,
  RelatedCard,
  RelatedRow,
  AffiliationRow,
  HideInactiveToggle,
  type Highlight,
} from "@/components/record-layout";
import { useQueryClient } from "@tanstack/react-query";
import {
  formatCurrency,
  formatDate,
  formatEnum,
  formatPercent,
} from "@/lib/format";
import { opportunityStatusLabel } from "@/lib/opportunity-status";
import { useToast } from "@/hooks/use-toast";

const STAGE_OPTIONS = [
  { value: "cold_lead", label: "Cold lead" },
  { value: "warm_lead", label: "Warm lead" },
  { value: "in_conversation", label: "In conversation" },
  { value: "convince", label: "Convince" },
  { value: "probable_renewal", label: "Probable renewal" },
  { value: "verbal_confirmation", label: "Verbal confirmation" },
] as const satisfies ReadonlyArray<InlineSelectOption<OpportunityStage>>;

const TYPE_OPTIONS = [
  { value: "solicitation", label: "Solicitation" },
  { value: "renewal", label: "Renewal" },
  { value: "open_application", label: "Open application" },
] as const satisfies ReadonlyArray<InlineSelectOption<OpportunityType>>;

// Loan-fund capital is a fundraising track parallel to revenue; the two are
// never mixed in analytics. Defaults to grant (revenue) for all records.
const CATEGORY_OPTIONS = [
  { value: "grant", label: "Revenue / Gifts" },
  { value: "loan", label: "Loan Capital" },
] as const satisfies ReadonlyArray<InlineSelectOption<LoanOrGrant>>;

// How the funder disburses the award. Fixed commitments carry an installment
// schedule; cost reimbursements are drawn down as expenses are incurred and
// close via the explicit (finance-permitted) Close-award action.
const DISBURSEMENT_MODEL_OPTIONS = [
  { value: "fixed_commitment", label: "Fixed commitment" },
  { value: "cost_reimbursement", label: "Cost reimbursement" },
] as const satisfies ReadonlyArray<InlineSelectOption<DisbursementModel>>;

const AWARD_CLOSE_REASON_LABELS: Record<string, string> = {
  fully_collected: "Fully collected",
  award_period_ended: "Award period ended",
  unused_balance: "Unused balance",
  terminated: "Terminated",
};

const CONDITIONS_MET_LABELS: Record<OpportunityConditionsMet, string> = {
  no: "No",
  partial: "Partial",
  yes: "Yes",
};
import { Badge } from "@/components/ui/badge";
import { NeedsResearchBadge } from "@/components/needs-research-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { Input } from "@/components/ui/input";
import { DerivedRow } from "@/components/derived-row";

type Props = {
  routePattern?: string;
  backHref?: string;
  backLabel?: string;
  entityLabel?: string;
};

export default function OpportunityDetail({
  routePattern = "/opportunities/:id",
  backHref = "/opportunities",
  backLabel = "← Back to opportunities",
  entityLabel = "Opportunity",
}: Props) {
  const [, params] = useRoute<{ id: string }>(routePattern);
  const id = params?.id ?? "";
  const { data, isLoading, isError, error } = useGetOpportunityOrPledge(id, {
    query: { queryKey: getGetOpportunityOrPledgeQueryKey(id), enabled: !!id },
  });

  if (isLoading) return <DetailSkeleton />;
  if (isError || !data) {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="text-sm text-primary hover:underline">
          {backLabel}
        </Link>
        <div className="text-sm text-destructive">
          {error instanceof Error ? error.message : `${entityLabel} not found.`}
        </div>
      </div>
    );
  }
  return <OppView opp={data} />;
}

function OppView({ opp }: { opp: OpportunityOrPledgeDetail }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const isPledge = !!opp.pledgeCommittedAt;
  const recordLabel = isPledge ? "Pledge" : "Opportunity";
  const recordBackHref = isPledge ? "/pledges" : "/opportunities";
  const recordBackLabel = isPledge
    ? "Back to pledges"
    : "Back to opportunities";
  const [reportingDialogOpen, setReportingDialogOpen] = useState(false);
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [flagResearchOpen, setFlagResearchOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [closeAwardOpen, setCloseAwardOpen] = useState(false);
  const [paymentPickerOpen, setPaymentPickerOpen] = useState(false);
  const [commitmentPathOpen, setCommitmentPathOpen] =
    useState<OpportunityCommitmentPath | null>(null);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [convertToGiftOpen, setConvertToGiftOpen] = useState(false);
  const [revertVerbalGiftOpen, setRevertVerbalGiftOpen] = useState(false);
  const [revertOpportunityOpen, setRevertOpportunityOpen] = useState(false);
  // Non-null while the "mark dormant/lost" close-date prompt is open.
  const [closingLossType, setClosingLossType] =
    useState<OpportunityLossType | null>(null);
  const [closeDateValue, setCloseDateValue] = useState("");
  const [closeReasonValue, setCloseReasonValue] = useState("");

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(opp.name ?? "");

  const update = useUpdateOpportunityOrPledge({
    mutation: {
      onSuccess: async (response) => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getGetOpportunityOrPledgeQueryKey(opp.id),
          }),
          queryClient.invalidateQueries({
            queryKey: getListOpportunitiesAndPledgesQueryKey(),
          }),
        ]);
        toast({ title: `${recordLabel} updated` });
        // The server sets `promptForReportingDeadlines` on the PATCH
        // response only when status flipped into pledge/cash_in AND
        // there are zero existing reporting_deadline tasks on this opp.
        // Treat the flag as transient — opening the dialog is the
        // entire UX; ignored if the user dismisses.
        const prompt = response?.promptForReportingDeadlines;
        if (prompt) setReportingDialogOpen(true);
      },
      onError: (err: unknown) => {
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const archive = useArchiveOpportunityOrPledge({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListOpportunitiesAndPledgesQueryKey(),
        });
        toast({ title: `${recordLabel} archived` });
        navigate(recordBackHref);
      },
      onError: (err: unknown) => {
        toast({
          title: "Archive failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const restore = useUnarchiveOpportunityOrPledge({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getGetOpportunityOrPledgeQueryKey(opp.id),
          }),
          queryClient.invalidateQueries({
            queryKey: getListOpportunitiesAndPledgesQueryKey(),
          }),
        ]);
        toast({ title: `${recordLabel} restored` });
      },
      onError: (err: unknown) => {
        toast({
          title: "Restore failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  function patch(body: UpdateOpportunityOrPledgeBody) {
    return update.mutateAsync({ id: opp.id, data: body });
  }

  async function saveName() {
    const trimmed = nameValue.trim();
    if (trimmed === (opp.name ?? "")) {
      setEditingName(false);
      return;
    }
    await patch({ name: trimmed || null });
    setEditingName(false);
  }

  // Finance/admin gate for close-award & reopen-award. Server enforces with
  // a 403 finance_role_required; this only labels the disabled menu item.
  const viewerRole = useGetCurrentUser().data?.role;
  const viewerIsFinance = viewerRole === "finance" || viewerRole === "admin";
  const reopenAward = useReopenAwardAction(opp.id);

  const userNames = useUserNameMap();
  const ownerDisplay = opp.ownerUserId
    ? (userNames.get(opp.ownerUserId) ?? opp.ownerUserId)
    : "—";

  const funderName = useOrganizationName(opp.organizationId ?? null);
  const giverName = usePersonName(opp.individualGiverPersonId ?? null);
  const householdName = useHouseholdName(opp.householdId ?? null);
  const advisorName = usePersonName(opp.individualAdvisorPersonId ?? null);
  const primaryContactName = usePersonName(opp.primaryContactPersonId ?? null);

  // Fetch the linked donor entities so the People card can list the people
  // associated with the funder / household (mirrors the gift-detail layout).
  const funderDetail = useGetOrganization(opp.organizationId ?? "", {
    query: {
      queryKey: getGetOrganizationQueryKey(opp.organizationId ?? ""),
      enabled: !!opp.organizationId,
    },
  });
  const householdDetail = useGetHousehold(opp.householdId ?? "", {
    query: {
      queryKey: getGetHouseholdQueryKey(opp.householdId ?? ""),
      enabled: !!opp.householdId,
    },
  });

  const associatedPeople: PeopleEntityRole[] = [];
  const seenPeople = new Set<string>();
  for (const role of [
    ...(funderDetail.data?.people ?? []),
    ...(householdDetail.data?.people ?? []),
  ]) {
    if (seenPeople.has(role.personId)) continue;
    seenPeople.add(role.personId);
    associatedPeople.push(role);
  }

  const [hideInactivePeople, setHideInactivePeople] = useState(false);
  const hasInactivePeople = associatedPeople.some((p) => p.current === "past");
  const visibleAssociatedPeople = hideInactivePeople
    ? associatedPeople.filter((p) => p.current !== "past")
    : associatedPeople;

  // Donor renders as a plain link everywhere (header subtitle + Donor card) —
  // no "Funder:"/"Individual:"/"Household:" type prefix; the surrounding
  // context already identifies it as the donor.
  const noDonor: ReactNode = (
    <span className="text-muted-foreground">No donor linked.</span>
  );
  let donorLink: ReactNode = null;
  if (opp.organizationId) {
    donorLink = (
      <Link
        href={`/organizations/${opp.organizationId}`}
        className="text-primary hover:underline"
      >
        {funderName ?? opp.organizationId}
      </Link>
    );
  } else if (opp.individualGiverPersonId) {
    donorLink = (
      <Link
        href={`/individuals/${opp.individualGiverPersonId}`}
        className="text-primary hover:underline"
      >
        {giverName ?? opp.individualGiverPersonId}
      </Link>
    );
  } else if (opp.householdId) {
    donorLink = (
      <Link
        href={`/households/${opp.householdId}`}
        className="text-primary hover:underline"
      >
        {householdName ?? opp.householdId}
      </Link>
    );
  }
  const donorDisplay: ReactNode = donorLink ?? noDonor;
  const advisorDisplay: ReactNode = opp.individualAdvisorPersonId ? (
    <Link
      href={`/individuals/${opp.individualAdvisorPersonId}`}
      className="text-primary hover:underline"
    >
      {advisorName ?? opp.individualAdvisorPersonId}
    </Link>
  ) : (
    "—"
  );
  const primaryContactDisplay: ReactNode = opp.primaryContactPersonId ? (
    <Link
      href={`/individuals/${opp.primaryContactPersonId}`}
      className="text-primary hover:underline"
    >
      {primaryContactName ?? opp.primaryContactPersonId}
    </Link>
  ) : (
    "—"
  );

  // The donor is one of (funder, individual giver, household), DB-enforced XOR.
  // The two-step InlineEditDonor control emits all three FK fields with the
  // non-selected ones nulled, so exactly one stays populated on save.
  const saveDonor = (body: DonorSaveBody) => patch(body);

  const title = editingName ? (
    <Input
      value={nameValue}
      onChange={(e) => setNameValue(e.target.value)}
      className="h-11 max-w-md font-serif text-2xl font-bold"
      aria-label={`${recordLabel} name`}
      data-testid="input-opp-name"
      autoFocus
    />
  ) : (
    (opp.name ?? `Untitled ${opp.id}`)
  );

  const paymentDonor = opp.organizationId
    ? {
        type: "organization" as const,
        id: opp.organizationId,
        name: funderName ?? opp.organizationId,
      }
    : opp.householdId
      ? {
          type: "household" as const,
          id: opp.householdId,
          name: householdName ?? opp.householdId,
        }
      : opp.individualGiverPersonId
        ? {
            type: "individual" as const,
            id: opp.individualGiverPersonId,
            name: giverName ?? opp.individualGiverPersonId,
          }
        : null;

  const viewerIsAdmin = viewerRole === "admin";
  const linkedPayments = opp.payments ?? [];
  const activeLinkedPayments = linkedPayments.filter(
    (payment) => !payment.archivedAt,
  );
  const singlePayment =
    activeLinkedPayments.length === 1 ? activeLinkedPayments[0] : null;
  const basicConvertEligible =
    isPledge &&
    opp.disbursementModel === "fixed_commitment" &&
    !opp.isWriteOff &&
    linkedPayments.length === 1 &&
    !!singlePayment &&
    Number(singlePayment.amount ?? 0) > 0 &&
    Math.round(Number(singlePayment.amount ?? 0) * 100) ===
      Math.round(Number(opp.awardedAmount ?? 0) * 100);
  const convertDisabledReason = !viewerIsAdmin
    ? "admin role required"
    : opp.disbursementModel !== "fixed_commitment"
      ? "cost-reimbursement awards cannot be converted"
      : opp.isWriteOff
        ? "write-off pledges cannot be converted"
        : linkedPayments.length !== 1
          ? "requires exactly one payment"
          : !singlePayment ||
              Math.round(Number(singlePayment.amount ?? 0) * 100) !==
                Math.round(Number(opp.awardedAmount ?? 0) * 100)
            ? "the one payment must fully equal the pledge"
            : null;
  const canRevertPledge = viewerIsAdmin && linkedPayments.length === 0;

  const reopenOpportunity = () =>
    patch({
      lossType: null,
      lossReason: null,
      actualCompletionDate: null,
    });

  const startClose = (next: OpportunityLossType) => {
    setCloseDateValue(
      opp.actualCompletionDate ?? new Date().toISOString().slice(0, 10),
    );
    setCloseReasonValue(opp.lossReason ?? "");
    setClosingLossType(next);
  };

  const primaryAction = opp.archivedAt ? (
    <Button
      size="sm"
      onClick={() => restore.mutate({ id: opp.id })}
      disabled={restore.isPending}
      data-testid="button-restore-opp"
    >
      {restore.isPending
        ? "Restoring…"
        : `Restore ${recordLabel.toLowerCase()}`}
    </Button>
  ) : isPledge ? (
    opp.status === "cash_in" ? null : (
      <Button
        size="sm"
        onClick={() => setPaymentPickerOpen(true)}
        disabled={!paymentDonor}
        data-testid="button-link-pledge-payment"
      >
        {opp.disbursementModel === "cost_reimbursement"
          ? "Link reimbursement payment"
          : "Link payment"}
      </Button>
    )
  ) : opp.lossType ? (
    <Button
      size="sm"
      onClick={() => void reopenOpportunity()}
      disabled={update.isPending}
      data-testid="button-reopen-opportunity"
    >
      Reopen opportunity
    </Button>
  ) : opp.commitmentPath === "gift" ? (
    <Button
      size="sm"
      onClick={() => setPaymentPickerOpen(true)}
      disabled={!paymentDonor}
      data-testid="button-record-received-gift"
    >
      Record received gift
    </Button>
  ) : opp.commitmentPath === "written_pledge" ||
    opp.commitmentPath === "verbal_pledge" ? (
    <Button
      size="sm"
      onClick={() => setFinalizeOpen(true)}
      data-testid="button-finalize-primary"
    >
      Finalize pledge
    </Button>
  ) : (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" data-testid="button-record-verbal-commitment">
          Record verbal commitment
          <ChevronDown className="ml-1 h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setCommitmentPathOpen("gift")}>
          Commitment to make a gift…
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => setCommitmentPathOpen("written_pledge")}
        >
          Commitment to make a written pledge…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const actions = editingName ? (
    <>
      <Button
        onClick={saveName}
        disabled={update.isPending}
        data-testid="button-save-opp-name"
      >
        {update.isPending ? "Saving…" : "Save"}
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setNameValue(opp.name ?? "");
          setEditingName(false);
        }}
        disabled={update.isPending}
      >
        Cancel
      </Button>
    </>
  ) : (
    <>
      {primaryAction}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={archive.isPending || restore.isPending}
            data-testid="button-opp-actions"
          >
            Actions
            <ChevronDown className="ml-1 h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-72">
          {opp.archivedAt ? (
            <DropdownMenuItem
              onSelect={() => restore.mutate({ id: opp.id })}
              disabled={restore.isPending}
            >
              Restore {recordLabel.toLowerCase()}
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => setEditingName(true)}>
                Edit name
              </DropdownMenuItem>
              <DropdownMenuSeparator />

              {!isPledge && !opp.isWriteOff ? (
                <>
                  <DropdownMenuItem
                    onSelect={() => setCommitmentPathOpen("gift")}
                  >
                    {opp.commitmentPath === "gift"
                      ? "Edit verbal gift commitment…"
                      : "Record verbal commitment to make a gift…"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => setCommitmentPathOpen("written_pledge")}
                  >
                    {opp.commitmentPath === "written_pledge"
                      ? "Edit written-pledge commitment…"
                      : "Record verbal commitment to make a written pledge…"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => setCommitmentPathOpen("verbal_pledge")}
                  >
                    {opp.commitmentPath === "verbal_pledge"
                      ? "Edit informal verbal pledge setup…"
                      : "Set up informal verbal pledge…"}
                  </DropdownMenuItem>
                  {opp.commitmentPath === "gift" ? (
                    <DropdownMenuItem
                      onSelect={() => setPaymentPickerOpen(true)}
                      disabled={!paymentDonor}
                    >
                      Record received gift…
                    </DropdownMenuItem>
                  ) : null}
                  {opp.commitmentPath === "written_pledge" ||
                  opp.commitmentPath === "verbal_pledge" ? (
                    <DropdownMenuItem onSelect={() => setFinalizeOpen(true)}>
                      Finalize pledge…
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  {opp.lossType ? (
                    <DropdownMenuItem onSelect={() => void reopenOpportunity()}>
                      Reopen opportunity
                    </DropdownMenuItem>
                  ) : (
                    <>
                      <DropdownMenuItem onSelect={() => startClose("dormant")}>
                        Mark dormant…
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => startClose("lost")}>
                        Mark lost…
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              ) : null}

              {isPledge && !opp.isWriteOff ? (
                <>
                  <DropdownMenuItem
                    onSelect={() => setPaymentPickerOpen(true)}
                    disabled={!paymentDonor}
                  >
                    {opp.disbursementModel === "cost_reimbursement"
                      ? "Link reimbursement payment…"
                      : "Link payment…"}
                  </DropdownMenuItem>
                  {opp.disbursementModel === "cost_reimbursement" ? (
                    opp.awardClosedAt ? (
                      <DropdownMenuItem
                        disabled={!viewerIsFinance || reopenAward.isPending}
                        onSelect={() => reopenAward.mutate({ id: opp.id })}
                      >
                        Reopen award
                        {!viewerIsFinance ? " (finance role required)" : ""}
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        disabled={!viewerIsFinance}
                        onSelect={() => setCloseAwardOpen(true)}
                      >
                        Close award…
                        {!viewerIsFinance ? " (finance role required)" : ""}
                      </DropdownMenuItem>
                    )
                  ) : null}
                  {opp.auditClose.frozen &&
                  Number(opp.auditClose.uncollectedRemainder) > 0 &&
                  !opp.auditClose.resolvedByWriteOffPledgeId ? (
                    <DropdownMenuItem onSelect={() => setWriteOffOpen(true)}>
                      Write off remainder…
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!basicConvertEligible || !viewerIsAdmin}
                    onSelect={() => setConvertToGiftOpen(true)}
                  >
                    Convert pledge and payment to stand-alone gift…
                    {convertDisabledReason ? ` (${convertDisabledReason})` : ""}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canRevertPledge}
                    onSelect={() => setRevertVerbalGiftOpen(true)}
                  >
                    Revert to verbal gift commitment…
                    {!viewerIsAdmin
                      ? " (admin role required)"
                      : linkedPayments.length > 0
                        ? " (remove or convert payments first)"
                        : ""}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canRevertPledge}
                    onSelect={() => setRevertOpportunityOpen(true)}
                  >
                    Revert to general opportunity…
                    {!viewerIsAdmin
                      ? " (admin role required)"
                      : linkedPayments.length > 0
                        ? " (remove or convert payments first)"
                        : ""}
                  </DropdownMenuItem>
                </>
              ) : null}

              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setFlagResearchOpen(true)}
                data-testid="action-flag-research-opp"
              >
                Flag for research
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!viewerIsAdmin}
                onSelect={() =>
                  navigate(
                    `/audit-log?entityType=opportunity&entityId=${opp.id}`,
                  )
                }
              >
                View change history
                {!viewerIsAdmin ? " (admin role required)" : ""}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setArchiveOpen(true)}
                data-testid="action-archive-opp"
              >
                Archive {recordLabel.toLowerCase()}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {paymentDonor ? (
        <PaymentEvidencePickerDialog
          open={paymentPickerOpen}
          onOpenChange={setPaymentPickerOpen}
          donor={paymentDonor}
          action={{
            kind: "create-from-opportunity",
            opportunityId: opp.id,
            recordKind: isPledge ? "pledge" : "opportunity",
          }}
          expectedAmount={
            isPledge
              ? String(
                  Math.max(
                    0,
                    Number(opp.awardedAmount ?? 0) -
                      Number(opp.paidAmount ?? 0),
                  ),
                )
              : (opp.awardedAmount ?? opp.askAmount)
          }
          onComplete={(giftId) => navigate(`/gifts/${giftId}`)}
        />
      ) : null}
      <VerbalCommitmentDialog
        opp={opp}
        path={commitmentPathOpen ?? "gift"}
        open={commitmentPathOpen !== null}
        onOpenChange={(open) => {
          if (!open) setCommitmentPathOpen(null);
        }}
      />
      <FinalizePledgeDialog
        opp={opp}
        open={finalizeOpen}
        onOpenChange={setFinalizeOpen}
        onFinalized={() => navigate(`/pledges/${opp.id}`)}
      />
      <ConvertPledgeToGiftDialog
        pledgeId={opp.id}
        open={convertToGiftOpen}
        onOpenChange={setConvertToGiftOpen}
        onConverted={(giftId) => navigate(`/gifts/${giftId}`)}
      />
      <RevertPledgeToVerbalGiftDialog
        pledgeId={opp.id}
        open={revertVerbalGiftOpen}
        onOpenChange={setRevertVerbalGiftOpen}
        initialCommitmentDate={opp.verbalCommitmentAt ?? opp.pledgeCommittedAt}
        initialExpectedDate={opp.projectedCloseDate}
        onReverted={() => navigate(`/opportunities/${opp.id}`)}
      />
      <RevertPledgeToOpportunityDialog
        pledgeId={opp.id}
        open={revertOpportunityOpen}
        onOpenChange={setRevertOpportunityOpen}
        initialStage={opp.stage}
        initialProjectedCloseDate={opp.projectedCloseDate}
        onReverted={() => navigate(`/opportunities/${opp.id}`)}
      />
      <CloseAwardDialog
        opp={opp}
        open={closeAwardOpen}
        onOpenChange={setCloseAwardOpen}
      />
      <FlagForResearchDialog
        targetType={isPledge ? "pledge" : "opportunity"}
        targetId={opp.id}
        recordLabel={opp.name ?? `this ${recordLabel.toLowerCase()}`}
        open={flagResearchOpen}
        onOpenChange={setFlagResearchOpen}
        hideTrigger
      />
      <ConfirmDeleteDialog
        title={`Archive this ${recordLabel.toLowerCase()}?`}
        description="Archive is for duplicate, test, or invalid records—not a fundraising outcome. The record will be hidden from default lists and can be restored by an admin."
        confirmLabel="Archive"
        busyLabel="Archiving…"
        destructive={false}
        onConfirm={() => archive.mutateAsync({ id: opp.id })}
        disabled={archive.isPending}
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        confirmTestId="button-confirm-archive-opp"
      />
      <Dialog
        open={closingLossType !== null}
        onOpenChange={(open) => {
          if (!open) setClosingLossType(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Mark opportunity as{" "}
              {closingLossType === "dormant" ? "dormant" : "lost"}?
            </DialogTitle>
            <DialogDescription>
              Dormant pauses the opportunity. Lost closes it because the ask was
              declined, withdrawn, or otherwise unsuccessful.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="close-date-input" className="text-sm font-medium">
                Actual completion date
              </label>
              <Input
                id="close-date-input"
                type="date"
                value={closeDateValue}
                onChange={(event) => setCloseDateValue(event.target.value)}
                data-testid="input-close-date"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="close-reason-input"
                className="text-sm font-medium"
              >
                {closingLossType === "lost"
                  ? "Loss reason"
                  : "Explanation (optional)"}
              </label>
              <Input
                id="close-reason-input"
                value={closeReasonValue}
                onChange={(event) => setCloseReasonValue(event.target.value)}
                placeholder={
                  closingLossType === "lost"
                    ? "Why was the opportunity lost?"
                    : "Why is the opportunity being paused?"
                }
                data-testid="input-close-reason"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setClosingLossType(null)}
              data-testid="button-cancel-close-date"
            >
              Cancel
            </Button>
            <Button
              disabled={
                !closeDateValue ||
                (closingLossType === "lost" && !closeReasonValue.trim()) ||
                update.isPending
              }
              onClick={async () => {
                if (!closingLossType || !closeDateValue) return;
                await patch({
                  lossType: closingLossType,
                  actualCompletionDate: closeDateValue,
                  lossReason: closeReasonValue.trim() || null,
                });
                setClosingLossType(null);
              }}
              data-testid="button-confirm-close-date"
            >
              {update.isPending
                ? "Saving…"
                : closingLossType === "dormant"
                  ? "Mark dormant"
                  : "Mark lost"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  const statusBadge = (status: OpportunityStatus | null) =>
    status ? (
      <Badge
        variant={
          status === "cash_in" || status === "pledge" ? "default" : "outline"
        }
      >
        {opportunityStatusLabel(status)}
      </Badge>
    ) : (
      <span className="text-muted-foreground">—</span>
    );

  // Each cell shows ONE of a pair (awarded over ask; actual over projected)
  // but on edit exposes BOTH underlying fields.
  const amountIsAwarded = opp.awardedAmount != null;
  const closeIsActual = opp.actualCompletionDate != null;

  // Loss type is set via the Actions menu (Mark as lost / dormant), not a
  // highlight — the derived status badge in the header shows the result.
  const highlights: Highlight[] = [
    {
      label: "Stage",
      accent: true,
      value: (
        <InlineEditSelect
          align="left"
          label="Stage"
          testIdBase="opp-stage"
          value={opp.stage ?? null}
          options={STAGE_OPTIONS}
          display={formatEnum(opp.stage) || "—"}
          onSave={(next) => patch({ stage: next })}
        />
      ),
    },
    {
      label: "Type",
      value: (
        <InlineEditSelect
          align="left"
          label="Type"
          testIdBase="opp-type"
          value={opp.type ?? null}
          options={TYPE_OPTIONS}
          display={formatEnum(opp.type) || "—"}
          onSave={(next) => patch({ type: next })}
        />
      ),
    },
    {
      label: "Fundraising category",
      value: (
        <InlineEditSelect
          align="left"
          label="Fundraising category"
          testIdBase="opp-category"
          value={opp.loanOrGrant ?? "grant"}
          options={CATEGORY_OPTIONS}
          display={
            (opp.loanOrGrant ?? "grant") === "loan"
              ? "Loan Capital"
              : "Revenue / Gifts"
          }
          allowNull={false}
          onSave={(next) =>
            patch({ loanOrGrant: (next ?? "grant") as LoanOrGrant })
          }
        />
      ),
    },
    {
      label: amountIsAwarded ? "Awarded" : "Ask",
      value: (
        <InlineEditAmounts
          ask={opp.askAmount ?? null}
          awarded={opp.awardedAmount ?? null}
          onSave={(body) => patch(body)}
        />
      ),
    },
    {
      label: closeIsActual ? "Completed" : "Projected close",
      value: (
        <InlineEditCloseDates
          projected={opp.projectedCloseDate ?? null}
          actual={opp.actualCompletionDate ?? null}
          onSave={(body) => patch(body)}
        />
      ),
    },
    {
      label: "Owner",
      value: (
        <InlineEditUserPicker
          align="left"
          testIdBase="opp-owner"
          value={opp.ownerUserId ?? null}
          display={ownerDisplay}
          onSave={(next) => patch({ ownerUserId: next })}
        />
      ),
    },
  ];

  const allocations = opp.allocations ?? [];
  const payments = opp.payments ?? [];

  // Pill target: awarded amount if present, else the ask. Sums compare
  // allocations / payments against it.
  const targetRaw = opp.awardedAmount ?? opp.askAmount ?? null;
  const targetAmount = targetRaw == null ? null : toNum(targetRaw);
  const allocationsSum = allocations.reduce(
    (s, a) => s + toNum(a.subAmount),
    0,
  );
  // Server-derived paid rollup (excludes archived payments) — the nested
  // `payments` array includes archived rows for admins, so a client-side sum
  // would overcount. Keep the pill in lockstep with the list/pledge math.
  const paymentsSum = toNum(opp.paidAmount);

  // Status badge (calculated server-side) and fiscal-year pill shown next to
  // the "Opportunity" type badge in the header.
  const headerBadges = (
    <>
      <span data-testid="text-opp-status" className="flex items-center">
        {statusBadge(opp.status ?? null)}
      </span>
      {opp.fiscalYear ? (
        <Badge
          variant="outline"
          className="rounded-full"
          data-testid="badge-opp-fy"
        >
          {opp.fiscalYear}
        </Badge>
      ) : null}
      <NeedsResearchBadge flagged={opp.flaggedForResearch} />
      <PlanningBadge opp={opp} />
      {opp.awardClosedAt ? (
        <Badge
          variant="outline"
          className="rounded-full"
          data-testid="badge-award-closed"
        >
          Award closed
          {opp.awardCloseReason
            ? ` — ${AWARD_CLOSE_REASON_LABELS[opp.awardCloseReason] ?? opp.awardCloseReason}`
            : ""}
        </Badge>
      ) : null}
    </>
  );

  // Once money is linked, changing the donor also changes the meaning of the
  // payment. Keep it read-only and require an explicit correction workflow.
  const subtitle =
    linkedPayments.length > 0 ? (
      donorDisplay
    ) : (
      <InlineEditDonor
        testIdBase="opp-donor"
        align="left"
        value={{
          organizationId: opp.organizationId ?? null,
          individualGiverPersonId: opp.individualGiverPersonId ?? null,
          householdId: opp.householdId ?? null,
        }}
        display={donorDisplay}
        onSave={saveDonor}
      />
    );

  return (
    <>
      <RecordLayout
        backHref={recordBackHref}
        backLabel={recordBackLabel}
        title={title}
        typeBadge={recordLabel}
        headerBadges={headerBadges}
        subtitle={subtitle}
        actions={actions}
        highlights={highlights}
        left={
          <>
            <FieldCard
              title="Pipeline"
              empty={
                (isPledge || !opp.applicationDeadline) &&
                !opp.winProbability &&
                !isPledge &&
                !opp.grantLetterUrl &&
                !opp.writeOffOfPledgeId &&
                !opp.auditClose.resolvedByWriteOffPledgeId
              }
            >
              <div className="space-y-1">
                {/*
                  Application deadline is a pre-award field; on a pledge the
                  award is already committed, so the row is hidden there.
                */}
                {!isPledge ? (
                  <Row label="Application deadline">
                    <InlineEditDate
                      label="Application deadline"
                      testIdBase="opp-app-deadline"
                      value={opp.applicationDeadline ?? null}
                      display={formatDate(opp.applicationDeadline)}
                      onSave={(next) => patch({ applicationDeadline: next })}
                    />
                  </Row>
                ) : null}
                <Row label="Disbursement model">
                  <InlineEditSelect
                    label="Disbursement model"
                    testIdBase="opp-disbursement-model"
                    value={opp.disbursementModel ?? "fixed_commitment"}
                    options={DISBURSEMENT_MODEL_OPTIONS}
                    display={
                      (opp.disbursementModel ?? "fixed_commitment") ===
                      "cost_reimbursement"
                        ? "Cost reimbursement"
                        : "Fixed commitment"
                    }
                    allowNull={false}
                    onSave={(next) =>
                      patch({
                        disbursementModel: (next ??
                          "fixed_commitment") as DisbursementModel,
                      })
                    }
                  />
                </Row>
                {opp.awardClosedAt ? (
                  <Row label="Award closed">
                    <span className="text-sm" data-testid="text-award-closed">
                      {formatDate(opp.awardClosedAt)}
                      {opp.awardCloseReason
                        ? ` — ${AWARD_CLOSE_REASON_LABELS[opp.awardCloseReason] ?? opp.awardCloseReason}`
                        : ""}
                    </span>
                  </Row>
                ) : null}
                <Row label="Payment probability">
                  <InlineEditText
                    label="Payment probability"
                    testIdBase="opp-winprob"
                    value={opp.winProbability ?? null}
                    placeholder="e.g. 75% or 0.75"
                    display={formatPercent(opp.winProbability)}
                    onSave={(next) => patch({ winProbability: next })}
                  />
                </Row>
                {/*
                  "Closed as pledge" (was_pledge) is a sticky-true flag that
                  pins a row to the Pledges page. It's meaningful on the pledge
                  view; on the opportunity view it's noise (an opportunity that
                  became a pledge is shown as a pledge), so hide the row there.
                  (T#585)
                */}
                {opp.auditClose.resolvedByWriteOffPledgeId ? (
                  <Row label="Uncollected remainder">
                    <Link
                      href={`/pledges/${opp.auditClose.resolvedByWriteOffPledgeId}`}
                      className="text-sm underline-offset-2 hover:underline"
                      data-testid="link-write-off-pledge"
                    >
                      Written off via a linked pledge →
                    </Link>
                  </Row>
                ) : null}
                {opp.writeOffOfPledgeId ? (
                  <Row label="Write-off of">
                    <Link
                      href={`/pledges/${opp.writeOffOfPledgeId}`}
                      className="text-sm underline-offset-2 hover:underline"
                      data-testid="link-original-pledge"
                    >
                      Original pledge →
                    </Link>
                  </Row>
                ) : null}
                <Row label="Grant letter">
                  {/*
                    File upload via presigned URL → /api/storage/objects/<id>.
                    Uploading the document does not itself create a pledge;
                    use Finalize pledge after the plan is complete.
                  */}
                  <FileUploadField
                    url={opp.grantLetterUrl ?? null}
                    filename={opp.grantLetterFilename ?? null}
                    uploadLabel="Upload grant letter"
                    toastTitle="Grant letter uploaded"
                    testIdBase="opp-grant-letter"
                    onUploaded={(next) =>
                      patch({
                        grantLetterUrl: next.url,
                        grantLetterFilename: next.filename,
                      })
                    }
                    onCleared={() =>
                      patch({ grantLetterUrl: null, grantLetterFilename: null })
                    }
                  />
                </Row>
              </div>
            </FieldCard>

            <FieldCard
              title="Conditions"
              empty={!opp.conditionalRollup && opp.conditionsMetRollup === "no"}
            >
              <div className="space-y-2 text-sm">
                <DerivedRow label="Conditional" hint="derived from allocations">
                  {formatEnum(opp.conditionalRollup) || "—"}
                </DerivedRow>
                {/*
                  "Conditions met" is meaningless when nothing is conditional
                  (rollup is null with no allocations, "unconditional" when
                  allocations exist but none are conditional).
                */}
                {opp.conditionalRollup &&
                opp.conditionalRollup !== "unconditional" ? (
                  <DerivedRow
                    label="Conditions met"
                    hint="derived from allocations"
                  >
                    {CONDITIONS_MET_LABELS[opp.conditionsMetRollup ?? "no"]}
                  </DerivedRow>
                ) : null}
              </div>
            </FieldCard>

            <FieldCard title="Other details" defaultOpen={false}>
              <div className="space-y-4">
                <EditableNote
                  label="Payment details"
                  testIdBase="opp-payment-details"
                  value={opp.paymentDetails ?? null}
                  onSave={(next) => patch({ paymentDetails: next })}
                />
                <EditableNote
                  label="Usage notes"
                  testIdBase="opp-usage-notes"
                  value={opp.usageNotes ?? null}
                  onSave={(next) => patch({ usageNotes: next })}
                />
                <EditableNote
                  label="Loss reason"
                  testIdBase="opp-loss-reason"
                  value={opp.lossReason ?? null}
                  onSave={(next) => patch({ lossReason: next })}
                />
              </div>
            </FieldCard>

            <RelatedCard
              title="Allocations"
              count={allocations.length}
              action={
                <ProgressPill
                  sum={allocationsSum}
                  target={targetAmount}
                  fullLabel="Fully allocated"
                  overLabel="Over allocated"
                  underLabel="Under allocated"
                />
              }
            >
              <div className="space-y-4 px-2 py-1">
                <PledgeAllocationsEditor
                  pledgeOrOpportunityId={opp.id}
                  allocations={opp.allocations ?? []}
                  totalAmount={targetAmount}
                  scheduleCount={(opp.expectedPayments ?? []).length}
                  reimbursablePrompt={
                    opp.disbursementModel === "cost_reimbursement"
                  }
                />
              </div>
            </RelatedCard>

            <RelatedCard
              title="Payment plan"
              count={(opp.expectedPayments ?? []).length || undefined}
            >
              <div className="px-2 py-1">
                <InstallmentSchedule opp={opp} />
              </div>
            </RelatedCard>

            <RelatedCard
              title="Payments"
              count={payments.length}
              action={
                <ProgressPill
                  sum={paymentsSum}
                  target={targetAmount}
                  fullLabel="Fully paid"
                  overLabel="Over paid"
                  underLabel="Not fully paid"
                />
              }
            >
              {payments.length > 0 ? (
                <div>
                  {payments.map((p) => (
                    <div key={p.id} data-testid={`row-opp-payment-${p.id}`}>
                      <RelatedRow
                        name={p.name ?? `Payment ${p.id}`}
                        href={`/gifts/${p.id}`}
                        tone="primary"
                        sub={formatDate(p.dateReceived)}
                        amount={formatCurrency(p.amount)}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-2 py-2 text-sm text-muted-foreground">
                  No payments yet.
                </p>
              )}
            </RelatedCard>

            <div className="px-1 text-xs text-muted-foreground">
              Created {formatDate(opp.createdAt)} • Updated{" "}
              {formatDate(opp.updatedAt)}
            </div>
          </>
        }
        center={
          // Activity (interactions/emails/calendar/meetings) is scoped to
          // whichever donor this opportunity is linked to — opportunities
          // don't have their own activity arrays — while notes & tasks link
          // to the opportunity itself. Tasks sit above the activity feed.
          (() => {
            const personIds: string[] = [];
            if (opp.individualGiverPersonId)
              personIds.push(opp.individualGiverPersonId);
            if (
              opp.primaryContactPersonId &&
              opp.primaryContactPersonId !== opp.individualGiverPersonId
            ) {
              personIds.push(opp.primaryContactPersonId);
            }
            const oppDefaultLinks: Partial<{
              personIds: string[];
              organizationIds: string[];
              householdIds: string[];
              opportunityIds: string[];
              giftIds: string[];
            }> = {
              ...(opp.organizationId
                ? { organizationIds: [opp.organizationId] }
                : {}),
              ...(opp.householdId ? { householdIds: [opp.householdId] } : {}),
              ...(personIds.length > 0 ? { personIds } : {}),
            };
            return (
              <>
                <TasksPanel
                  opportunityId={opp.id}
                  defaultLinks={oppDefaultLinks}
                />
                <UnifiedActivityFeed
                  organizationId={opp.organizationId ?? undefined}
                  personId={opp.individualGiverPersonId ?? undefined}
                  householdId={opp.householdId ?? undefined}
                  notesContext={{
                    opportunityId: opp.id,
                    defaultLinks: oppDefaultLinks,
                  }}
                  hideTasks
                />
              </>
            );
          })()
        }
        right={
          <>
            <CommitmentLifecycleCard opp={opp} />
            <RelatedCard
              title="People"
              count={associatedPeople.length || undefined}
              empty={
                funderDetail.isLoading || householdDetail.isLoading
                  ? undefined
                  : !opp.primaryContactPersonId &&
                    !opp.individualAdvisorPersonId &&
                    associatedPeople.length === 0
              }
              action={
                hasInactivePeople ? (
                  <HideInactiveToggle
                    hidden={hideInactivePeople}
                    onToggle={() => setHideInactivePeople((h) => !h)}
                  />
                ) : undefined
              }
            >
              <div className="space-y-1 px-2 py-1">
                <Row label="Primary contact">
                  <InlineEditPersonPicker
                    testIdBase="opp-primary-contact"
                    value={opp.primaryContactPersonId ?? null}
                    display={primaryContactDisplay}
                    onSave={(next) => patch({ primaryContactPersonId: next })}
                  />
                </Row>
                <Row label="Advisor">
                  <InlineEditPersonPicker
                    testIdBase="opp-advisor"
                    value={opp.individualAdvisorPersonId ?? null}
                    display={advisorDisplay}
                    onSave={(next) =>
                      patch({ individualAdvisorPersonId: next })
                    }
                  />
                </Row>
              </div>
              {visibleAssociatedPeople.length > 0 ? (
                <div className="border-t pt-1">
                  {visibleAssociatedPeople.map((role) => {
                    const subtitle =
                      role.externalTitleOrRole ??
                      (role.connection ? formatEnum(role.connection) : null);
                    const roleLabel =
                      [subtitle, role.personEmail]
                        .filter(Boolean)
                        .join(" · ") || undefined;
                    return (
                      <div
                        key={role.id}
                        data-testid={`row-opp-person-${role.personId}`}
                      >
                        <AffiliationRow
                          name={role.personName ?? `Person ${role.personId}`}
                          href={`/individuals/${role.personId}`}
                          role={roleLabel}
                          primary={role.primaryContact ?? false}
                          hideStatusBadge
                          action={<EditPeopleEntityRoleDialog role={role} />}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </RelatedCard>
          </>
        }
      />

      <ReportingDeadlinesDialog
        opportunityId={opp.id}
        funderName={funderName ?? null}
        open={reportingDialogOpen}
        onOpenChange={setReportingDialogOpen}
      />
      <WriteOffPledgeDialog
        open={writeOffOpen}
        onOpenChange={setWriteOffOpen}
        opp={opp}
        onDone={(pledgeId) => navigate(`/pledges/${pledgeId}`)}
      />
    </>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

// Coerce a nullable numeric string ("1,200" / "1200.5" / null) to a number,
// guarding against NaN so reduce() sums stay finite.
function toNum(v: string | null | undefined): number {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[,$\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// Compares a running sum against a target (awarded ?? ask). Renders nothing
// when there's no positive target to measure against.
function ProgressPill({
  sum,
  target,
  fullLabel,
  overLabel,
  underLabel,
}: {
  sum: number;
  target: number | null;
  fullLabel: string;
  overLabel: string;
  underLabel: string;
}) {
  if (target == null || target <= 0) return null;
  const diff = sum - target;
  const eps = 0.005;
  if (Math.abs(diff) < eps) {
    return (
      <Badge
        variant="default"
        className="rounded-full"
        data-testid="pill-progress"
      >
        {fullLabel}
      </Badge>
    );
  }
  if (diff > 0) {
    return (
      <Badge
        variant="destructive"
        className="rounded-full"
        data-testid="pill-progress"
      >
        {overLabel}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="rounded-full"
      data-testid="pill-progress"
    >
      {underLabel}
    </Badge>
  );
}

// Combined Ask + Awarded editor. The cell displays awarded (falling back to
// ask) but on edit exposes BOTH fields and patches them together.
function InlineEditAmounts({
  ask,
  awarded,
  onSave,
}: {
  ask: string | null;
  awarded: string | null;
  onSave: (body: UpdateOpportunityOrPledgeBody) => SaveResult;
}) {
  const [editing, setEditing] = useState(false);
  const { busy, run } = useSaveRunner();
  const [askDraft, setAskDraft] = useState(ask ?? "");
  const [awardedDraft, setAwardedDraft] = useState(awarded ?? "");

  const display = formatCurrency(awarded ?? ask);

  if (!editing) {
    return (
      <EditTriggerRow
        align="left"
        display={display}
        onEdit={() => {
          setAskDraft(ask ?? "");
          setAwardedDraft(awarded ?? "");
          setEditing(true);
        }}
        testIdBase="opp-amounts"
        ariaLabel="Edit ask and awarded amounts"
      />
    );
  }

  const parse = (s: string): { value: string | null; ok: boolean } => {
    const t = s.trim();
    if (t.length === 0) return { value: null, ok: true };
    const n = Number(t.replace(/[,$\s]/g, ""));
    const ok = Number.isFinite(n) && n >= 0;
    return { value: ok ? String(n) : null, ok };
  };

  const askParsed = parse(askDraft);
  const awardedParsed = parse(awardedDraft);
  const askCurrent = ask == null ? null : String(Number(ask));
  const awardedCurrent = awarded == null ? null : String(Number(awarded));
  const dirty =
    askParsed.value !== askCurrent || awardedParsed.value !== awardedCurrent;
  const canSave = askParsed.ok && awardedParsed.ok && dirty;

  const trySave = () => {
    if (!canSave || busy) return;
    run(
      () =>
        onSave({
          askAmount: askParsed.value,
          awardedAmount: awardedParsed.value,
        }),
      () => setEditing(false),
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="w-16 shrink-0 text-left">Ask</span>
        <Input
          value={askDraft}
          onChange={(e) => setAskDraft(e.target.value)}
          inputMode="decimal"
          aria-label="Ask amount"
          aria-invalid={!askParsed.ok}
          disabled={busy}
          data-testid="input-opp-ask"
          className="h-8"
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="w-16 shrink-0 text-left">Awarded</span>
        <Input
          value={awardedDraft}
          onChange={(e) => setAwardedDraft(e.target.value)}
          inputMode="decimal"
          aria-label="Awarded amount"
          aria-invalid={!awardedParsed.ok}
          disabled={busy}
          data-testid="input-opp-awarded"
          className="h-8"
        />
      </label>
      <div className="flex items-center justify-start gap-1">
        <ActionButtons
          busy={busy}
          canSave={canSave}
          onSave={trySave}
          onCancel={() => setEditing(false)}
          testIdBase="opp-amounts"
          label="amounts"
        />
      </div>
    </div>
  );
}

// Combined Projected-close + Actual-completion editor. The cell displays the
// actual date (falling back to projected) but on edit exposes BOTH.
function InlineEditCloseDates({
  projected,
  actual,
  onSave,
}: {
  projected: string | null;
  actual: string | null;
  onSave: (body: UpdateOpportunityOrPledgeBody) => SaveResult;
}) {
  const [editing, setEditing] = useState(false);
  const { busy, run } = useSaveRunner();
  const [projectedDraft, setProjectedDraft] = useState(projected ?? "");
  const [actualDraft, setActualDraft] = useState(actual ?? "");

  const display = formatDate(actual ?? projected);

  if (!editing) {
    return (
      <EditTriggerRow
        align="left"
        display={display}
        onEdit={() => {
          setProjectedDraft(projected ?? "");
          setActualDraft(actual ?? "");
          setEditing(true);
        }}
        testIdBase="opp-close-dates"
        ariaLabel="Edit projected close and actual completion dates"
      />
    );
  }

  const projectedNext =
    projectedDraft.trim().length === 0 ? null : projectedDraft;
  const actualNext = actualDraft.trim().length === 0 ? null : actualDraft;
  const dirty =
    projectedNext !== (projected ?? null) || actualNext !== (actual ?? null);

  const trySave = () => {
    if (!dirty || busy) return;
    run(
      () =>
        onSave({
          projectedCloseDate: projectedNext,
          actualCompletionDate: actualNext,
        }),
      () => setEditing(false),
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="w-20 shrink-0 text-left">Projected</span>
        <Input
          type="date"
          value={projectedDraft}
          onChange={(e) => setProjectedDraft(e.target.value)}
          aria-label="Projected close date"
          disabled={busy}
          data-testid="input-opp-projected-close"
          className="h-8"
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="w-20 shrink-0 text-left">Completed</span>
        <Input
          type="date"
          value={actualDraft}
          onChange={(e) => setActualDraft(e.target.value)}
          aria-label="Actual completion date"
          disabled={busy}
          data-testid="input-opp-actual-completion"
          className="h-8"
        />
      </label>
      <div className="flex items-center justify-start gap-1">
        <ActionButtons
          busy={busy}
          canSave={dirty}
          onSave={trySave}
          onCancel={() => setEditing(false)}
          testIdBase="opp-close-dates"
          label="dates"
        />
      </div>
    </div>
  );
}

function EditableNote({
  label,
  testIdBase,
  value,
  onSave,
}: {
  label: string;
  testIdBase: string;
  value: string | null;
  onSave: (next: string | null) => Promise<unknown> | unknown;
}) {
  const display = value ? (
    <p className="whitespace-pre-wrap text-left">{value}</p>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">
        {label}
      </div>
      <InlineEditTextarea
        label={label}
        testIdBase={testIdBase}
        value={value}
        display={display}
        onSave={onSave}
        placeholder={`Add ${label.toLowerCase()}…`}
      />
    </div>
  );
}
