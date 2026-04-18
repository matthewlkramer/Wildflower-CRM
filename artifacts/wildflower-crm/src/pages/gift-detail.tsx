import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetGift,
  getGetGiftQueryKey,
  useUpdateGift,
  useCreateGiftSoftCredit,
  useUpdateGiftSoftCredit,
  useDeleteGiftSoftCredit,
  type UpdateGiftBody,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GiftFormDialog } from "@/components/gift-form-dialog";
import { SoftCreditDialog } from "@/components/soft-credit-dialog";
import { formatCurrency, formatDate, formatEnum, formatFund } from "@/lib/format";
import { Pencil, Trash2 } from "lucide-react";

export default function GiftDetail() {
  const params = useParams();
  const id = params.id as string;

  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: getGetGiftQueryKey(id) });

  const { data: gift, isLoading } = useGetGift(id, {
    query: {
      enabled: !!id,
      queryKey: getGetGiftQueryKey(id),
    },
  });
  const updateMutation = useUpdateGift({ mutation: { onSuccess: invalidate } });
  const createSoftCredit = useCreateGiftSoftCredit({ mutation: { onSuccess: invalidate } });
  const updateSoftCredit = useUpdateGiftSoftCredit({ mutation: { onSuccess: invalidate } });
  const deleteSoftCredit = useDeleteGiftSoftCredit({ mutation: { onSuccess: invalidate } });

  if (isLoading) return <div className="p-8 text-muted-foreground animate-pulse">Loading gift...</div>;
  if (!gift) return <div className="p-8 text-destructive">Gift not found.</div>;

  const patchGift = async (patch: UpdateGiftBody) => {
    await updateMutation.mutateAsync({ id, data: patch });
  };

  const toggleReconciled = () => patchGift({ reconciled: !gift.reconciled });
  const toggleTaxReceipt = () => patchGift({ taxReceiptSent: !gift.taxReceiptSent });
  const markAcknowledgedToday = () =>
    patchGift({ acknowledgmentSentDate: new Date().toISOString().slice(0, 10) });
  const clearAcknowledged = () => patchGift({ acknowledgmentSentDate: null });

  const donorLink =
    gift.individualId
      ? { href: `/individuals/${gift.individualId}`, label: gift.donorName ?? "Individual" }
      : gift.householdId
      ? { href: `/households/${gift.householdId}`, label: gift.donorName ?? "Household" }
      : gift.fundingEntityId
      ? { href: `/funding-entities/${gift.fundingEntityId}`, label: gift.donorName ?? "Funding Entity" }
      : null;

  const payerEntityId = gift.payerFundingEntityId ?? gift.payerOrganizationId ?? null;
  const fiscalSponsorId = gift.fiscalSponsorFundingEntityId ?? gift.fiscalSponsorOrganizationId ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            {formatCurrency(gift.amount)}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Received {formatDate(gift.cashReceivedDate)}
            {gift.paymentMethod ? ` • ${formatEnum(gift.paymentMethod)}` : ""}
            {gift.checkNumber ? ` • Check #${gift.checkNumber}` : ""}
          </p>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {gift.reconciled ? (
              <Badge>Reconciled</Badge>
            ) : (
              <Badge variant="outline">Pending reconciliation</Badge>
            )}
            {gift.taxReceiptSent ? (
              <Badge variant="secondary">Tax receipt sent</Badge>
            ) : (
              <Badge variant="outline">Tax receipt pending</Badge>
            )}
            {gift.acknowledgmentSentDate ? (
              <Badge variant="secondary">Acknowledged {formatDate(gift.acknowledgmentSentDate)}</Badge>
            ) : (
              <Badge variant="outline">Not acknowledged</Badge>
            )}
            {gift.directToSchoolPassthrough && <Badge variant="outline">Direct-to-school passthrough</Badge>}
            {fiscalSponsorId && (
              <Badge variant="outline">
                Fiscal sponsor: {gift.fiscalSponsorName ?? "on file"}
              </Badge>
            )}
          </div>
        </div>
        <GiftFormDialog
          mode="edit"
          gift={gift}
          isPending={updateMutation.isPending}
          trigger={<Button variant="outline" size="sm">Edit gift</Button>}
          onSubmit={async (body) => {
            const { individualId, householdId, fundingEntityId, ...rest } = body;
            const patch: UpdateGiftBody = { ...rest };
            void individualId;
            void householdId;
            void fundingEntityId;
            await patchGift(patch);
          }}
        />
      </div>

      <Card>
        <CardHeader><CardTitle>Quick actions</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant={gift.reconciled ? "secondary" : "default"}
            size="sm"
            disabled={updateMutation.isPending}
            onClick={toggleReconciled}
          >
            {gift.reconciled ? "Mark as pending" : "Mark reconciled"}
          </Button>
          <Button
            variant={gift.taxReceiptSent ? "secondary" : "default"}
            size="sm"
            disabled={updateMutation.isPending}
            onClick={toggleTaxReceipt}
          >
            {gift.taxReceiptSent ? "Mark tax receipt unsent" : "Mark tax receipt sent"}
          </Button>
          {gift.acknowledgmentSentDate ? (
            <Button
              variant="outline"
              size="sm"
              disabled={updateMutation.isPending}
              onClick={clearAcknowledged}
            >
              Clear acknowledgment
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              disabled={updateMutation.isPending}
              onClick={markAcknowledgedToday}
            >
              Acknowledge today
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Donor</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {donorLink ? (
              <div>
                <span className="font-medium">Credited to:</span>{" "}
                <Link href={donorLink.href} className="text-primary hover:underline">
                  {donorLink.label}
                </Link>
              </div>
            ) : (
              <div className="text-muted-foreground">No donor on file.</div>
            )}
            {payerEntityId && (
              <div>
                <span className="font-medium">Payer (different from donor):</span>{" "}
                {gift.payerFundingEntityId ? (
                  <Link href={`/funding-entities/${gift.payerFundingEntityId}`} className="text-primary hover:underline">
                    {gift.payerName ?? "View paying entity"}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">{gift.payerName ?? payerEntityId}</span>
                )}
              </div>
            )}
            {gift.fiscalSponsorName && (
              <div>
                <span className="font-medium">Fiscal sponsor:</span>{" "}
                {gift.fiscalSponsorFundingEntityId ? (
                  <Link
                    href={`/funding-entities/${gift.fiscalSponsorFundingEntityId}`}
                    className="text-primary hover:underline"
                  >
                    {gift.fiscalSponsorName}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">{gift.fiscalSponsorName}</span>
                )}
              </div>
            )}
            {gift.campaignId && (
              <div>
                <span className="font-medium">Campaign:</span>{" "}
                <span className="text-muted-foreground">{gift.campaignId}</span>
              </div>
            )}
            {gift.pledgeId && (
              <div>
                <span className="font-medium">Pledge:</span>{" "}
                <Link href={`/pledges/${gift.pledgeId}`} className="text-primary hover:underline">
                  View pledge
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Allocations</CardTitle></CardHeader>
          <CardContent>
            {gift.allocations && gift.allocations.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {gift.allocations.map((a) => (
                  <li key={a.id} className="flex items-center justify-between">
                    <span>
                      {formatFund(a.fund)}
                      {a.fiscalYear ? ` • ${String(a.fiscalYear).startsWith("FY") ? a.fiscalYear : `FY${a.fiscalYear}`}` : ""}
                    </span>
                    <span className="font-medium">{formatCurrency(a.amount)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No allocations.</p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Edit allocations using the "Edit gift" button above.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Soft Credits</CardTitle>
          <SoftCreditDialog
            mode="create"
            isPending={createSoftCredit.isPending}
            trigger={<Button size="sm" variant="outline">Add soft credit</Button>}
            onSubmit={async (body) => {
              await createSoftCredit.mutateAsync({ id, data: body });
            }}
          />
        </CardHeader>
        <CardContent>
          {gift.softCredits && gift.softCredits.length > 0 ? (
            <ul className="space-y-2 text-sm">
              {gift.softCredits.map((sc) => (
                <li key={sc.id} className="flex items-center justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <Link href={`/individuals/${sc.individualId}`} className="text-primary hover:underline">
                      {[sc.individualFirstName, sc.individualLastName].filter(Boolean).join(" ") || "Individual"}
                    </Link>
                    <span className="ml-2 text-muted-foreground text-xs">
                      {formatEnum(sc.creditType)}
                      {sc.percentage != null ? ` • ${sc.percentage}%` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <SoftCreditDialog
                      mode="edit"
                      existing={sc}
                      isPending={updateSoftCredit.isPending}
                      trigger={
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      }
                      onSubmit={async (body) => {
                        await updateSoftCredit.mutateAsync({
                          id,
                          softCreditId: sc.id,
                          data: {
                            creditType: body.creditType,
                            percentage: body.percentage ?? null,
                            notes: body.notes ?? null,
                          },
                        });
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      disabled={deleteSoftCredit.isPending}
                      onClick={async () => {
                        if (!window.confirm("Delete this soft credit?")) return;
                        await deleteSoftCredit.mutateAsync({ id, softCreditId: sc.id });
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No soft credits.</p>
          )}
        </CardContent>
      </Card>

      {gift.notes && (
        <Card>
          <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{gift.notes}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
