import { useState, type ReactNode } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetOpportunityOrPledge,
  useUpdateOpportunityOrPledge,
  useDeleteOpportunityOrPledge,
  getGetOpportunityOrPledgeQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  type OpportunityOrPledgeDetail,
  type UpdateOpportunityOrPledgeBody,
  type OpportunityStage,
  type OpportunityStatus,
  type OpportunityType,
} from "@workspace/api-client-react";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import {
  InlineEditCurrency,
  InlineEditDate,
  InlineEditSelect,
  InlineEditText,
  type InlineSelectOption,
} from "@/components/inline-edit";
import {
  InlineEditPersonPicker,
  InlineEditDonor,
  usePersonName,
  useFunderName,
  useHouseholdName,
  type DonorSaveBody,
} from "@/components/entity-picker";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const STAGE_OPTIONS = [
  { value: "cold_lead", label: "Cold lead" },
  { value: "warm_lead", label: "Warm lead" },
  { value: "in_conversation", label: "In conversation" },
  { value: "convince", label: "Convince" },
  { value: "conditional_commitment", label: "Conditional commitment" },
  { value: "probable_renewal", label: "Probable renewal" },
  { value: "verbal_commitment", label: "Verbal commitment" },
  { value: "written_commitment", label: "Written commitment" },
  { value: "cash_in", label: "Cash in" },
] as const satisfies ReadonlyArray<InlineSelectOption<OpportunityStage>>;

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "dormant", label: "Dormant" },
  { value: "lost", label: "Lost" },
] as const satisfies ReadonlyArray<InlineSelectOption<OpportunityStatus>>;

