import { useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetOpportunityOrPledge,
  useUpdateOpportunityOrPledge,
  useDeleteOpportunityOrPledge,
  getGetOpportunityOrPledgeQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  type OpportunityOrPledgeDetail,
  type UpdateOpportunityOrPledgeBody,
} from "@workspace/api-client-react";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (isError || !data) {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="text-sm text-primary hover:underline">{backLabel}</Link>
        <div className="text-sm text-destructive">
          {error instanceof Error ? error.message : `${entityLabel} not found.`}
        </div>
      </div>
    );
  }
  return <OppView opp={data} backHref={backHref} backLabel={backLabel} entityLabel={entityLabel} />;
}

function OppView({
  opp, backHref, backLabel, entityLabel,
}: { opp: OpportunityOrPledgeDetail; backHref: string; backLabel: string; entityLabel: string }) {
  return (
    <div className="space-y-6">
      <div>
        <Link href={backHref} className="text-sm text-primary hover:underline">{backLabel}</Link>
      </div>

      <NameHeader opp={opp} entityLabel={entityLabel} backHref={backHref} />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-lg">Pipeline</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Stage">{formatEnum(opp.stage)}</Row>
            <Row label="Status">
              {opp.status ? <Badge variant={opp.status === "won" ? "default" : "outline"}>{formatEnum(opp.status)}</Badge> : "—"}
            </Row>
            <Row label="Type">{formatEnum(opp.type)}</Row>
            <Row label="Win probability">{opp.winProbability ?? "—"}</Row>
            <Row label="Conditional">{formatEnum(opp.conditional)}</Row>
            <Row label="Conditions met">{opp.conditionsMet ? "Yes" : "No"}</Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-lg">Amounts</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Ask">{formatCurrency(opp.askAmount)}</Row>
            <Row label="Awarded">{formatCurrency(opp.awardedAmount)}</Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-lg">Dates</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Projected close">{formatDate(opp.projectedCloseDate)}</Row>
            <Row label="Actual completion">{formatDate(opp.actualCompletionDate)}</Row>
            <Row label="Application deadline">{formatDate(opp.applicationDeadline)}</Row>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Donor</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {opp.funderId ? (
            <Row label="Funder">
              <Link href={`/funding-entities/${opp.funderId}`} className="text-primary hover:underline">{opp.funderId}</Link>
            </Row>
          ) : null}
          {opp.individualGiverPersonId ? (
            <Row label="Individual giver">
              <Link href={`/individuals/${opp.individualGiverPersonId}`} className="text-primary hover:underline">{opp.individualGiverPersonId}</Link>
            </Row>
          ) : null}
          {opp.householdId ? (
            <Row label="Household">
              <Link href={`/households/${opp.householdId}`} className="text-primary hover:underline">{opp.householdId}</Link>
            </Row>
          ) : null}
          {!opp.funderId && !opp.individualGiverPersonId && !opp.householdId && (
            <p className="text-muted-foreground">No donor linked.</p>
          )}
          {opp.individualAdvisorPersonId && (
            <Row label="Advisor">
              <Link href={`/individuals/${opp.individualAdvisorPersonId}`} className="text-primary hover:underline">{opp.individualAdvisorPersonId}</Link>
            </Row>
          )}
          {opp.primaryContactPersonId && (
            <Row label="Primary contact">
              <Link href={`/individuals/${opp.primaryContactPersonId}`} className="text-primary hover:underline">{opp.primaryContactPersonId}</Link>
            </Row>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Allocations</CardTitle></CardHeader>
        <CardContent>
          {opp.allocations && opp.allocations.length > 0 ? (
            <ul className="space-y-2 text-sm">
              {opp.allocations.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2" data-testid={`row-opp-alloc-${a.id}`}>
                  <span className="truncate">
                    {formatEnum(a.intendedUsage) || "—"}
                    {a.grantYear ? ` • ${a.grantYear}` : ""}
                  </span>
                  <span className="font-medium whitespace-nowrap">{formatCurrency(a.subAmount)}</span>
                </li>
              ))}
            </ul>
          ) : (<p className="text-sm text-muted-foreground">No allocations.</p>)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Payments</CardTitle></CardHeader>
        <CardContent>
          {opp.payments && opp.payments.length > 0 ? (
            <ul className="space-y-2 text-sm">
              {opp.payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2" data-testid={`row-opp-payment-${p.id}`}>
                  <Link href={`/gifts/${p.id}`} className="text-primary hover:underline truncate">
                    {p.name ?? `Payment ${p.id}`}
                  </Link>
                  <span className="text-muted-foreground text-xs whitespace-nowrap">
                    {formatDate(p.dateReceived)} • <span className="font-medium text-foreground">{formatCurrency(p.amount)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (<p className="text-sm text-muted-foreground">No payments yet.</p>)}
        </CardContent>
      </Card>

      {(opp.conditions || opp.paymentDetails || opp.usageNotes || opp.lossReason) && (
        <Card>
          <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {opp.conditions && <NoteBlock label="Conditions">{opp.conditions}</NoteBlock>}
            {opp.paymentDetails && <NoteBlock label="Payment details">{opp.paymentDetails}</NoteBlock>}
            {opp.usageNotes && <NoteBlock label="Usage notes">{opp.usageNotes}</NoteBlock>}
            {opp.lossReason && <NoteBlock label="Loss reason">{opp.lossReason}</NoteBlock>}
          </CardContent>
        </Card>
      )}

      <div className="text-xs text-muted-foreground">
        Created {formatDate(opp.createdAt)} • Updated {formatDate(opp.updatedAt)}
      </div>
    </div>
  );
}

function NameHeader({
  opp,
  entityLabel,
  backHref,
}: {
  opp: OpportunityOrPledgeDetail;
  entityLabel: string;
  backHref: string;
}) {
  const [editing, setEditing] = useState(false);
  const initial = opp.name ?? "";
  const [value, setValue] = useState(initial);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const del = useDeleteOpportunityOrPledge({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListOpportunitiesAndPledgesQueryKey() });
        toast({ title: `${entityLabel} deleted` });
        navigate(backHref);
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
  const update = useUpdateOpportunityOrPledge({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetOpportunityOrPledgeQueryKey(opp.id) }),
          queryClient.invalidateQueries({ queryKey: getListOpportunitiesAndPledgesQueryKey() }),
        ]);
        setEditing(false);
        toast({ title: `${entityLabel} updated` });
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
    const dirty = trimmed !== (opp.name ?? "");
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="text-2xl font-serif font-bold h-12 max-w-xl"
          aria-label={`${entityLabel} name`}
          data-testid="input-opp-name"
          autoFocus
        />
        <Button
          onClick={() => {
            const body: UpdateOpportunityOrPledgeBody = { name: trimmed || null };
            update.mutate({ id: opp.id, data: body });
          }}
          disabled={!dirty || update.isPending}
          data-testid="button-save-opp-name"
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
      <h1 className="text-3xl font-serif font-bold text-foreground">{opp.name ?? `Untitled ${opp.id}`}</h1>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setEditing(true)} data-testid="button-edit-opp-name">
          Edit name
        </Button>
        <ConfirmDeleteDialog
          title={`Delete this ${entityLabel.toLowerCase()}?`}
          description={`This ${entityLabel.toLowerCase()} record, along with its pledge and gift allocations, will be removed.`}
          onConfirm={() => del.mutateAsync({ id: opp.id })}
          disabled={del.isPending}
          triggerTestId="button-delete-opp"
          confirmTestId="button-confirm-delete-opp"
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

function NoteBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
      <p className="whitespace-pre-wrap">{children}</p>
    </div>
  );
}
