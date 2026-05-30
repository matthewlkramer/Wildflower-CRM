import { useState, type ReactNode } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetGiftOrPayment,
  useUpdateGiftOrPayment,
  useDeleteGiftOrPayment,
  useGetFunder,
  useGetHousehold,
  useGetPaymentIntermediary,
  getGetGiftOrPaymentQueryKey,
  getGetFunderQueryKey,
  getGetHouseholdQueryKey,
  getGetPaymentIntermediaryQueryKey,
  getListGiftsAndPaymentsQueryKey,
  type GiftOrPaymentDetail,
  type UpdateGiftOrPaymentBody,
  type GiftType,
  type GiftPaymentMethod,
  type PeopleEntityRole,
} from "@workspace/api-client-react";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { GiftAllocationsEditor } from "@/components/allocation-editors";
import { UnifiedActivityFeed } from "@/components/unified-activity-feed";
import { ThankYouPanel } from "@/components/thank-you-panel";
import { TasksPanel } from "@/components/tasks-panel";
import {
  InlineEditBoolean,
  InlineEditCurrency,
  InlineEditDate,
  InlineEditSelect,
  InlineEditText,
  InlineEditTextarea,
  type InlineSelectOption,
} from "@/components/inline-edit";
import { InlineEditUserPicker, useUserNameMap } from "@/components/user-picker";
import {
  InlineEditPersonPicker,
  InlineEditFunderPicker,
  InlineEditHouseholdPicker,
  InlineEditIntermediaryPicker,
  usePersonName,
  useFunderName,
  useHouseholdName,
  useIntermediaryName,
} from "@/components/entity-picker";
import {
  RecordLayout,
  FieldCard,
  RelatedCard,
  RelatedRow,
  AffiliationRow,
  type Highlight,
} from "@/components/record-layout";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading…</div>;
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
  const userNames = useUserNameMap();
  const ownerDisplay = gift.ownerUserId
    ? (userNames.get(gift.ownerUserId) ?? gift.ownerUserId)
    : "—";
  const funderName = useFunderName(gift.funderId ?? null);
  const giverName = usePersonName(gift.individualGiverPersonId ?? null);
  const householdName = useHouseholdName(gift.householdId ?? null);
  const advisorName = usePersonName(gift.advisorPersonId ?? null);
  const intermediaryName = useIntermediaryName(gift.paymentIntermediaryId ?? null);

  // Fetch the linked entities so we can list the people associated with each
  // (donor org / household / payment intermediary) in the People card.
  const funderDetail = useGetFunder(gift.funderId ?? "", {
    query: {
      queryKey: getGetFunderQueryKey(gift.funderId ?? ""),
      enabled: !!gift.funderId,
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

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(gift.name ?? "");

  let donorDisplay: ReactNode = (
    <span className="text-muted-foreground">No donor linked.</span>
  );
  if (gift.funderId) {
    donorDisplay = (
      <span>
        <span className="text-muted-foreground mr-1">Funder:</span>
        <Link
          href={`/funding-entities/${gift.funderId}`}
          className="text-primary hover:underline"
        >
          {funderName ?? gift.funderId}
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

  const funderLinkDisplay: ReactNode = gift.funderId ? (
    <Link
      href={`/funding-entities/${gift.funderId}`}
      className="text-primary hover:underline"
    >
      {funderName ?? gift.funderId}
    </Link>
  ) : (
    "—"
  );
  const householdLinkDisplay: ReactNode = gift.householdId ? (
    <Link
      href={`/households/${gift.householdId}`}
      className="text-primary hover:underline"
    >
      {householdName ?? gift.householdId}
    </Link>
  ) : (
    "—"
  );
  const individualLinkDisplay: ReactNode = gift.individualGiverPersonId ? (
    <Link
      href={`/individuals/${gift.individualGiverPersonId}`}
      className="text-primary hover:underline"
    >
      {giverName ?? gift.individualGiverPersonId}
    </Link>
  ) : (
    "—"
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

  const del = useDeleteGiftOrPayment({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListGiftsAndPaymentsQueryKey() });
        toast({ title: "Gift deleted" });
        navigate("/gifts");
      },
      onError: (err: unknown) => {
        toast({
          title: "Delete failed",
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
  // Each setter sends all three FK fields so exactly one stays populated.
  const setFunderDonor = (next: string | null) =>
    patch({ funderId: next, individualGiverPersonId: null, householdId: null });
  const setHouseholdDonor = (next: string | null) =>
    patch({ householdId: next, funderId: null, individualGiverPersonId: null });
  const setIndividualDonor = (next: string | null) =>
    patch({ individualGiverPersonId: next, funderId: null, householdId: null });

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
        onClick={() => setEditingName(true)}
        data-testid="button-edit-gift-name"
      >
        Edit name
      </Button>
      <ConfirmDeleteDialog
        title="Delete this gift?"
        description="This gift or payment record and its allocations will be removed."
        onConfirm={() => del.mutateAsync({ id: gift.id })}
        disabled={del.isPending}
        triggerTestId="button-delete-gift"
        confirmTestId="button-confirm-delete-gift"
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
  const hasRelated = Boolean(gift.paymentOnPledgeId || gift.giftBeingMatchedId);

  return (
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
              <Row label="Method">
                <InlineEditSelect
                  label="Payment method"
                  testIdBase="gift-method"
                  value={gift.paymentMethod ?? null}
                  options={PAYMENT_METHOD_OPTIONS}
                  display={formatEnum(gift.paymentMethod) || "—"}
                  onSave={(next) => patch({ paymentMethod: next })}
                />
              </Row>
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
            </div>
          </FieldCard>

          <RelatedCard title="Allocations" count={allocations.length}>
            <div className="px-2 py-1">
              <GiftAllocationsEditor
                giftId={gift.id}
                allocations={gift.allocations ?? []}
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

          <div className="px-1 text-xs text-muted-foreground">
            Created {formatDate(gift.createdAt)} • Updated {formatDate(gift.updatedAt)}
          </div>
        </>
      }
      center={
        // Activity is scoped to the gift's donor (interactions/email/calendar/
        // meetings only link to a person/funder/household); notes link to the
        // gift itself. Tasks are surfaced in the dedicated Tasks card in the
        // right rail, so they're hidden from the feed to avoid duplication.
        <UnifiedActivityFeed
          funderId={gift.funderId ?? undefined}
          personId={gift.individualGiverPersonId ?? undefined}
          householdId={gift.householdId ?? undefined}
          notesContext={{ giftId: gift.id }}
          hideTasks
        />
      }
      right={
        <>
          <RelatedCard title="Organizations">
            <div className="space-y-1 px-2 py-1">
              <Row label="Funder">
                <InlineEditFunderPicker
                  testIdBase="gift-funder"
                  value={gift.funderId ?? null}
                  display={funderLinkDisplay}
                  onSave={setFunderDonor}
                  allowNull={false}
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
              <Row label="Household">
                <InlineEditHouseholdPicker
                  testIdBase="gift-household"
                  value={gift.householdId ?? null}
                  display={householdLinkDisplay}
                  onSave={setHouseholdDonor}
                  allowNull={false}
                />
              </Row>
            </div>
          </RelatedCard>

          <RelatedCard title="People" count={associatedPeople.length || undefined}>
            <div className="space-y-1 px-2 py-1">
              <Row label="Individual donor">
                <InlineEditPersonPicker
                  testIdBase="gift-individual-giver"
                  value={gift.individualGiverPersonId ?? null}
                  display={individualLinkDisplay}
                  onSave={setIndividualDonor}
                  allowNull={false}
                />
              </Row>
              <Row label="Advisor">
                <InlineEditPersonPicker
                  testIdBase="gift-advisor"
                  value={gift.advisorPersonId ?? null}
                  display={advisorDisplay}
                  onSave={(next) => patch({ advisorPersonId: next })}
                />
              </Row>
            </div>
            {associatedPeople.length > 0 ? (
              <div className="border-t pt-1">
                <div className="px-3 py-1 text-xs font-medium text-muted-foreground">
                  Associated contacts
                </div>
                {associatedPeople.map((role) => {
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
                      />
                    </div>
                  );
                })}
              </div>
            ) : null}
          </RelatedCard>

          <TasksPanel giftId={gift.id} />

          {hasRelated ? (
            <RelatedCard title="Related">
              <div>
                {gift.paymentOnPledgeId ? (
                  <RelatedRow
                    name="Payment on pledge"
                    href={`/pledges/${gift.paymentOnPledgeId}`}
                    tone="primary"
                    sub={gift.paymentOnPledgeId}
                  />
                ) : null}
                {gift.giftBeingMatchedId ? (
                  <RelatedRow
                    name="Matching gift"
                    href={`/gifts/${gift.giftBeingMatchedId}`}
                    tone="primary"
                    sub={gift.giftBeingMatchedId}
                  />
                ) : null}
              </div>
            </RelatedCard>
          ) : null}
        </>
      }
    />
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
