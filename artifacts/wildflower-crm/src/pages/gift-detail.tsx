import { useState, type ReactNode } from "react";
import { DetailSkeleton, Skeleton } from "@/components/ui/skeleton";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetGiftOrPayment,
  useUpdateGiftOrPayment,
  useArchiveGiftOrPayment,
  useGetOrganization,
  useGetHousehold,
  useGetPaymentIntermediary,
  useGetGiftStripeChain,
  useGetGiftAuditReconciliation,
  useGetOpportunityOrPledge,
  getGetOpportunityOrPledgeQueryKey,
  getGetGiftOrPaymentQueryKey,
  getGetOrganizationQueryKey,
  getGetHouseholdQueryKey,
  getGetPaymentIntermediaryQueryKey,
  getGetGiftAuditReconciliationQueryKey,
  getListGiftsAndPaymentsQueryKey,
  type GiftOrPaymentDetail,
  type UpdateGiftOrPaymentBody,
  type GiftType,
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
import { SplitGiftIntoPledgeDialog } from "@/components/gift-merge-dialogs";
import { BookSurplusGiftDialog } from "@/components/audit-close-dialogs";
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
  InlineEditIntermediaryPicker,
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
import { GiftPledgeLink, type PledgeDonorScope } from "@/components/pledge-picker";
import { FileUploadField } from "@/components/grant-letter-upload";
import { DonorboxEnrichmentPanel } from "@/components/donorbox-enrichment-panel";
import {
  GiftSearchDialog,
  giftDonorName as giftRowDonorName,
} from "@/components/gift-search-dialog";
import { laneBadges } from "@/lib/reconciliation";
import { type ReconciliationLanes } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { NeedsResearchBadge } from "@/components/needs-research-badge";

