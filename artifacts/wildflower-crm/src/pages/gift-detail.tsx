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
import {
  InlineEditCurrency,
  InlineEditDate,
  InlineEditSelect,
  InlineEditText,
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
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  const userNames = useUserNameMap();
  const ownerDisplay = gift.ownerUserId
    ? (userNames.get(gift.ownerUserId) ?? gift.ownerUserId)
    : "—";
  const funderName = useFunderName(gift.funderId ?? null);
  const giverName = usePersonName(gift.individualGiverPersonId ?? null);
  const householdName = useHouseholdName(gift.householdId ?? null);
  const advisorName = usePersonName(gift.advisorPersonId ?? null);
  const intermediaryName = useIntermediaryName(gift.paymentIntermediaryId ?? null);

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

  function patch(body: UpdateGiftOrPaymentBody) {
    return update.mutateAsync({ id: gift.id, data: body });
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/gifts" className="text-sm text-primary hover:underline">← Back to gifts</Link>
      </div>

      <NameHeader gift={gift} />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-lg">Amount</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-lg">Classification</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
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
            <Row label="Designated to school">{gift.designatedToSchool ? "Yes" : "No"}</Row>
            <Row label="Owner">
              <InlineEditUserPicker
                testIdBase="gift-owner"
                value={gift.ownerUserId ?? null}
                display={ownerDisplay}
                onSave={(next) => patch({ ownerUserId: next })}
              />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-lg">Donor</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
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
          </CardContent>
        </Card>
      </div>

      {(gift.paymentOnPledgeId || gift.giftBeingMatchedId) && (
        <Card>
          <CardHeader><CardTitle>Related</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {gift.paymentOnPledgeId && (
              <Row label="Payment on pledge">
                <Link href={`/pledges/${gift.paymentOnPledgeId}`} className="text-primary hover:underline">{gift.paymentOnPledgeId}</Link>
              </Row>
            )}
            {gift.giftBeingMatchedId && (
              <Row label="Matching gift">
                <Link href={`/gifts/${gift.giftBeingMatchedId}`} className="text-primary hover:underline">{gift.giftBeingMatchedId}</Link>
              </Row>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Allocations</CardTitle></CardHeader>
        <CardContent>
          {gift.allocations && gift.allocations.length > 0 ? (
            <ul className="space-y-2 text-sm">
              {gift.allocations.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2" data-testid={`row-gift-alloc-${a.id}`}>
                  <span className="truncate">
                    {formatEnum(a.intendedUsage) || "—"}
                    {a.grantYear ? ` • ${a.grantYear}` : ""}
                    {a.schoolRecipientId ? ` • school ${a.schoolRecipientId}` : ""}
                  </span>
                  <span className="font-medium whitespace-nowrap">{formatCurrency(a.subAmount)}</span>
                </li>
              ))}
            </ul>
          ) : (<p className="text-sm text-muted-foreground">No allocations.</p>)}
        </CardContent>
      </Card>

      {(gift.details || gift.tags) && (
        <Card>
          <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {gift.tags && <Row label="Tags">{gift.tags}</Row>}
            {gift.details && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Details</div>
                <p className="whitespace-pre-wrap">{gift.details}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="text-xs text-muted-foreground">
        Created {formatDate(gift.createdAt)} • Updated {formatDate(gift.updatedAt)}
      </div>
    </div>
  );
}

function NameHeader({ gift }: { gift: GiftOrPaymentDetail }) {
  const [editing, setEditing] = useState(false);
  const initial = gift.name ?? "";
  const [value, setValue] = useState(initial);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
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
  const update = useUpdateGiftOrPayment({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetGiftOrPaymentQueryKey(gift.id) }),
          queryClient.invalidateQueries({ queryKey: getListGiftsAndPaymentsQueryKey() }),
        ]);
        setEditing(false);
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

  if (editing) {
    const trimmed = value.trim();
    const dirty = trimmed !== (gift.name ?? "");
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="text-2xl font-serif font-bold h-12 max-w-xl"
          aria-label="Gift name"
          data-testid="input-gift-name"
          autoFocus
        />
        <Button
          onClick={() => {
            const body: UpdateGiftOrPaymentBody = { name: trimmed || null };
            update.mutate({ id: gift.id, data: body });
          }}
          disabled={!dirty || update.isPending}
          data-testid="button-save-gift-name"
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={() => { setValue(initial); setEditing(false); }} disabled={update.isPending}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-between gap-4">
      <h1 className="text-3xl font-serif font-bold text-foreground">{gift.name ?? `Gift ${gift.id}`}</h1>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setEditing(true)} data-testid="button-edit-gift-name">
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
      </div>
    </div>
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
