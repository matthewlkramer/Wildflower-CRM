import { useState, type ReactNode } from "react";
import { DetailSkeleton, Skeleton } from "@/components/ui/skeleton";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetGiftOrPayment,
  useUpdateGiftOrPayment,
  useArchiveGiftOrPayment,
  useUnarchiveGiftOrPayment,
  useUntieGiftPaymentUnit,
  useGetCurrentUser,
  useGetOrganization,
  useGetHousehold,
  useGetPaymentIntermediary,
  useGetGiftStripeChain,
  useGetGiftAuditReconciliation,
  useGetOpportunityOrPledge,
  useListFundraisingCampaigns,
  getGetOpportunityOrPledgeQueryKey,
  getGetGiftOrPaymentQueryKey,
  getGetOrganizationQueryKey,
  getGetHouseholdQueryKey,
  getGetPaymentIntermediaryQueryKey,
  getGetGiftAuditReconciliationQueryKey,
  getListGiftsAndPaymentsQueryKey,
  type GiftOrPaymentDetail,
  type UpdateGiftOrPaymentBody,
  type GiftPaymentMethod,
  type PeopleEntityRole,
  type StripePayoutReconciliationStatus,
  type GiftAuditReconciliationRecord,
} from "@workspace/api-client-react";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { FlagForResearchDialog } from "@/components/flag-for-research-dialog";
import { EditPeopleEntityRoleDialog } from "@/components/add-role-dialogs";
import { GiftAllocationsEditor } from "@/components/allocation-editors";
import { UnifiedActivityFeed } from "@/components/unified-activity-feed";
import { ThankYouPanel } from "@/components/thank-you-panel";
import { TasksPanel } from "@/components/tasks-panel";
import {
  MergeGiftsDialog,
  MergeIntoPledgeDialog,
  SplitGiftIntoPledgeDialog,
} from "@/components/gift-merge-dialogs";
import { BookSurplusGiftDialog } from "@/components/audit-close-dialogs";
import { PaymentEvidencePickerDialog } from "@/components/payment-evidence-picker-dialog";
import {
  ConvertPledgeToGiftDialog,
  DetachGiftFromPledgeDialog,
  RevertGiftToOpportunityDialog,
} from "@/components/fundraising-correction-dialogs";
import {
  InlineEditBoolean,
  InlineEditCurrency,
  InlineEditDate,
  InlineEditSelect,
  InlineEditText,
  InlineEditTextarea,
  EDIT_PENCIL_REVEAL,
  type InlineSelectOption,
} from "@/components/inline-edit";
import { InlineEditUserPicker, useUserNameMap } from "@/components/user-picker";
import {
  InlineEditPersonPicker,
  InlineEditDonor,
  usePersonName,
  useOrganizationName,
  useHouseholdName,
  useIntermediaryName,
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
import { FileUploadField } from "@/components/grant-letter-upload";
import { DonorboxEnrichmentPanel } from "@/components/donorbox-enrichment-panel";
import {
  GiftSearchDialog,
  giftDonorName as giftRowDonorName,
} from "@/components/gift-search-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { NeedsResearchBadge } from "@/components/needs-research-badge";

const PAYMENT_METHOD_OPTIONS = [
  { value: "ach", label: "ACH" },
  { value: "check", label: "Check" },
  { value: "wire", label: "Wire" },
  { value: "stock", label: "Stock" },
  { value: "donor_box", label: "Donor box" },
  { value: "daf_ach", label: "DAF — ACH" },
  { value: "daf_check", label: "DAF — Check" },
  { value: "daf_bill_com", label: "DAF — Bill.com" },
] as const satisfies ReadonlyArray<InlineSelectOption<GiftPaymentMethod>>;

export default function GiftDetail() {
  const [, params] = useRoute<{ id: string }>("/gifts/:id");
  const id = params?.id ?? "";
  const { data, isLoading, isError, error } = useGetGiftOrPayment(id, {
    query: { queryKey: getGetGiftOrPaymentQueryKey(id), enabled: !!id },
  });

  if (isLoading) return <DetailSkeleton />;
  if (isError || !data) {
    return (
      <div className="space-y-4">
        <Link href="/gifts" className="text-sm text-primary hover:underline">
          ← Back to gifts
        </Link>
        <div className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Gift not found."}
        </div>
      </div>
    );
  }
  return <GiftView gift={data} />;
}

function GiftView({ gift }: { gift: GiftOrPaymentDetail }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [paymentEvidenceOpen, setPaymentEvidenceOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [attachPledgeOpen, setAttachPledgeOpen] = useState(false);
  const [convertPledgeOpen, setConvertPledgeOpen] = useState(false);
  const [detachPledgeOpen, setDetachPledgeOpen] = useState(false);
  const [revertOpportunityOpen, setRevertOpportunityOpen] = useState(false);
  const [mergeSearchOpen, setMergeSearchOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeCandidateId, setMergeCandidateId] = useState("");
  const [surplusOpen, setSurplusOpen] = useState(false);
  const [flagResearchOpen, setFlagResearchOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // "Matching gift" editor — link this gift to the gift it matches (e.g. a
  // corporate match → the employee's original gift) via giftBeingMatchedId.
  const [matchOpen, setMatchOpen] = useState(false);
  const matchedGiftId = gift.giftBeingMatchedId ?? "";
  const matchedGiftQ = useGetGiftOrPayment(matchedGiftId, {
    query: {
      queryKey: getGetGiftOrPaymentQueryKey(matchedGiftId),
      enabled: !!matchedGiftId,
    },
  });
  const mergeCandidateQ = useGetGiftOrPayment(mergeCandidateId, {
    query: {
      queryKey: getGetGiftOrPaymentQueryKey(mergeCandidateId),
      enabled: !!mergeCandidateId,
    },
  });
  const campaignsQ = useListFundraisingCampaigns();
  const campaignOptions = (campaignsQ.data ?? []).map((c) => ({
    value: c.slug,
    label: c.name,
  }));
  const campaignDisplay = gift.campaignSlug
    ? (campaignsQ.data?.find((c) => c.slug === gift.campaignSlug)?.name ??
      gift.campaignSlug)
    : "—";

  const userNames = useUserNameMap();
  const ownerDisplay = gift.ownerUserId
    ? (userNames.get(gift.ownerUserId) ?? gift.ownerUserId)
    : "—";
  const viewerRole = useGetCurrentUser().data?.role;
  const viewerIsAdmin = viewerRole === "admin";
  const organizationName = useOrganizationName(gift.organizationId ?? null);
  const giverName = usePersonName(gift.individualGiverPersonId ?? null);
  const householdName = useHouseholdName(gift.householdId ?? null);
  const advisorName = usePersonName(gift.advisorPersonId ?? null);
  const primaryContactName = usePersonName(gift.primaryContactPersonId ?? null);
  const intermediaryName = useIntermediaryName(
    gift.paymentIntermediaryId ?? null,
  );

  // Fetch the linked entities so we can list the people associated with each
  // (donor org / household / payment intermediary) in the People card.
  const funderDetail = useGetOrganization(gift.organizationId ?? "", {
    query: {
      queryKey: getGetOrganizationQueryKey(gift.organizationId ?? ""),
      enabled: !!gift.organizationId,
    },
  });
  const householdDetail = useGetHousehold(gift.householdId ?? "", {
    query: {
      queryKey: getGetHouseholdQueryKey(gift.householdId ?? ""),
      enabled: !!gift.householdId,
    },
  });
  const intermediaryDetail = useGetPaymentIntermediary(
    gift.paymentIntermediaryId ?? "",
    {
      query: {
        queryKey: getGetPaymentIntermediaryQueryKey(
          gift.paymentIntermediaryId ?? "",
        ),
        enabled: !!gift.paymentIntermediaryId,
      },
    },
  );

  // The linked pledge (if any) so we can show its grant letter read-only on the
  // gift — a payment often has no letter of its own but inherits the grant
  // letter uploaded on its parent pledge.
  const linkedPledge = useGetOpportunityOrPledge(gift.opportunityId ?? "", {
    query: {
      queryKey: getGetOpportunityOrPledgeQueryKey(gift.opportunityId ?? ""),
      enabled: !!gift.opportunityId,
    },
  });
  const pledgeGrantLetterUrl = linkedPledge.data?.grantLetterUrl ?? null;

  const associatedPeople: PeopleEntityRole[] = [];
  const seenPeople = new Set<string>();
  for (const role of [
    ...(funderDetail.data?.people ?? []),
    ...(householdDetail.data?.people ?? []),
    ...(intermediaryDetail.data?.people ?? []),
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

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(gift.name ?? "");

  // Donor renders as a plain link everywhere (header subtitle + Donor card) —
  // no "Funder:"/"Individual:"/"Household:" type prefix; the surrounding
  // context already identifies it as the donor.
  const noDonor: ReactNode = (
    <span className="text-muted-foreground">No donor linked.</span>
  );
  let donorLink: ReactNode = null;
  if (gift.organizationId) {
    donorLink = (
      <Link
        href={`/organizations/${gift.organizationId}`}
        className="text-primary hover:underline"
      >
        {organizationName ?? gift.organizationId}
      </Link>
    );
  } else if (gift.individualGiverPersonId) {
    donorLink = (
      <Link
        href={`/individuals/${gift.individualGiverPersonId}`}
        className="text-primary hover:underline"
      >
        {giverName ?? gift.individualGiverPersonId}
      </Link>
    );
  } else if (gift.householdId) {
    donorLink = (
      <Link
        href={`/households/${gift.householdId}`}
        className="text-primary hover:underline"
      >
        {householdName ?? gift.householdId}
      </Link>
    );
  }

  // Header subtitle: "Donor Name via Intermediary Name" when a payment
  // intermediary is involved, otherwise just the donor name.
  const intermediaryLink: ReactNode = gift.paymentIntermediaryId ? (
    <Link
      href={`/payment-intermediaries/${gift.paymentIntermediaryId}`}
      className="text-primary hover:underline"
    >
      {intermediaryName ?? gift.paymentIntermediaryId}
    </Link>
  ) : null;
  const donorDisplay: ReactNode = donorLink ? (
    intermediaryLink ? (
      <span>
        {donorLink} <span className="text-muted-foreground">via</span>{" "}
        {intermediaryLink}
      </span>
    ) : (
      donorLink
    )
  ) : (
    noDonor
  );

  const advisorDisplay: ReactNode = gift.advisorPersonId ? (
    <Link
      href={`/individuals/${gift.advisorPersonId}`}
      className="text-primary hover:underline"
    >
      {advisorName ?? gift.advisorPersonId}
    </Link>
  ) : (
    "—"
  );
  const primaryContactDisplay: ReactNode = gift.primaryContactPersonId ? (
    <Link
      href={`/individuals/${gift.primaryContactPersonId}`}
      className="text-primary hover:underline"
    >
      {primaryContactName ?? gift.primaryContactPersonId}
    </Link>
  ) : (
    "—"
  );
  const update = useUpdateGiftOrPayment({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getGetGiftOrPaymentQueryKey(gift.id),
          }),
          queryClient.invalidateQueries({
            queryKey: getListGiftsAndPaymentsQueryKey(),
          }),
        ]);
        toast({ title: "Gift updated" });
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

  const archive = useArchiveGiftOrPayment({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListGiftsAndPaymentsQueryKey(),
        });
        toast({ title: "Gift archived" });
        navigate("/gifts");
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

  const restore = useUnarchiveGiftOrPayment({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getGetGiftOrPaymentQueryKey(gift.id),
          }),
          queryClient.invalidateQueries({
            queryKey: getListGiftsAndPaymentsQueryKey(),
          }),
        ]);
        toast({ title: "Gift restored" });
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

  function patch(body: UpdateGiftOrPaymentBody) {
    return update.mutateAsync({ id: gift.id, data: body });
  }

  // A gift linked to an opportunity/pledge keeps that donor fixed; only the
  // intermediary remains editable. Structural donor or linkage corrections use
  // explicit admin actions so money evidence never drifts from its CRM record.
  const saveDonor = (
    body: DonorSaveBody & { paymentIntermediaryId?: string | null },
  ) => patch(body);

  async function saveName() {
    const trimmed = nameValue.trim();
    if (trimmed === (gift.name ?? "")) {
      setEditingName(false);
      return;
    }
    await patch({ name: trimmed || null });
    setEditingName(false);
  }

  const paymentDonor = gift.organizationId
    ? {
        type: "organization" as const,
        id: gift.organizationId,
        name: organizationName ?? gift.organizationId,
      }
    : gift.householdId
      ? {
          type: "household" as const,
          id: gift.householdId,
          name: householdName ?? gift.householdId,
        }
      : gift.individualGiverPersonId
        ? {
            type: "individual" as const,
            id: gift.individualGiverPersonId,
            name: giverName ?? gift.individualGiverPersonId,
          }
        : null;
  const linkedRecordIsPledge = !!linkedPledge.data?.pledgeCommittedAt;
  const linkedRecordLabel = linkedRecordIsPledge ? "pledge" : "opportunity";
  const missingPaymentEvidence =
    !gift.offBooks && gift.quickbooksTieStatus === "missing";
  const linkedRecordPayments = linkedPledge.data?.payments ?? [];
  const basicPledgeConversionEligible =
    viewerIsAdmin &&
    linkedRecordIsPledge &&
    linkedPledge.data?.disbursementModel === "fixed_commitment" &&
    !linkedPledge.data?.isWriteOff &&
    linkedRecordPayments.length === 1 &&
    linkedRecordPayments[0]?.id === gift.id &&
    Math.round(Number(gift.amount ?? 0) * 100) ===
      Math.round(Number(linkedPledge.data?.awardedAmount ?? 0) * 100);
  const mergeCandidate = mergeCandidateQ.data ?? null;

  const title = editingName ? (
    <Input
      value={nameValue}
      onChange={(e) => setNameValue(e.target.value)}
      className="h-11 max-w-md font-serif text-2xl font-bold"
      aria-label="Gift name"
      data-testid="input-gift-name"
      autoFocus
    />
  ) : (
    (gift.name ?? `Gift ${gift.id}`)
  );

  const primaryAction = gift.archivedAt ? (
    <Button
      size="sm"
      onClick={() => restore.mutate({ id: gift.id })}
      disabled={restore.isPending}
      data-testid="button-restore-gift"
    >
      {restore.isPending ? "Restoring…" : "Restore gift"}
    </Button>
  ) : missingPaymentEvidence && paymentDonor ? (
    <Button
      size="sm"
      onClick={() => setPaymentEvidenceOpen(true)}
      data-testid="button-link-gift-payment-evidence"
    >
      Link payment evidence
    </Button>
  ) : null;

  const actions = editingName ? (
    <>
      <Button
        onClick={saveName}
        disabled={update.isPending}
        data-testid="button-save-gift-name"
      >
        {update.isPending ? "Saving…" : "Save"}
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setNameValue(gift.name ?? "");
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
            data-testid="button-gift-actions"
          >
            Actions
            <ChevronDown className="ml-1 h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-72">
          {gift.archivedAt ? (
            <DropdownMenuItem
              onSelect={() => restore.mutate({ id: gift.id })}
              disabled={restore.isPending}
            >
              Restore gift
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => setEditingName(true)}>
                Edit name
              </DropdownMenuItem>
              {missingPaymentEvidence ? (
                <DropdownMenuItem
                  onSelect={() => setPaymentEvidenceOpen(true)}
                  disabled={!paymentDonor}
                >
                  Link payment evidence…
                </DropdownMenuItem>
              ) : null}

              {gift.opportunityId && linkedRecordIsPledge ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!basicPledgeConversionEligible}
                    onSelect={() => setConvertPledgeOpen(true)}
                  >
                    Convert pledge and payment to stand-alone gift…
                    {!viewerIsAdmin
                      ? " (admin role required)"
                      : !basicPledgeConversionEligible
                        ? " (requires one full payment)"
                        : ""}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!viewerIsAdmin}
                    onSelect={() => setDetachPledgeOpen(true)}
                  >
                    Detach from pledge and keep stand-alone gift…
                    {!viewerIsAdmin ? " (admin role required)" : ""}
                  </DropdownMenuItem>
                </>
              ) : null}

              {!gift.opportunityId ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!viewerIsAdmin}
                    onSelect={() => setAttachPledgeOpen(true)}
                  >
                    Convert to pledge payment…
                    {!viewerIsAdmin ? " (admin role required)" : ""}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={
                      !viewerIsAdmin || (gift.allocations?.length ?? 0) < 2
                    }
                    onSelect={() => setSplitOpen(true)}
                  >
                    Split into pledge…
                    {!viewerIsAdmin
                      ? " (admin role required)"
                      : (gift.allocations?.length ?? 0) < 2
                        ? " (requires at least two allocations)"
                        : ""}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!viewerIsAdmin}
                    onSelect={() => setMergeSearchOpen(true)}
                  >
                    Merge with another gift…
                    {!viewerIsAdmin ? " (admin role required)" : ""}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!viewerIsAdmin || !missingPaymentEvidence}
                    onSelect={() => setRevertOpportunityOpen(true)}
                  >
                    Revert gift to opportunity…
                    {!viewerIsAdmin
                      ? " (admin role required)"
                      : !missingPaymentEvidence
                        ? " (unlink received payment evidence first)"
                        : ""}
                  </DropdownMenuItem>
                </>
              ) : null}

              {gift.auditClose.frozen &&
              Number(gift.auditClose.overpaySurplus) > 0 &&
              !gift.auditClose.resolvedByGiftId &&
              !gift.overpayOfGiftId ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setSurplusOpen(true)}>
                    Book surplus gift…
                  </DropdownMenuItem>
                </>
              ) : null}

              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setFlagResearchOpen(true)}>
                Flag for research
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!viewerIsAdmin}
                onSelect={() =>
                  navigate(`/audit-log?entityType=gift&entityId=${gift.id}`)
                }
              >
                View change history
                {!viewerIsAdmin ? " (admin role required)" : ""}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setArchiveOpen(true)}>
                Archive gift
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {paymentDonor ? (
        <PaymentEvidencePickerDialog
          open={paymentEvidenceOpen}
          onOpenChange={setPaymentEvidenceOpen}
          donor={paymentDonor}
          action={{ kind: "link-existing-gift", giftId: gift.id }}
          expectedAmount={gift.amount}
        />
      ) : null}
      {gift.opportunityId ? (
        <>
          <ConvertPledgeToGiftDialog
            pledgeId={gift.opportunityId}
            open={convertPledgeOpen}
            onOpenChange={setConvertPledgeOpen}
            onConverted={(giftId) => navigate(`/gifts/${giftId}`)}
          />
          <DetachGiftFromPledgeDialog
            giftId={gift.id}
            opportunityId={gift.opportunityId}
            open={detachPledgeOpen}
            onOpenChange={setDetachPledgeOpen}
          />
        </>
      ) : null}
      <MergeIntoPledgeDialog
        open={attachPledgeOpen}
        onOpenChange={setAttachPledgeOpen}
        gifts={[gift]}
        expectedCount={1}
        onDone={(pledgeId) => navigate(`/pledges/${pledgeId}`)}
      />
      <MergeGiftsDialog
        open={mergeDialogOpen}
        onOpenChange={(open) => {
          setMergeDialogOpen(open);
          if (!open) setMergeCandidateId("");
        }}
        gifts={mergeCandidate ? [gift, mergeCandidate] : [gift]}
        expectedCount={2}
        loadError={mergeCandidateQ.isError}
        onDone={(survivingGiftId) => navigate(`/gifts/${survivingGiftId}`)}
      />
      <RevertGiftToOpportunityDialog
        giftId={gift.id}
        giftName={gift.name ?? null}
        open={revertOpportunityOpen}
        onOpenChange={setRevertOpportunityOpen}
        onReverted={(opportunityId) =>
          navigate(`/opportunities/${opportunityId}`)
        }
      />
      <FlagForResearchDialog
        targetType="gift"
        targetId={gift.id}
        recordLabel={gift.name ?? "this gift"}
        open={flagResearchOpen}
        onOpenChange={setFlagResearchOpen}
        hideTrigger
      />
      <ConfirmDeleteDialog
        title="Archive this gift?"
        description="Archive is for duplicate, test, or invalid records—not a financial outcome. The gift will be hidden from default lists and can be restored by an admin."
        confirmLabel="Archive"
        busyLabel="Archiving…"
        destructive={false}
        onConfirm={() => archive.mutateAsync({ id: gift.id })}
        disabled={archive.isPending}
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        confirmTestId="button-confirm-archive-gift"
      />
    </>
  );

  const fyDisplay =
    gift.grantYears && gift.grantYears.length > 0
      ? gift.grantYears.join(", ")
      : "—";

  const highlights: Highlight[] = [
    {
      label: "Amount",
      accent: true,
      value: (
        <InlineEditCurrency
          label="Amount"
          testIdBase="gift-amount"
          value={gift.amount ?? null}
          display={
            <span className="font-bold text-primary">
              {formatCurrency(gift.amount)}
            </span>
          }
          onSave={(next) => patch({ amount: next })}
        />
      ),
    },
    {
      label: "Received",
      value: (
        <InlineEditDate
          label="Date received"
          testIdBase="gift-date-received"
          value={gift.dateReceived ?? null}
          display={formatDate(gift.dateReceived)}
          onSave={(next) => patch({ dateReceived: next })}
        />
      ),
    },
    {
      label: "Type",
      value: (
        <span data-testid="gift-type-display">
          {formatEnum(gift.type) || "—"}
        </span>
      ),
    },
    {
      label: "Method",
      value: (
        <InlineEditSelect
          align="left"
          label="Payment method"
          testIdBase="gift-method"
          value={gift.paymentMethod ?? null}
          options={PAYMENT_METHOD_OPTIONS}
          display={formatEnum(gift.paymentMethod) || "—"}
          onSave={(next) => patch({ paymentMethod: next })}
        />
      ),
    },
    { label: "FY", value: fyDisplay },
    {
      label: "Owner",
      value: (
        <InlineEditUserPicker
          align="left"
          testIdBase="gift-owner"
          value={gift.ownerUserId ?? null}
          display={ownerDisplay}
          onSave={(next) => patch({ ownerUserId: next })}
        />
      ),
    },
  ];

  const allocations = gift.allocations ?? [];

  return (
    <>
      <RecordLayout
        backHref="/gifts"
        backLabel="Back to gifts"
        title={title}
        typeBadge="Gift"
        headerBadges={<NeedsResearchBadge flagged={gift.flaggedForResearch} />}
        subtitle={
          <InlineEditDonor
            testIdBase="gift-donor"
            align="left"
            value={{
              organizationId: gift.organizationId ?? null,
              individualGiverPersonId: gift.individualGiverPersonId ?? null,
              householdId: gift.householdId ?? null,
            }}
            intermediary={{ value: gift.paymentIntermediaryId ?? null }}
            donorReadOnly={!!gift.opportunityId}
            display={donorDisplay}
            onSave={saveDonor}
          />
        }
        actions={actions}
        highlights={highlights}
        left={
          <>
            {gift.reimbursablePlaceholderWarning ? (
              <div
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
                data-testid="warning-reimbursable-placeholder"
              >
                This gift looks like a <strong>full-award placeholder</strong>{" "}
                on a reimbursable grant, with no linked QuickBooks or Stripe
                payment. A reimbursable grant is a pledge paid as individual
                reimbursement checks — book each real check as its own 1:1
                payment rather than one gift for the whole awarded amount.
              </div>
            ) : null}
            <FieldCard title="Classification">
              <div className="space-y-1">
                <Row label="Campaign">
                  <InlineEditSelect
                    align="left"
                    label="Campaign"
                    testIdBase="gift-campaign"
                    value={gift.campaignSlug ?? null}
                    options={campaignOptions}
                    display={campaignDisplay}
                    onSave={(next) => patch({ campaignSlug: next })}
                  />
                </Row>
                <Row label="Off-books">
                  <span data-testid="gift-off-books">
                    {gift.offBooks ? "Yes" : "No"}
                  </span>
                </Row>
              </div>
              {gift.donorbox && (
                <DonorboxEnrichmentPanel donorbox={gift.donorbox} />
              )}
            </FieldCard>

            <GiftPaymentsReconciliationCard gift={gift} />

            <RelatedCard title="Allocations" count={allocations.length}>
              <div className="px-2 py-1">
                <GiftAllocationsEditor
                  giftId={gift.id}
                  allocations={gift.allocations ?? []}
                  totalAmount={gift.amount ?? null}
                />
              </div>
            </RelatedCard>

            <ThankYouPanel gift={gift} />

            <FieldCard title="Grant letter">
              <div className="space-y-3">
                <Row label="Grant letter">
                  <FileUploadField
                    url={gift.grantLetterUrl ?? null}
                    filename={gift.grantLetterFilename ?? null}
                    uploadLabel="Upload grant letter"
                    toastTitle="Grant letter uploaded"
                    testIdBase="gift-grant-letter"
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
                {gift.opportunityId && pledgeGrantLetterUrl ? (
                  <Row label="Pledge grant letter">
                    <a
                      href={pledgeGrantLetterUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline truncate max-w-[240px]"
                      data-testid="gift-pledge-grant-letter-link"
                    >
                      {linkedPledge.data?.grantLetterFilename ??
                        "View pledge letter"}
                    </a>
                  </Row>
                ) : null}
                {gift.codingForm ? (
                  <Row label="Coding form">
                    <Link
                      href="/coding-form-import"
                      className="text-primary hover:underline"
                      data-testid="gift-coding-form-link"
                    >
                      View coding form
                    </Link>
                  </Row>
                ) : null}
                {gift.donorbox ? (
                  <Row label="Donorbox donation">
                    <a
                      href={`https://donorbox.org/admin#/donations?id=${gift.donorbox.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline font-mono text-sm"
                      data-testid="gift-donorbox-link"
                    >
                      #{gift.donorbox.id}
                    </a>
                  </Row>
                ) : null}
              </div>
            </FieldCard>

            <FieldCard title="Other details" defaultOpen={false}>
              <div className="space-y-4">
                <Row label="Tags">
                  <InlineEditText
                    label="Tags"
                    testIdBase="gift-tags"
                    value={gift.tags ?? null}
                    placeholder="Comma-separated tags"
                    display={gift.tags ?? "—"}
                    onSave={(next) => patch({ tags: next })}
                  />
                </Row>
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    Details
                  </div>
                  <InlineEditTextarea
                    label="Details"
                    testIdBase="gift-details"
                    value={gift.details ?? null}
                    placeholder="Add details…"
                    display={
                      gift.details ? (
                        <p className="whitespace-pre-wrap text-left">
                          {gift.details}
                        </p>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )
                    }
                    onSave={(next) => patch({ details: next })}
                  />
                </div>
              </div>
            </FieldCard>

            <GiftStripeChainCard giftId={gift.id} />

            <div className="px-1 text-xs text-muted-foreground">
              Created {formatDate(gift.createdAt)} • Updated{" "}
              {formatDate(gift.updatedAt)}
            </div>
          </>
        }
        center={
          // Activity is scoped to the gift's donor (interactions/email/calendar/
          // meetings only link to a person/funder/household); notes link to the
          // gift itself. The Tasks card sits above the activity feed, which hides
          // tasks to avoid duplication.
          (() => {
            const giftPersonIds: string[] = [];
            if (gift.individualGiverPersonId)
              giftPersonIds.push(gift.individualGiverPersonId);
            if (
              gift.primaryContactPersonId &&
              gift.primaryContactPersonId !== gift.individualGiverPersonId
            ) {
              giftPersonIds.push(gift.primaryContactPersonId);
            }
            const giftDefaultLinks: Partial<{
              personIds: string[];
              organizationIds: string[];
              householdIds: string[];
              opportunityIds: string[];
              giftIds: string[];
            }> = {
              ...(gift.organizationId
                ? { organizationIds: [gift.organizationId] }
                : {}),
              ...(gift.householdId ? { householdIds: [gift.householdId] } : {}),
              ...(giftPersonIds.length > 0 ? { personIds: giftPersonIds } : {}),
              ...(gift.opportunityId
                ? { opportunityIds: [gift.opportunityId] }
                : {}),
            };
            return (
              <>
                <TasksPanel giftId={gift.id} defaultLinks={giftDefaultLinks} />
                <UnifiedActivityFeed
                  organizationId={gift.organizationId ?? undefined}
                  personId={gift.individualGiverPersonId ?? undefined}
                  householdId={gift.householdId ?? undefined}
                  notesContext={{
                    giftId: gift.id,
                    defaultLinks: giftDefaultLinks,
                  }}
                  hideTasks
                />
              </>
            );
          })()
        }
        right={
          <>
            <RelatedCard
              title="People"
              count={associatedPeople.length || undefined}
              empty={
                funderDetail.isLoading ||
                householdDetail.isLoading ||
                intermediaryDetail.isLoading
                  ? undefined
                  : !gift.advisorPersonId &&
                    !gift.primaryContactPersonId &&
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
                <Row label="Advisor">
                  <InlineEditPersonPicker
                    testIdBase="gift-advisor"
                    value={gift.advisorPersonId ?? null}
                    display={advisorDisplay}
                    onSave={(next) => patch({ advisorPersonId: next })}
                  />
                </Row>
                <Row label="Primary contact">
                  <InlineEditPersonPicker
                    testIdBase="gift-primary-contact"
                    value={gift.primaryContactPersonId ?? null}
                    display={primaryContactDisplay}
                    onSave={(next) => patch({ primaryContactPersonId: next })}
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
                        data-testid={`row-gift-person-${role.personId}`}
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

            <RelatedCard
              title={
                linkedRecordIsPledge
                  ? "Linked pledge"
                  : "Originating opportunity"
              }
              empty={!gift.opportunityId}
            >
              {gift.opportunityId ? (
                <RelatedRow
                  name={
                    linkedPledge.data?.name ??
                    `${linkedRecordIsPledge ? "Pledge" : "Opportunity"} ${gift.opportunityId}`
                  }
                  href={
                    linkedRecordIsPledge
                      ? `/pledges/${gift.opportunityId}`
                      : `/opportunities/${gift.opportunityId}`
                  }
                  tone="primary"
                  sub={
                    linkedRecordIsPledge
                      ? "This gift is a payment on the pledge. Use Actions for corrections."
                      : "This stand-alone gift completed the originating opportunity."
                  }
                />
              ) : (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  This is a stand-alone gift with no originating opportunity.
                </p>
              )}
            </RelatedCard>

            <RelatedCard
              title="Matching gift"
              empty={false}
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => setMatchOpen(true)}
                >
                  {gift.giftBeingMatchedId ? "Change" : "Link a gift"}
                </Button>
              }
            >
              {gift.giftBeingMatchedId ? (
                <div className="space-y-1">
                  <RelatedRow
                    name={
                      matchedGiftQ.data
                        ? giftRowDonorName(matchedGiftQ.data)
                        : "Matching gift"
                    }
                    href={`/gifts/${gift.giftBeingMatchedId}`}
                    tone="primary"
                    sub={
                      matchedGiftQ.data
                        ? [
                            matchedGiftQ.data.dateReceived
                              ? formatDate(matchedGiftQ.data.dateReceived)
                              : null,
                            matchedGiftQ.data.name,
                          ]
                            .filter(Boolean)
                            .join(" · ") || undefined
                        : gift.giftBeingMatchedId
                    }
                    amount={
                      matchedGiftQ.data
                        ? formatCurrency(matchedGiftQ.data.amount ?? "0")
                        : undefined
                    }
                  />
                  <button
                    type="button"
                    className="px-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => patch({ giftBeingMatchedId: null })}
                  >
                    Clear matching gift
                  </button>
                </div>
              ) : (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  Not matching another gift. Link the gift this one matches —
                  e.g. a corporate match → the employee&apos;s original gift.
                </p>
              )}
            </RelatedCard>
          </>
        }
      />
      <SplitGiftIntoPledgeDialog
        open={splitOpen}
        onOpenChange={setSplitOpen}
        gift={gift}
        onDone={(pledgeId) => navigate(`/pledges/${pledgeId}`)}
      />
      <BookSurplusGiftDialog
        open={surplusOpen}
        onOpenChange={setSurplusOpen}
        gift={gift}
        onDone={(giftId) => navigate(`/gifts/${giftId}`)}
      />
      <GiftSearchDialog
        open={matchOpen}
        onOpenChange={setMatchOpen}
        excludeGiftId={gift.id}
        title="Link a matching gift"
        description="Find the gift this one matches — e.g. a corporate match → the employee's original gift."
        footnote="This records that this gift matches the chosen gift. It does not move any money."
        onPick={(g) => {
          patch({ giftBeingMatchedId: g.id });
          setMatchOpen(false);
        }}
      />
      <GiftSearchDialog
        open={mergeSearchOpen}
        onOpenChange={setMergeSearchOpen}
        excludeGiftId={gift.id}
        title="Merge with another gift"
        description="Choose the duplicate or mis-split gift to combine with this one."
        footnote="Admin data-cleanup action. You will choose which gift survives before anything changes."
        onPick={(candidate) => {
          setMergeCandidateId(candidate.id);
          setMergeSearchOpen(false);
          setMergeDialogOpen(true);
        }}
      />
    </>
  );
}

const RECON_CHAIN_LABEL: Record<StripePayoutReconciliationStatus, string> = {
  unmatched: "Not yet matched to a QuickBooks deposit",
  confirmed_reconciled:
    "Reconciled — Stripe charges are the record; QuickBooks deposit kept",
};

/**
 * Read-only Stripe→QuickBooks provenance for a gift: the charge it was minted
 * from (or linked to) → the payout that charge settled in → the QB deposit lump
 * that payout reconciles against. Renders nothing for non-Stripe gifts so they
 * aren't cluttered with an empty card.
 */
function GiftStripeChainCard({ giftId }: { giftId: string }) {
  const { data } = useGetGiftStripeChain(giftId);
  const charge = data?.charge;
  if (!charge) return null;
  const payout = data?.payout ?? null;
  const deposit = data?.qbDeposit ?? null;

  return (
    <FieldCard title="Stripe → QuickBooks chain" defaultOpen={false}>
      <div className="space-y-4">
        <Row label="Stripe charge">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{charge.id}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {charge.linkage === "created" ? "Minted here" : "Linked"}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              Gross {formatCurrency(charge.grossAmount)} · fee{" "}
              {formatCurrency(charge.feeAmount)} · net{" "}
              {formatCurrency(charge.netAmount)}
              {charge.dateReceived
                ? ` · ${formatDate(charge.dateReceived)}`
                : ""}
            </div>
          </div>
        </Row>

        <Row label="Settled in payout">
          {payout ? (
            <div className="space-y-1">
              <div className="font-mono text-xs">{payout.id}</div>
              <div className="text-xs text-muted-foreground">
                {formatCurrency(payout.amount)} ·{" "}
                {payout.arrivalDate ? formatDate(payout.arrivalDate) : "—"}
              </div>
              <div className="text-xs">
                {RECON_CHAIN_LABEL[payout.reconciliationStatus]}
              </div>
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">
              Not yet paid out
            </span>
          )}
        </Row>

        {deposit ? (
          <Row label="QuickBooks deposit">
            <div className="space-y-1">
              <div className="font-mono text-xs">{deposit.id}</div>
              <div className="text-xs text-muted-foreground">
                {formatCurrency(deposit.amount)}
                {deposit.dateReceived
                  ? ` · ${formatDate(deposit.dateReceived)}`
                  : ""}
                {deposit.payerName ? ` · ${deposit.payerName}` : ""}
                {deposit.status ? ` · ${deposit.status}` : ""}
              </div>
            </div>
          </Row>
        ) : null}
      </div>
    </FieldCard>
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

const QB_LINK_TYPE_LABELS: Record<
  GiftAuditReconciliationRecord["linkType"],
  string
> = {
  matched: "Matched",
  created: "Created",
  split: "Split",
};

// One consolidated "Payments & reconciliation" card: over-payment / audit-close
// links and the QuickBooks record(s) the gift appears in — split into COUNTED
// cash-application evidence (the money trail) and CORROBORATING audit-only rows
// (e.g. a coarse QB deposit line that corroborates a Stripe-settled gift; never
// summed). The sub-tables are the single source of truth for match state here:
// records present = matched, empty = not matched (the derived tie/lane statuses
// still power the workbench and list filters, just not this card). Off-books
// gifts legitimately carry no QuickBooks records — they get a muted empty
// message, not an error.
function GiftPaymentsReconciliationCard({
  gift,
}: {
  gift: GiftOrPaymentDetail;
}) {
  const { data, isLoading } = useGetGiftAuditReconciliation(gift.id, {
    query: {
      queryKey: getGetGiftAuditReconciliationQueryKey(gift.id),
      enabled: !!gift.id,
    },
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Finance/admin gate for unlinking a payment. The server enforces with a
  // 403 finance_role_required; this only labels the disabled button (blocked
  // actions are shown disabled with the reason, never hidden).
  const viewerRole = useGetCurrentUser().data?.role;
  const viewerIsFinance = viewerRole === "finance" || viewerRole === "admin";
  const untie = useUntieGiftPaymentUnit({
    mutation: {
      onSuccess: async () => {
        toast({
          title: "Payment evidence unlinked",
          description:
            "The payment is now available to link from another gift or pledge record.",
        });
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getGetGiftAuditReconciliationQueryKey(gift.id),
          }),
          queryClient.invalidateQueries({
            queryKey: getGetGiftOrPaymentQueryKey(gift.id),
          }),
          queryClient.invalidateQueries({
            queryKey: getListGiftsAndPaymentsQueryKey(),
          }),
          gift.opportunityId
            ? queryClient.invalidateQueries({
                queryKey: getGetOpportunityOrPledgeQueryKey(gift.opportunityId),
              })
            : Promise.resolve(),
        ]);
      },
      onError: (error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Failed to unlink payment";
        toast({
          title: "Could not unlink payment",
          description: message,
          variant: "destructive",
        });
      },
    },
  });

  const counted = data?.quickbooksRecords ?? [];
  const corroborating = data?.corroboratingRecords ?? [];

  return (
    <FieldCard title="Payment evidence">
      {isLoading ? (
        <div className="space-y-2" data-testid="gift-qb-payments-loading">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          {gift.auditClose.resolvedByGiftId || gift.overpayOfGiftId ? (
            <div className="space-y-1">
              {gift.auditClose.resolvedByGiftId ? (
                <Row label="Over-payment">
                  <Link
                    href={`/gifts/${gift.auditClose.resolvedByGiftId}`}
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    data-testid="link-surplus-gift"
                  >
                    Over-payment resolved via a linked gift →
                  </Link>
                </Row>
              ) : null}
              {gift.overpayOfGiftId ? (
                <Row label="Over-payment of">
                  <Link
                    href={`/gifts/${gift.overpayOfGiftId}`}
                    className="text-sm underline-offset-2 hover:underline"
                    data-testid="link-original-gift"
                  >
                    Original gift →
                  </Link>
                </Row>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              Counted QuickBooks payments
            </div>
            {counted.length === 0 ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="gift-qb-payments-empty"
              >
                No linked QuickBooks payments
              </p>
            ) : (
              <div className="space-y-2" data-testid="gift-qb-payments-list">
                {counted.map((record) => (
                  <QbRecordRow
                    key={record.paymentUnitId ?? record.stagedPaymentId}
                    record={record}
                    viewerIsFinance={viewerIsFinance}
                    unlinking={untie.isPending}
                    onUnlink={
                      record.paymentUnitId
                        ? () =>
                            untie.mutateAsync({
                              id: gift.id,
                              unitId: record.paymentUnitId!,
                            })
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
          </div>

          {corroborating.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                Corroborating evidence (audit only)
              </div>
              <div
                className="space-y-2"
                data-testid="gift-qb-corroborating-list"
              >
                {corroborating.map((record) => (
                  <QbRecordRow
                    key={record.stagedPaymentId}
                    record={record}
                    corroborating
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </FieldCard>
  );
}

// A single payment record row inside the Payment evidence card.
// Corroborating rows carry no counted amount (amount is always null server-side)
// so they render an "Audit only" chip instead of a currency figure. Counted
// rows with a payment-unit target expose a finance-gated Unlink action
// (disabled with the reason for non-finance viewers — never hidden).
function QbRecordRow({
  record,
  corroborating,
  viewerIsFinance,
  unlinking,
  onUnlink,
}: {
  record: GiftAuditReconciliationRecord;
  corroborating?: boolean;
  viewerIsFinance?: boolean;
  unlinking?: boolean;
  onUnlink?: () => Promise<unknown>;
}) {
  const isCreated = record.linkType === "created";
  return (
    <div
      className="rounded-md border px-3 py-2"
      data-testid={`gift-qb-payment-${record.stagedPaymentId ?? record.paymentUnitId}`}
    >
      <div className="flex items-center justify-between gap-2">
        <Badge variant="secondary">
          {QB_LINK_TYPE_LABELS[record.linkType]}
        </Badge>
        {corroborating || record.amount == null ? (
          <span className="text-xs text-muted-foreground">Audit only</span>
        ) : (
          <span className="text-sm font-semibold tabular-nums">
            {formatCurrency(record.amount)}
          </span>
        )}
      </div>
      <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        <div>Doc #: {record.qbDocNumber || "—"}</div>
        <div>Deposit to: {record.qbDepositToAccountName || "—"}</div>
        <div>Received: {formatDate(record.dateReceived)}</div>
      </div>
      {onUnlink ? (
        <div className="mt-2 flex justify-end">
          <ConfirmDeleteDialog
            title="Unlink this payment?"
            description={
              (isCreated
                ? "This payment originally created this gift. Unlinking removes only the evidence link — the gift record stays and will show as missing payment evidence. The payment becomes available to link from another record. "
                : "This removes only the link between this payment and this gift. The payment and its bank/QuickBooks evidence are untouched and become available to link from another record. ") +
              "Pledge payment coverage will be recalculated."
            }
            confirmLabel="Unlink payment"
            busyLabel="Unlinking…"
            destructive={false}
            onConfirm={onUnlink}
            confirmTestId={`confirm-unlink-payment-${record.paymentUnitId}`}
            trigger={
              <Button
                variant="outline"
                size="sm"
                disabled={!viewerIsFinance || unlinking}
                data-testid={`button-unlink-payment-${record.paymentUnitId}`}
              >
                Unlink
                {!viewerIsFinance ? " (finance role required)" : ""}
              </Button>
            }
          />
        </div>
      ) : null}
    </div>
  );
}