const TYPE_OPTIONS = [
  { value: "solicitation", label: "Solicitation" },
  { value: "renewal", label: "Renewal" },
  { value: "open_application", label: "Open application" },
] as const satisfies ReadonlyArray<InlineSelectOption<OpportunityType>>;
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
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isPledge = entityLabel === "Pledge";

  const update = useUpdateOpportunityOrPledge({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetOpportunityOrPledgeQueryKey(opp.id) }),
          queryClient.invalidateQueries({ queryKey: getListOpportunitiesAndPledgesQueryKey() }),
        ]);
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

  function patch(body: UpdateOpportunityOrPledgeBody) {
    return update.mutateAsync({ id: opp.id, data: body });
  }

  const funderName = useFunderName(opp.funderId ?? null);
  const giverName = usePersonName(opp.individualGiverPersonId ?? null);
  const householdName = useHouseholdName(opp.householdId ?? null);
  const advisorName = usePersonName(opp.individualAdvisorPersonId ?? null);
  const primaryContactName = usePersonName(opp.primaryContactPersonId ?? null);

  let donorDisplay: ReactNode = (
    <span className="text-muted-foreground">No donor linked.</span>
  );
  if (opp.funderId) {
    donorDisplay = (
      <span>
        <span className="text-muted-foreground mr-1">Funder:</span>
        <Link
          href={`/funding-entities/${opp.funderId}`}
          className="text-primary hover:underline"
        >
          {funderName ?? opp.funderId}
        </Link>
      </span>
    );
  } else if (opp.individualGiverPersonId) {
    donorDisplay = (
      <span>
        <span className="text-muted-foreground mr-1">Individual:</span>
        <Link
          href={`/individuals/${opp.individualGiverPersonId}`}
          className="text-primary hover:underline"
        >
          {giverName ?? opp.individualGiverPersonId}
        </Link>
      </span>
    );
  } else if (opp.householdId) {
    donorDisplay = (
      <span>
        <span className="text-muted-foreground mr-1">Household:</span>
        <Link
          href={`/households/${opp.householdId}`}
          className="text-primary hover:underline"
        >
          {householdName ?? opp.householdId}
        </Link>
      </span>
    );
  }
  const advisorDisplay: ReactNode = opp.individualAdvisorPersonId ? (
    <Link
      href={`/individuals/${opp.individualAdvisorPersonId}`}
      className="text-primary hover:underline"
    >
      {advisorName ?? opp.individualAdvisorPersonId}
    </Link>
  ) : (
    "—"
  );
  const primaryContactDisplay: ReactNode = opp.primaryContactPersonId ? (
    <Link
      href={`/individuals/${opp.primaryContactPersonId}`}
      className="text-primary hover:underline"
    >
      {primaryContactName ?? opp.primaryContactPersonId}
    </Link>
  ) : (
    "—"
  );

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
            <Row label="Stage">
              <InlineEditSelect
                label="Stage"
                testIdBase="opp-stage"
                value={opp.stage ?? null}
                options={STAGE_OPTIONS}
                display={formatEnum(opp.stage) || "—"}
                onSave={(next) => patch({ stage: next })}
              />
            </Row>
            <Row label="Status">
              {isPledge ? (
                <Badge variant="default">{formatEnum(opp.status) || "Won"}</Badge>
              ) : (
                <InlineEditSelect
                  label="Status"
                  testIdBase="opp-status"
                  value={opp.status ?? null}
                  options={STATUS_OPTIONS}
                  display={
                    opp.status ? (
                      <Badge variant={opp.status === "won" ? "default" : "outline"}>
                        {formatEnum(opp.status)}
                      </Badge>
                    ) : (
                      "—"
                    )
                  }
                  onSave={(next) => patch({ status: next })}
                />
              )}
            </Row>
            <Row label="Type">
              <InlineEditSelect
                label="Type"
                testIdBase="opp-type"
                value={opp.type ?? null}
                options={TYPE_OPTIONS}
                display={formatEnum(opp.type) || "—"}
                onSave={(next) => patch({ type: next })}
              />
            </Row>
            <Row label="Win probability">
              <InlineEditText
                label="Win probability"
                testIdBase="opp-winprob"
                value={opp.winProbability ?? null}
                placeholder="e.g. 75% or 0.75"
                display={opp.winProbability ?? "—"}
                onSave={(next) => patch({ winProbability: next })}
              />
            </Row>
            <Row label="Conditional">{formatEnum(opp.conditional)}</Row>
            <Row label="Conditions met">{opp.conditionsMet ? "Yes" : "No"}</Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-lg">Amounts</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Ask">
              <InlineEditCurrency
                label="Ask amount"
                testIdBase="opp-ask"
                value={opp.askAmount ?? null}
                display={formatCurrency(opp.askAmount)}
                onSave={(next) => patch({ askAmount: next })}
              />
            </Row>
            <Row label="Awarded">
              <InlineEditCurrency
                label="Awarded amount"
                testIdBase="opp-awarded"
                value={opp.awardedAmount ?? null}
                display={formatCurrency(opp.awardedAmount)}
                onSave={(next) => patch({ awardedAmount: next })}
              />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-lg">Dates</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Projected close">
              <InlineEditDate
                label="Projected close date"
                testIdBase="opp-projected-close"
                value={opp.projectedCloseDate ?? null}
                display={formatDate(opp.projectedCloseDate)}
                onSave={(next) => patch({ projectedCloseDate: next })}
              />
            </Row>
            <Row label="Actual completion">
              <InlineEditDate
                label="Actual completion date"
                testIdBase="opp-actual-completion"
                value={opp.actualCompletionDate ?? null}
                display={formatDate(opp.actualCompletionDate)}
                onSave={(next) => patch({ actualCompletionDate: next })}
              />
            </Row>
            <Row label="Application deadline">
              <InlineEditDate
                label="Application deadline"
                testIdBase="opp-app-deadline"
                value={opp.applicationDeadline ?? null}
                display={formatDate(opp.applicationDeadline)}
                onSave={(next) => patch({ applicationDeadline: next })}
              />
            </Row>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Donor</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label="Donor">
            <InlineEditDonor
              testIdBase="opp-donor"
              value={{
                funderId: opp.funderId ?? null,
                individualGiverPersonId: opp.individualGiverPersonId ?? null,
                householdId: opp.householdId ?? null,
              }}
              display={donorDisplay}
              onSave={(body: DonorSaveBody) => patch(body)}
            />
          </Row>
          <Row label="Advisor">
            <InlineEditPersonPicker
              testIdBase="opp-advisor"
              value={opp.individualAdvisorPersonId ?? null}
              display={advisorDisplay}
              onSave={(next) => patch({ individualAdvisorPersonId: next })}
            />
          </Row>
          <Row label="Primary contact">
            <InlineEditPersonPicker
              testIdBase="opp-primary-contact"
              value={opp.primaryContactPersonId ?? null}
              display={primaryContactDisplay}
              onSave={(next) => patch({ primaryContactPersonId: next })}
            />
          </Row>
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
