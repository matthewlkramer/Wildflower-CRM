import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetGift, getGetGiftQueryKey, useUpdateGift, type UpdateGiftBody } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EditDialog } from "@/components/edit-dialog";
import { formatCurrency, formatDate, formatEnum, formatFund } from "@/lib/format";

export default function GiftDetail() {
  const params = useParams();
  const id = params.id as string;

  const queryClient = useQueryClient();
  const { data: gift, isLoading } = useGetGift(id, {
    query: {
      enabled: !!id,
      queryKey: getGetGiftQueryKey(id),
    },
  });
  const updateMutation = useUpdateGift({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetGiftQueryKey(id) }),
    },
  });

  if (isLoading) return <div className="p-8 text-muted-foreground animate-pulse">Loading gift...</div>;
  if (!gift) return <div className="p-8 text-destructive">Gift not found.</div>;

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
              <Badge variant="outline">Fiscal sponsor on file</Badge>
            )}
          </div>
        </div>
        <EditDialog<Pick<UpdateGiftBody, "reconciled" | "taxReceiptSent" | "acknowledgmentSentDate" | "notes">>
          trigger={<Button variant="outline" size="sm">Edit</Button>}
          title="Edit gift"
          isPending={updateMutation.isPending}
          fields={[
            { kind: "checkbox", key: "reconciled", label: "Reconciled", value: gift.reconciled },
            { kind: "checkbox", key: "taxReceiptSent", label: "Tax receipt sent", value: gift.taxReceiptSent },
            { kind: "date", key: "acknowledgmentSentDate", label: "Acknowledgment sent date", value: gift.acknowledgmentSentDate },
            { kind: "textarea", key: "notes", label: "Notes", value: gift.notes ?? null },
          ]}
          onSubmit={async (values) => {
            await updateMutation.mutateAsync({ id, data: values });
          }}
        />
      </div>

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
                    View paying entity
                  </Link>
                ) : (
                  <span className="text-muted-foreground">{payerEntityId}</span>
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
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Soft Credits</CardTitle></CardHeader>
        <CardContent>
          {gift.softCredits && gift.softCredits.length > 0 ? (
            <ul className="space-y-2 text-sm">
              {gift.softCredits.map((sc) => (
                <li key={sc.id} className="flex items-center justify-between gap-2">
                  <Link href={`/individuals/${sc.individualId}`} className="text-primary hover:underline">
                    {[sc.individualFirstName, sc.individualLastName].filter(Boolean).join(" ") || "Individual"}
                  </Link>
                  <span className="text-muted-foreground text-xs">
                    {formatEnum(sc.creditType)}
                    {sc.percentage != null ? ` • ${sc.percentage}%` : ""}
                  </span>
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