const GIFT_TYPE_OPTIONS = [
  { value: "standard_gift", label: "Standard gift" },
  { value: "pledge_payment", label: "Pledge payment" },
  { value: "directed_gift", label: "Directed gift" },
  { value: "loan_fund_investment", label: "Loan fund investment" },
  { value: "matching_gift", label: "Matching gift" },
] as const satisfies ReadonlyArray<InlineSelectOption<GiftType>>;

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
        <Link href="/gifts" className="text-sm text-primary hover:underline">← Back to gifts</Link>
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
  const [splitOpen, setSplitOpen] = useState(false);
  const [surplusOpen, setSurplusOpen] = useState(false);
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
  const userNames = useUserNameMap();
  const ownerDisplay = gift.ownerUserId
    ? (userNames.get(gift.ownerUserId) ?? gift.ownerUserId)
    : "—";
  const organizationName = useOrganizationName(gift.organizationId ?? null);
  const giverName = usePersonName(gift.individualGiverPersonId ?? null);
  const householdName = useHouseholdName(gift.householdId ?? null);
  const advisorName = usePersonName(gift.advisorPersonId ?? null);
  const primaryContactName = usePersonName(gift.primaryContactPersonId ?? null);
  const intermediaryName = useIntermediaryName(gift.paymentIntermediaryId ?? null);

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
  const intermediaryDetail = useGetPaymentIntermediary(gift.paymentIntermediaryId ?? "", {
    query: {
      queryKey: getGetPaymentIntermediaryQueryKey(gift.paymentIntermediaryId ?? ""),
      enabled: !!gift.paymentIntermediaryId,
    },
  });

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

  // Donor is rendered two ways: the header subtitle keeps a type prefix
  // ("Funder:"/"Individual:"/"Household:") for at-a-glance context, while the
  // Donor card omits the prefix (the card already labels the row "Donor") — see
  // donorDisplayPlain below.
  const noDonor: ReactNode = (
    <span className="text-muted-foreground">No donor linked.</span>
  );
  let donorLink: ReactNode = null;
  let donorPrefix: string | null = null;
  if (gift.organizationId) {
    donorPrefix = "Funder";
    donorLink = (
      <Link
        href={`/organizations/${gift.organizationId}`}
        className="text-primary hover:underline"
      >
        {organizationName ?? gift.organizationId}
      </Link>
    );
  } else if (gift.individualGiverPersonId) {
    donorPrefix = "Individual";
    donorLink = (
      <Link
        href={`/individuals/${gift.individualGiverPersonId}`}
        className="text-primary hover:underline"
      >
        {giverName ?? gift.individualGiverPersonId}
      </Link>
    );
  } else if (gift.householdId) {
    donorPrefix = "Household";
    donorLink = (
      <Link
        href={`/households/${gift.householdId}`}
        className="text-primary hover:underline"
      >
        {householdName ?? gift.householdId}
      </Link>
    );
  }

  const donorDisplay: ReactNode = donorLink ? (
    <span>
      <span className="text-muted-foreground mr-1">{donorPrefix}:</span>
      {donorLink}
    </span>
  ) : (
    noDonor
  );
  const donorDisplayPlain: ReactNode = donorLink ?? noDonor;

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
  const intermediaryDisplay: ReactNode = gift.paymentIntermediaryId
    ? (intermediaryName ?? gift.paymentIntermediaryId)
    : "—";

  const update = useUpdateGiftOrPayment({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetGiftOrPaymentQueryKey(gift.id) }),
          queryClient.invalidateQueries({ queryKey: getListGiftsAndPaymentsQueryKey() }),
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
        await queryClient.invalidateQueries({ queryKey: getListGiftsAndPaymentsQueryKey() });
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

  function patch(body: UpdateGiftOrPaymentBody) {
    return update.mutateAsync({ id: gift.id, data: body });
  }

  // The donor is one of (funder, individual giver, household), DB-enforced XOR.
  // The two-step InlineEditDonor control emits all three FK fields with the
  // non-selected ones nulled, so exactly one stays populated on save.
  // Changing the donor also clears any linked pledge: the pledge picker is
  // donor-scoped, so a payment must stay on a pledge belonging to its donor —
  // keeping a stale link would point the gift at a different donor's pledge.
  const saveDonor = (body: DonorSaveBody) =>
    patch({ ...body, opportunityId: null });

  async function saveName() {
    const trimmed = nameValue.trim();
    if (trimmed === (gift.name ?? "")) {
      setEditingName(false);
      return;
    }
    await patch({ name: trimmed || null });
    setEditingName(false);
  }

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
      <Button
        variant="outline"
        size="sm"
        className={EDIT_PENCIL_REVEAL}
        onClick={() => setEditingName(true)}
        data-testid="button-edit-gift-name"
      >
        Edit name
      </Button>
      {(gift.allocations?.length ?? 0) >= 2 && gift.opportunityId == null ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSplitOpen(true)}
          data-testid="button-split-gift-into-pledge"
        >
          Split into pledge
        </Button>
      ) : null}
      {gift.auditClose.frozen &&
      Number(gift.auditClose.overpaySurplus) > 0 &&
      !gift.auditClose.resolvedByGiftId &&
      !gift.overpayOfGiftId ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSurplusOpen(true)}
          data-testid="button-book-surplus-gift"
        >
          Book surplus gift
        </Button>
      ) : null}
      <FlagForResearchDialog
        targetType="gift"
        targetId={gift.id}
        recordLabel={gift.name ?? "this gift"}
        triggerTestId="button-flag-research-gift"
      />
      <ConfirmDeleteDialog
        title="Archive this gift?"
        description="It will be hidden from lists. An admin can restore it from the archived view."
        confirmLabel="Archive"
        triggerLabel="Archive"
        busyLabel="Archiving…"
        destructive={false}
        onConfirm={() => archive.mutateAsync({ id: gift.id })}
        disabled={archive.isPending}
        triggerTestId="button-archive-gift"
        confirmTestId="button-confirm-archive-gift"
      />
    </>
  );

  const fyDisplay =
    gift.grantYears && gift.grantYears.length > 0
      ? gift.grantYears.join(", ")
      : (gift.grantYear ?? "—");

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
            <span className="font-bold text-primary">{formatCurrency(gift.amount)}</span>
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
        <InlineEditSelect
          align="left"
          label="Type"
          testIdBase="gift-type"
          value={gift.type ?? null}
          options={GIFT_TYPE_OPTIONS}
          display={formatEnum(gift.type) || "—"}
          onSave={(next) => patch({ type: next })}
        />
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
  // A gift's donor (DB-enforced XOR) scopes the pledge picker so you can only
  // link a payment to one of that donor's opportunities/pledges.
  const pledgeDonorScope: PledgeDonorScope = gift.organizationId
    ? { organizationId: gift.organizationId }
    : gift.householdId
      ? { householdId: gift.householdId }
      : gift.individualGiverPersonId
        ? { individualGiverPersonId: gift.individualGiverPersonId }
        : null;

  return (
    <>
    <RecordLayout
      backHref="/gifts"
      backLabel="Back to gifts"
      title={title}
      typeBadge="Gift"
      headerBadges={<NeedsResearchBadge flagged={gift.flaggedForResearch} />}
      subtitle={donorDisplay}
      actions={actions}
      highlights={highlights}
      left={
        <>
          {gift.reimbursablePlaceholderWarning ? (
            <div
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
              data-testid="warning-reimbursable-placeholder"
            >
              This gift looks like a <strong>full-award placeholder</strong> on a
              reimbursable grant, with no linked QuickBooks or Stripe payment. A
              reimbursable grant is a pledge paid as individual reimbursement
              checks — book each real check as its own 1:1 payment rather than
              one gift for the whole awarded amount.
            </div>
          ) : null}
          <FieldCard title="Classification">
            <div className="space-y-1">
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
                    {linkedPledge.data?.grantLetterFilename ?? "View pledge letter"}
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
                <div className="text-xs font-medium text-muted-foreground mb-1">Details</div>
                <InlineEditTextarea
                  label="Details"
                  testIdBase="gift-details"
                  value={gift.details ?? null}
                  placeholder="Add details…"
                  display={
                    gift.details ? (
                      <p className="whitespace-pre-wrap text-left">{gift.details}</p>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )
                  }
                  onSave={(next) => patch({ details: next })}
                />
              </div>
            </div>
          </FieldCard>

          {gift.codingFormCircle ||
          gift.codingFormSeries ||
          gift.codingFormAdditionalNotes ||
          gift.codingFormMemo ? (
            <FieldCard title="Coding form reference" defaultOpen={false}>
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  Raw values copied from the donation coding form, kept for
                  reference only.
                </p>
                {gift.codingFormCircle ? (
                  <Row label="Circle / coding">
                    <span className="text-sm">{gift.codingFormCircle}</span>
                  </Row>
                ) : null}
                {gift.codingFormSeries ? (
                  <Row label="Stand-alone vs multi-series">
                    <span className="text-sm">{gift.codingFormSeries}</span>
                  </Row>
                ) : null}
                {gift.codingFormAdditionalNotes ? (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      Additional notes
                    </div>
                    <p className="whitespace-pre-wrap text-left text-sm">
                      {gift.codingFormAdditionalNotes}
                    </p>
                  </div>
                ) : null}
                {gift.codingFormMemo ? (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      Internal memo
                    </div>
                    <p className="whitespace-pre-wrap text-left text-sm">
                      {gift.codingFormMemo}
                    </p>
                  </div>
                ) : null}
              </div>
            </FieldCard>
          ) : null}

          <GiftStripeChainCard giftId={gift.id} />

          <div className="px-1 text-xs text-muted-foreground">
            Created {formatDate(gift.createdAt)} • Updated {formatDate(gift.updatedAt)}
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
          if (gift.individualGiverPersonId) giftPersonIds.push(gift.individualGiverPersonId);
          if (gift.primaryContactPersonId && gift.primaryContactPersonId !== gift.individualGiverPersonId) {
            giftPersonIds.push(gift.primaryContactPersonId);
          }
          const giftDefaultLinks: Partial<{ personIds: string[]; organizationIds: string[]; householdIds: string[]; opportunityIds: string[]; giftIds: string[] }> = {
            ...(gift.organizationId ? { organizationIds: [gift.organizationId] } : {}),
            ...(gift.householdId ? { householdIds: [gift.householdId] } : {}),
            ...(giftPersonIds.length > 0 ? { personIds: giftPersonIds } : {}),
            ...(gift.opportunityId ? { opportunityIds: [gift.opportunityId] } : {}),
          };
          return (
            <>
              <TasksPanel giftId={gift.id} defaultLinks={giftDefaultLinks} />
              <UnifiedActivityFeed
                organizationId={gift.organizationId ?? undefined}
                personId={gift.individualGiverPersonId ?? undefined}
                householdId={gift.householdId ?? undefined}
                notesContext={{ giftId: gift.id, defaultLinks: giftDefaultLinks }}
                hideTasks
              />
            </>
          );
        })()
      }
      right={
        <>
          <RelatedCard title="Donor">
            <div className="space-y-1 px-2 py-1">
              <Row label="Donor">
                <InlineEditDonor
                  testIdBase="gift-donor"
                  value={{
                    organizationId: gift.organizationId ?? null,
                    individualGiverPersonId:
                      gift.individualGiverPersonId ?? null,
                    householdId: gift.householdId ?? null,
                  }}
                  display={donorDisplayPlain}
                  onSave={saveDonor}
                />
              </Row>
              <Row label="Payment intermediary">
                <InlineEditIntermediaryPicker
                  testIdBase="gift-intermediary"
                  value={gift.paymentIntermediaryId ?? null}
                  display={intermediaryDisplay}
                  onSave={(next) => patch({ paymentIntermediaryId: next })}
                />
              </Row>
            </div>
          </RelatedCard>

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
                <div className="px-3 py-1 text-xs font-medium text-muted-foreground">
                  Associated contacts
                </div>
                {visibleAssociatedPeople.map((role) => {
                  const subtitle =
                    role.externalTitleOrRole ??
                    (role.connection ? formatEnum(role.connection) : null);
                  const roleLabel =
                    [subtitle, role.personEmail].filter(Boolean).join(" · ") || undefined;
                  return (
                    <div key={role.id} data-testid={`row-gift-person-${role.personId}`}>
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

          <RelatedCard title="Linked pledges" empty={!gift.opportunityId}>
            <GiftPledgeLink
              value={gift.opportunityId ?? null}
              scope={pledgeDonorScope}
              onSave={(next) => patch({ opportunityId: next })}
            />
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
                Not matching another gift. Link the gift this one matches — e.g.
                a corporate match → the employee&apos;s original gift.
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
    </>
  );
}

const RECON_CHAIN_LABEL: Record<StripePayoutReconciliationStatus, string> = {
  unmatched: "Not yet matched to a QuickBooks deposit",
  proposed: "Proposed — awaiting confirm",
  conflict_approved: "Conflict — needs a keep/replace decision",
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
              {charge.dateReceived ? ` · ${formatDate(charge.dateReceived)}` : ""}
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
              <Link
                href="/reconciliation-workbench?queue=bundle"
                className="text-xs underline-offset-2 hover:underline"
              >
                View reconciliation queue →
              </Link>
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">Not yet paid out</span>
          )}
        </Row>

        {deposit ? (
          <Row label="QuickBooks deposit">
            <div className="space-y-1">
              <div className="font-mono text-xs">{deposit.id}</div>
              <div className="text-xs text-muted-foreground">
                {formatCurrency(deposit.amount)}
                {deposit.dateReceived ? ` · ${formatDate(deposit.dateReceived)}` : ""}
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
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
  group: "Deposit group",
  split: "Split",
};

// One consolidated "Payments & reconciliation" card: the gift's QuickBooks tie
// (Missing flagged), two-lane reconciliation status, over-payment / audit-close
// links, and the QuickBooks record(s) it appears in — split into COUNTED
// cash-application evidence (the money trail) and CORROBORATING audit-only rows
// (e.g. a coarse QB deposit line that corroborates a Stripe-settled gift; never
// summed). Off-books gifts legitimately carry no QuickBooks records — they get a
// muted empty message, not an error.
function GiftPaymentsReconciliationCard({ gift }: { gift: GiftOrPaymentDetail }) {
  const { data, isLoading } = useGetGiftAuditReconciliation(gift.id, {
    query: {
      queryKey: getGetGiftAuditReconciliationQueryKey(gift.id),
      enabled: !!gift.id,
    },
  });

  const counted = data?.quickbooksRecords ?? [];
  const corroborating = data?.corroboratingRecords ?? [];

  return (
    <FieldCard title="Payments & reconciliation">
      {isLoading ? (
        <div className="space-y-2" data-testid="gift-qb-payments-loading">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1">
            <Row label="QuickBooks tie">
              <div className="flex flex-col items-end gap-1">
                <GiftQbTieBadge
                  status={data?.quickbooksTieStatus ?? gift.quickbooksTieStatus}
                />
                {gift.auditClose.resolvedByGiftId ? (
                  <Link
                    href={`/gifts/${gift.auditClose.resolvedByGiftId}`}
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    data-testid="link-surplus-gift"
                  >
                    Over-payment resolved via a linked gift →
                  </Link>
                ) : null}
              </div>
            </Row>
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
            <Row label="Reconciliation">
              <ReconciliationLaneBadges
                lanes={data?.reconciliationLanes ?? gift.reconciliationLanes}
              />
            </Row>
            <Row label="Off-books">{data?.offBooks ? "Yes" : "No"}</Row>
            {data?.amount != null ? (
              <Row label="Audit amount">{formatCurrency(data.amount)}</Row>
            ) : null}
          </div>

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
                  <QbRecordRow key={record.stagedPaymentId} record={record} />
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

// A single QuickBooks record row inside the Payments & reconciliation card.
// Corroborating rows carry no counted amount (amount is always null server-side)
// so they render an "Audit only" chip instead of a currency figure.
function QbRecordRow({
  record,
  corroborating,
}: {
  record: GiftAuditReconciliationRecord;
  corroborating?: boolean;
}) {
  return (
    <div
      className="rounded-md border px-3 py-2"
      data-testid={`gift-qb-payment-${record.stagedPaymentId}`}
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
    </div>
  );
}

// Read-only display of the persisted, server-derived QuickBooks tie status.
// `exempt`/`tied` are healthy; `amount_mismatch`/`missing` flag on-books gifts
// that don't reconcile to QuickBooks and need a human's attention.
function GiftQbTieBadge({
  status,
}: {
  status: "exempt" | "tied" | "amount_mismatch" | "missing" | null | undefined;
}) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const variant =
    status === "tied"
      ? "default"
      : status === "exempt"
        ? "secondary"
        : "destructive";
  const label =
    status === "amount_mismatch" ? "Amount mismatch" : formatEnum(status);
  return (
    <Badge variant={variant} data-testid="gift-qb-tie-status">
      {label}
    </Badge>
  );
}

// Two-lane reconciliation status (INV-4): the funding (accounting/evidence) lane
// and the CRM-record (donor) lane, shown as separate badges instead of one
// blended status. Both are server-derived and read-only.
function ReconciliationLaneBadges({
  lanes,
}: {
  lanes: ReconciliationLanes | null | undefined;
}) {
  const badges = laneBadges(lanes);
  if (badges.length === 0)
    return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="gift-reconciliation-lanes">
      {badges.map((b) => (
        <Badge
          key={b.key}
          variant={b.variant}
          data-testid={`gift-reconciliation-lane-${b.key}`}
        >
          {b.label}
        </Badge>
      ))}
    </div>
  );
}
