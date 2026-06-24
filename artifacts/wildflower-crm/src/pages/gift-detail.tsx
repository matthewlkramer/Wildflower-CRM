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
import { EditPeopleEntityRoleDialog } from "@/components/add-role-dialogs";
import { GiftAllocationsEditor } from "@/components/allocation-editors";
import { UnifiedActivityFeed } from "@/components/unified-activity-feed";
import { ThankYouPanel } from "@/components/thank-you-panel";
import { TasksPanel } from "@/components/tasks-panel";
import { SplitGiftIntoPledgeDialog } from "@/components/gift-merge-dialogs";
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
import { DonorboxEnrichmentPanel } from "@/components/donorbox-enrichment-panel";
import { laneBadges } from "@/lib/reconciliation";
import { type ReconciliationLanes } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

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

  let donorDisplay: ReactNode = (
    <span className="text-muted-foreground">No donor linked.</span>
  );
  if (gift.organizationId) {
    donorDisplay = (
      <span>
        <span className="text-muted-foreground mr-1">Funder:</span>
        <Link
          href={`/organizations/${gift.organizationId}`}
          className="text-primary hover:underline"
        >
          {organizationName ?? gift.organizationId}
        </Link>
      </span>
    );
  } else if (gift.individualGiverPersonId) {
    donorDisplay = (
      <span>
        <span className="text-muted-foreground mr-1">Individual:</span>
        <Link
          href={`/individuals/${gift.individualGiverPersonId}`}
          className="text-primary hover:underline"
        >
          {giverName ?? gift.individualGiverPersonId}
        </Link>
      </span>
    );
  } else if (gift.householdId) {
    donorDisplay = (
      <span>
        <span className="text-muted-foreground mr-1">Household:</span>
        <Link
          href={`/households/${gift.householdId}`}
          className="text-primary hover:underline"
        >
          {householdName ?? gift.householdId}
        </Link>
      </span>
    );
  }

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
      subtitle={donorDisplay}
      actions={actions}
      highlights={highlights}
      left={
        <>
          <FieldCard title="Classification">
            <div className="space-y-1">
              <Row label="Designated to school">
                <InlineEditBoolean
                  label="Designated to school"
                  testIdBase="gift-designated-to-school"
                  value={gift.designatedToSchool}
                  allowNull={false}
                  display={gift.designatedToSchool ? "Yes" : "No"}
                  onSave={(next) => patch({ designatedToSchool: next ?? false })}
                />
              </Row>
              <Row label="Off-books fiscal sponsor">
                <InlineEditBoolean
                  label="Off-books fiscal sponsor"
                  testIdBase="gift-off-books-fiscal-sponsor"
                  value={gift.offBooksFiscalSponsor}
                  allowNull={false}
                  display={gift.offBooksFiscalSponsor ? "Yes" : "No"}
                  onSave={(next) =>
                    patch({ offBooksFiscalSponsor: next ?? false })
                  }
                />
              </Row>
              <Row label="Payment expected">
                <InlineEditBoolean
                  label="Payment expected"
                  testIdBase="gift-payment-expected"
                  value={gift.paymentExpected}
                  allowNull={false}
                  display={gift.paymentExpected ? "Yes" : "No"}
                  onSave={(next) => patch({ paymentExpected: next ?? true })}
                />
              </Row>
              <Row label="Counts toward goal">
                <InlineEditBoolean
                  label="Counts toward goal"
                  testIdBase="gift-counts-toward-goal"
                  value={gift.countsTowardGoal}
                  allowNull={false}
                  display={gift.countsTowardGoal ? "Yes" : "No"}
                  onSave={(next) => patch({ countsTowardGoal: next ?? true })}
                />
              </Row>
              <Row label="Needs research">
                <InlineEditBoolean
                  label="Needs research"
                  testIdBase="gift-needs-research"
                  value={gift.needsResearch}
                  allowNull={false}
                  display={gift.needsResearch ? "Yes" : "No"}
                  onSave={(next) => patch({ needsResearch: next ?? false })}
                />
              </Row>
              <Row label="QuickBooks tie">
                <GiftQbTieBadge status={gift.quickbooksTieStatus} />
              </Row>
              <Row label="Reconciliation">
                <ReconciliationLaneBadges lanes={gift.reconciliationLanes} />
              </Row>
            </div>
            {gift.donorbox && (
              <DonorboxEnrichmentPanel donorbox={gift.donorbox} />
            )}
          </FieldCard>

          <GiftQbPaymentsCard giftId={gift.id} />

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
                  display={donorDisplay}
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

          {gift.giftBeingMatchedId ? (
            <RelatedCard title="Related">
              <RelatedRow
                name="Matching gift"
                href={`/gifts/${gift.giftBeingMatchedId}`}
                tone="primary"
                sub={gift.giftBeingMatchedId}
              />
            </RelatedCard>
          ) : null}
        </>
      }
    />
    <SplitGiftIntoPledgeDialog
      open={splitOpen}
      onOpenChange={setSplitOpen}
      gift={gift}
      onDone={(pledgeId) => navigate(`/pledges/${pledgeId}`)}
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
  confirmed_excluded: "Deposit excluded as a processor payout",
  confirmed_keep: "Kept the existing QuickBooks gift",
  confirmed_replace: "Replaced — old QuickBooks gift archived",
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
                {RECON_CHAIN_LABEL[payout.qbReconciliationStatus]}
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

// Read-only audit view of the QuickBooks payment record(s) this gift is tied to,
// plus the key reconciliation summary fields, so it's clear at a glance what
// money records are attached. Off-books gifts (offBooks) legitimately carry no
// QuickBooks records — they get the muted empty message, not an error.
function GiftQbPaymentsCard({ giftId }: { giftId: string }) {
  const { data, isLoading } = useGetGiftAuditReconciliation(giftId, {
    query: {
      queryKey: getGetGiftAuditReconciliationQueryKey(giftId),
      enabled: !!giftId,
    },
  });

  const records = data?.quickbooksRecords ?? [];

  return (
    <FieldCard title="Linked QuickBooks payments">
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
              <GiftQbTieBadge status={data?.quickbooksTieStatus} />
            </Row>
            <Row label="Reconciliation">
              <ReconciliationLaneBadges lanes={data?.reconciliationLanes} />
            </Row>
            <Row label="Off-books">{data?.offBooks ? "Yes" : "No"}</Row>
            {data?.amount != null ? (
              <Row label="Audit amount">{formatCurrency(data.amount)}</Row>
            ) : null}
          </div>

          {records.length === 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="gift-qb-payments-empty"
            >
              No linked QuickBooks payments
            </p>
          ) : (
            <div className="space-y-2" data-testid="gift-qb-payments-list">
              {records.map((record) => (
                <div
                  key={record.stagedPaymentId}
                  className="rounded-md border px-3 py-2"
                  data-testid={`gift-qb-payment-${record.stagedPaymentId}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="secondary">
                      {QB_LINK_TYPE_LABELS[record.linkType]}
                    </Badge>
                    <span className="text-sm font-semibold tabular-nums">
                      {formatCurrency(record.amount)}
                    </span>
                  </div>
                  <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    <div>Doc #: {record.qbDocNumber || "—"}</div>
                    <div>Deposit to: {record.qbDepositToAccountName || "—"}</div>
                    <div>Received: {formatDate(record.dateReceived)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </FieldCard>
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
