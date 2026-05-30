import { useState, type ReactNode } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetGiftOrPayment,
  useUpdateGiftOrPayment,
  useDeleteGiftOrPayment,
  getGetGiftOrPaymentQueryKey,
  getListGiftsAndPaymentsQueryKey,
  type GiftOrPaymentDetail,
  type UpdateGiftOrPaymentBody,
  type GiftType,
  type GiftPaymentMethod,
} from "@workspace/api-client-react";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { GiftAllocationsEditor } from "@/components/allocation-editors";
import { NotesPanel } from "@/components/notes-panel";
import { TasksPanel } from "@/components/tasks-panel";
import { ThankYouPanel } from "@/components/thank-you-panel";
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
  InlineEditIntermediaryPicker,
  InlineEditDonor,
  usePersonName,
  useFunderName,
  useHouseholdName,
  useIntermediaryName,
  type DonorSaveBody,
} from "@/components/entity-picker";
import {
  RecordLayout,
  FieldCard,
  RelatedCard,
  RelatedRow,
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

  const highlights: Highlight[] = [
    { label: "Amount", value: formatCurrency(gift.amount), accent: true },
    { label: "Received", value: formatDate(gift.dateReceived) },
    { label: "Type", value: formatEnum(gift.type) || "—" },
    { label: "Method", value: formatEnum(gift.paymentMethod) || "—" },
    { label: "Owner", value: ownerDisplay },
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
          <FieldCard title="Amount">
            <div className="space-y-1">
              <Row label="Amount">
                <InlineEditCurrency
                  label="Amount"
                  testIdBase="gift-amount"
                  value={gift.amount ?? null}
                  display={<span className="text-xl font-bold text-primary">{formatCurrency(gift.amount)}</span>}
                  onSave={(next) => patch({ amount: next })}
                />
              </Row>
              <Row label="Received">
                <InlineEditDate
                  label="Date received"
                  testIdBase="gift-date-received"
                  value={gift.dateReceived ?? null}
                  display={formatDate(gift.dateReceived)}
                  onSave={(next) => patch({ dateReceived: next })}
                />
              </Row>
            </div>
          </FieldCard>

          <FieldCard title="Classification">
            <div className="space-y-1">
              <Row label="Type">
                <InlineEditSelect
                  label="Type"
                  testIdBase="gift-type"
                  value={gift.type ?? null}
                  options={GIFT_TYPE_OPTIONS}
                  display={formatEnum(gift.type) || "—"}
                  onSave={(next) => patch({ type: next })}
                />
              </Row>
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
              <Row label="Grant year">
                <InlineEditText
                  label="Grant year"
                  testIdBase="gift-grant-year"
                  value={gift.grantYear ?? null}
                  placeholder="e.g. 2025"
                  display={gift.grantYear ?? "—"}
                  onSave={(next) => patch({ grantYear: next })}
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
              <Row label="Owner">
                <InlineEditUserPicker
                  testIdBase="gift-owner"
                  value={gift.ownerUserId ?? null}
                  display={ownerDisplay}
                  onSave={(next) => patch({ ownerUserId: next })}
                />
              </Row>
            </div>
          </FieldCard>

          <FieldCard title="Donor">
            <div className="space-y-1">
              <Row label="Donor">
                <InlineEditDonor
                  testIdBase="gift-donor"
                  value={{
                    funderId: gift.funderId ?? null,
                    individualGiverPersonId: gift.individualGiverPersonId ?? null,
                    householdId: gift.householdId ?? null,
                  }}
                  display={donorDisplay}
                  onSave={(body: DonorSaveBody) => patch(body)}
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
              <Row label="Intermediary">
                <InlineEditIntermediaryPicker
                  testIdBase="gift-intermediary"
                  value={gift.paymentIntermediaryId ?? null}
                  display={intermediaryDisplay}
                  onSave={(next) => patch({ paymentIntermediaryId: next })}
                />
              </Row>
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

          <div className="px-1 text-xs text-muted-foreground">
            Created {formatDate(gift.createdAt)} • Updated {formatDate(gift.updatedAt)}
          </div>
        </>
      }
      center={
        <>
          <ThankYouPanel gift={gift} />
          <NotesPanel giftId={gift.id} />
          <TasksPanel giftId={gift.id} />
        </>
      }
      right={
        <>
          <RelatedCard title="Allocations" count={allocations.length}>
            <div className="px-2 py-1">
              <GiftAllocationsEditor
                giftId={gift.id}
                allocations={gift.allocations ?? []}
              />
            </div>
          </RelatedCard>

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
