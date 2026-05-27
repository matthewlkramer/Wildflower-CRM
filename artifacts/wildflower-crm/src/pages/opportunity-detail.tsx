import { useState, type ReactNode } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetOpportunityOrPledge,
  useUpdateOpportunityOrPledge,
  useDeleteOpportunityOrPledge,
  useListEntities,
  getGetOpportunityOrPledgeQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  type OpportunityOrPledgeDetail,
  type UpdateOpportunityOrPledgeBody,
  type OpportunityStage,
  type OpportunityStatus,
  type OpportunityType,
  type OpportunityConditional,
} from "@workspace/api-client-react";
import { PledgeAllocationsEditor } from "@/components/allocation-editors";
import { ActivityTimeline } from "@/components/activity-timeline";
import { NotesPanel } from "@/components/notes-panel";
import { TasksPanel } from "@/components/tasks-panel";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
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
  { value: "pledge", label: "Pledge" },
  { value: "cash_in", label: "Cash in" },
  { value: "dormant", label: "Dormant" },
  { value: "lost", label: "Lost" },
] as const satisfies ReadonlyArray<InlineSelectOption<OpportunityStatus>>;

const TYPE_OPTIONS = [
  { value: "solicitation", label: "Solicitation" },
  { value: "renewal", label: "Renewal" },
  { value: "open_application", label: "Open application" },
] as const satisfies ReadonlyArray<InlineSelectOption<OpportunityType>>;

