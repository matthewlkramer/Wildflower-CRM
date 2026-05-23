import { useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetGiftOrPayment,
  useUpdateGiftOrPayment,
  useDeleteGiftOrPayment,
  getGetGiftOrPaymentQueryKey,
  getListGiftsAndPaymentsQueryKey,
  type GiftOrPaymentDetail,
  type UpdateGiftOrPaymentBody,
} from "@workspace/api-client-react";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  return (
    <div className="space-y-6">
      <div>
        <Link href="/gifts" className="text-sm text-primary hover:underline">← Back to gifts</Link>
      </div>

      <NameHeader gift={gift} />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-lg">Amount</CardTitle></CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-primary">{formatCurrency(gift.amount)}</p>
            <p className="text-sm text-muted-foreground mt-1">Received {formatDate(gift.dateReceived)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-lg">Classification</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Type">{formatEnum(gift.type)}</Row>
            <Row label="Method">{formatEnum(gift.paymentMethod)}</Row>
            <Row label="Grant year">{gift.grantYear ?? "—"}</Row>
            <Row label="Designated to school">{gift.designatedToSchool ? "Yes" : "No"}</Row>
            <Row label="Owner">{gift.ownerUserId ?? "—"}</Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-lg">Donor</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {gift.funderId && (
              <Row label="Funder">
                <Link href={`/funding-entities/${gift.funderId}`} className="text-primary hover:underline">{gift.funderId}</Link>
              </Row>
            )}
            {gift.individualGiverPersonId && (
              <Row label="Individual">
                <Link href={`/individuals/${gift.individualGiverPersonId}`} className="text-primary hover:underline">{gift.individualGiverPersonId}</Link>
              </Row>
            )}
            {gift.householdId && (
              <Row label="Household">
                <Link href={`/households/${gift.householdId}`} className="text-primary hover:underline">{gift.householdId}</Link>
              </Row>
            )}
            {!gift.funderId && !gift.individualGiverPersonId && !gift.householdId && (
              <p className="text-muted-foreground">No donor linked.</p>
            )}
            {gift.advisorPersonId && (
              <Row label="Advisor">
                <Link href={`/individuals/${gift.advisorPersonId}`} className="text-primary hover:underline">{gift.advisorPersonId}</Link>
              </Row>
            )}
            {gift.paymentIntermediaryId && (
              <Row label="Intermediary">{gift.paymentIntermediaryId}</Row>
            )}
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