const CONDITIONAL_OPTIONS = [
  { value: "unconditional", label: "Unconditional" },
  { value: "reimbursable", label: "Reimbursable" },
  { value: "conditional_on_funder_determination", label: "Conditional — funder determination" },
  { value: "conditional_on_target", label: "Conditional — on target" },
] as const satisfies ReadonlyArray<InlineSelectOption<OpportunityConditional>>;
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

  // Resolve entity slugs (from pledge_allocations) to human names so
  // the Pipeline summary + Allocations list can show real labels.
  const entitiesQ = useListEntities();
  const entityNameById = new Map(
    (entitiesQ.data ?? []).map((e) => [e.id, e.name]),
  );
  const entityLabels = (opp.entityIds ?? []).map(
    (id) => entityNameById.get(id) ?? id,
  );

  const userNames = useUserNameMap();
  const ownerDisplay = opp.ownerUserId
    ? (userNames.get(opp.ownerUserId) ?? opp.ownerUserId)
    : "—";

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
              {/*
                Status is normally auto-derived (open / pledge / cash_in)
                but users can still hand-set sticky overrides (dormant /
                lost). Surface the select on both Pledge and Opportunity
                detail pages — the only difference between them is the
                page filter, not the underlying record.
              */}
              <InlineEditSelect
                label="Status"
                testIdBase="opp-status"
                value={opp.status ?? null}
                options={STATUS_OPTIONS}
                display={
                  opp.status ? (
                    <Badge
                      variant={
                        opp.status === "cash_in" || opp.status === "pledge"
                          ? "default"
                          : "outline"
                      }
                    >
                      {formatEnum(opp.status)}
                    </Badge>
                  ) : (
                    "—"
                  )
                }
                onSave={(next) => {
                  // Convenience: when closing a single opp that has no
                  // completion date yet, default to today so the user
                  // doesn't have to set it manually. The bulk-edit path
                  // intentionally does NOT do this (cleanup of historical
                  // rows shouldn't invent a fake date).
                  const closed =
                    next === "cash_in" || next === "lost" || next === "dormant";
                  const body: UpdateOpportunityOrPledgeBody = { status: next };
                  if (closed && !opp.actualCompletionDate) {
                    body.actualCompletionDate = new Date()
                      .toISOString()
                      .slice(0, 10);
                  }
                  return patch(body);
                }}
              />
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
            <Row label="Conditional">
              <InlineEditSelect
                label="Conditional"
                testIdBase="opp-conditional"
                value={opp.conditional ?? null}
                options={CONDITIONAL_OPTIONS}
                display={formatEnum(opp.conditional) || "—"}
                onSave={(next) => patch({ conditional: next })}
              />
            </Row>
            <Row label="Conditions met">
              <InlineEditBoolean
                label="Conditions met"
                testIdBase="opp-conditions-met"
                value={opp.conditionsMet}
                allowNull={false}
                display={opp.conditionsMet ? "Yes" : "No"}
                onSave={(next) => patch({ conditionsMet: next ?? false })}
              />
            </Row>
            <Row label="Is conditional">
              {/*
                Independent boolean flag (separate from the
                `conditional` semantic-context enum above). Toggled
                manually; pre-set true on records imported with a
                `conditional_commitment` stage.
              */}
              <InlineEditBoolean
                label="Is conditional"
                testIdBase="opp-is-conditional"
                value={opp.isConditional ?? false}
                allowNull={false}
                display={opp.isConditional ? "Yes" : "No"}
                onSave={(next) => patch({ isConditional: next ?? false })}
              />
            </Row>
            <Row label="Was pledge">
              {/*
                Sticky-true flag that pins a row to the Pledges page
                even after stage moves backward or status flips to
                cash_in. Auto-flipped true on stage ∈ (conditional,
                verbal, written) or grant-letter upload; also user-
                tickable here. Never auto-flipped back to false — only
                the user can clear it.
              */}
              <InlineEditBoolean
                label="Was pledge"
                testIdBase="opp-was-pledge"
                value={opp.wasPledge ?? false}
                allowNull={false}
                display={opp.wasPledge ? "Yes" : "No"}
                onSave={(next) => patch({ wasPledge: next ?? false })}
              />
            </Row>
            <Row label="Grant letter">
              {/*
                Manual URL field for now — drop-zone upload is a
                planned follow-up that will POST to the API server's
                object-storage helper and then PATCH this row.
                Setting a URL also flips was_pledge sticky-true on
                the server side (see applyDerivedOppFields).
              */}
              <InlineEditText
                label="Grant letter URL"
                testIdBase="opp-grant-letter-url"
                value={opp.grantLetterUrl ?? null}
                placeholder="https://…"
                display={
                  opp.grantLetterUrl ? (
                    <a
                      href={opp.grantLetterUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      {opp.grantLetterFilename ?? "View letter"}
                    </a>
                  ) : (
                    "—"
                  )
                }
                onSave={(next) => patch({ grantLetterUrl: next })}
              />
            </Row>
            {opp.grantLetterUrl && (
              <Row label="Grant letter filename">
                <InlineEditText
                  label="Grant letter filename"
                  testIdBase="opp-grant-letter-filename"
                  value={opp.grantLetterFilename ?? null}
                  placeholder="award_letter.pdf"
                  display={opp.grantLetterFilename ?? "—"}
                  onSave={(next) => patch({ grantLetterFilename: next })}
                />
              </Row>
            )}
            <Row label="Owner">
              <InlineEditUserPicker
                testIdBase="opp-owner"
                value={opp.ownerUserId ?? null}
                display={ownerDisplay}
                onSave={(next) => patch({ ownerUserId: next })}
              />
            </Row>
            <Row label="Fiscal year">
              <span className="text-muted-foreground">
                {opp.fiscalYear ?? "—"}
              </span>
            </Row>
            <Row label="Covered FYs">
              <span className="text-muted-foreground">
                {opp.coveredFiscalYears && opp.coveredFiscalYears.length > 0
                  ? opp.coveredFiscalYears.join(", ")
                  : "—"}
              </span>
            </Row>
            <Row label="Entities">
              {entityLabels.length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                entityLabels.join(", ")
              )}
            </Row>
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
          <PledgeAllocationsEditor
            pledgeOrOpportunityId={opp.id}
            allocations={opp.allocations ?? []}
          />
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

      <Card>
        <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
        <CardContent className="space-y-4 text-sm">
          <EditableNote
            label="Conditions"
            testIdBase="opp-conditions"
            value={opp.conditions ?? null}
            onSave={(next) => patch({ conditions: next })}
          />
          <EditableNote
            label="Payment details"
            testIdBase="opp-payment-details"
            value={opp.paymentDetails ?? null}
            onSave={(next) => patch({ paymentDetails: next })}
          />
          <EditableNote
            label="Usage notes"
            testIdBase="opp-usage-notes"
            value={opp.usageNotes ?? null}
            onSave={(next) => patch({ usageNotes: next })}
          />
          <EditableNote
            label="Loss reason"
            testIdBase="opp-loss-reason"
            value={opp.lossReason ?? null}
            onSave={(next) => patch({ lossReason: next })}
          />
        </CardContent>
      </Card>

      {/* Activity timeline scoped to whichever donor this opportunity is
          linked to. Opportunities don't have their own activity arrays;
          the relevant signal is "everything we've heard from / about the
          donor" so we just reuse the donor's timeline here. */}
      {(opp.funderId || opp.individualGiverPersonId || opp.householdId) && (
        <ActivityTimeline
          funderId={opp.funderId ?? undefined}
          personId={opp.individualGiverPersonId ?? undefined}
          householdId={opp.householdId ?? undefined}
        />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <NotesPanel opportunityId={opp.id} />
        <TasksPanel opportunityId={opp.id} />
      </div>

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

function EditableNote({
  label,
  testIdBase,
  value,
  onSave,
}: {
  label: string;
  testIdBase: string;
  value: string | null;
  onSave: (next: string | null) => Promise<unknown> | unknown;
}) {
  const display = value ? (
    <p className="whitespace-pre-wrap text-left">{value}</p>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
      <InlineEditTextarea
        label={label}
        testIdBase={testIdBase}
        value={value}
        display={display}
        onSave={onSave}
        placeholder={`Add ${label.toLowerCase()}…`}
      />
    </div>
  );
}
