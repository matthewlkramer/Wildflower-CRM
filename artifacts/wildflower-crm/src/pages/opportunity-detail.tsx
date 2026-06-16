import { useState, type ReactNode } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetOpportunityOrPledge,
  useUpdateOpportunityOrPledge,
  useDeleteOpportunityOrPledge,
  useListEntities,
  useGetOrganization,
  useGetHousehold,
  getGetOpportunityOrPledgeQueryKey,
  getGetOrganizationQueryKey,
  getGetHouseholdQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  type OpportunityOrPledgeDetail,
  type UpdateOpportunityOrPledgeBody,
  type OpportunityStage,
  type OpportunityStatus,
  type OpportunityLossType,
  type OpportunityType,
  type OpportunityConditional,
  type PeopleEntityRole,
} from "@workspace/api-client-react";
import { PledgeAllocationsEditor } from "@/components/allocation-editors";
import { UnifiedActivityFeed } from "@/components/unified-activity-feed";
import { TasksPanel } from "@/components/tasks-panel";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { EditPeopleEntityRoleDialog } from "@/components/add-role-dialogs";
import { GrantLetterUpload } from "@/components/grant-letter-upload";
import { ReportingDeadlinesDialog } from "@/components/reporting-deadlines-dialog";
import {
  InlineEditBoolean,
  InlineEditDate,
  InlineEditSelect,
  InlineEditText,
  InlineEditTextarea,
  EditTriggerRow,
  ActionButtons,
  useSaveRunner,
  type InlineSelectOption,
  type SaveResult,
} from "@/components/inline-edit";
import { InlineEditUserPicker, useUserNameMap } from "@/components/user-picker";
import {
  InlineEditPersonPicker,
  InlineEditOrganizationPicker,
  InlineEditHouseholdPicker,
  usePersonName,
  useOrganizationName,
  useHouseholdName,
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
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency, formatDate, formatEnum, formatPercent } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

const STAGE_OPTIONS = [
  { value: "cold_lead", label: "Cold lead" },
  { value: "warm_lead", label: "Warm lead" },
  { value: "in_conversation", label: "In conversation" },
  { value: "convince", label: "Convince" },
  { value: "conditional_commitment", label: "Conditional commitment" },
  { value: "probable_renewal", label: "Probable renewal" },
  { value: "verbal_confirmation", label: "Verbal confirmation" },
  { value: "written_commitment", label: "Written commitment" },
  { value: "cash_in", label: "Cash in" },
] as const satisfies ReadonlyArray<InlineSelectOption<OpportunityStage>>;

// `status` is fully calculated server-side and shown read-only. The only
// user-settable override is `lossType` (None / Dormant / Lost).
const LOSS_TYPE_OPTIONS = [
  { value: "dormant", label: "Dormant" },
  { value: "lost", label: "Lost" },
] as const satisfies ReadonlyArray<InlineSelectOption<OpportunityLossType>>;

const TYPE_OPTIONS = [
  { value: "solicitation", label: "Solicitation" },
  { value: "renewal", label: "Renewal" },
  { value: "open_application", label: "Open application" },
] as const satisfies ReadonlyArray<InlineSelectOption<OpportunityType>>;

const CONDITIONAL_OPTIONS = [
  { value: "unconditional", label: "Unconditional" },
  { value: "conditional_unspecified", label: "Conditional (unspecified)" },
  { value: "reimbursable", label: "Reimbursable" },
  { value: "conditional_on_funder_determination", label: "Conditional — funder determination" },
  { value: "conditional_on_target", label: "Conditional — on target" },
] as const satisfies ReadonlyArray<InlineSelectOption<OpportunityConditional>>;
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DerivedRow } from "@/components/derived-row";

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
  const [, navigate] = useLocation();
  const [reportingDialogOpen, setReportingDialogOpen] = useState(false);

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(opp.name ?? "");

  const update = useUpdateOpportunityOrPledge({
    mutation: {
      onSuccess: async (response) => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetOpportunityOrPledgeQueryKey(opp.id) }),
          queryClient.invalidateQueries({ queryKey: getListOpportunitiesAndPledgesQueryKey() }),
        ]);
        toast({ title: `${entityLabel} updated` });
        // The server sets `promptForReportingDeadlines` on the PATCH
        // response only when status flipped into pledge/cash_in AND
        // there are zero existing reporting_deadline tasks on this opp.
        // Treat the flag as transient — opening the dialog is the
        // entire UX; ignored if the user dismisses.
        const prompt = response?.promptForReportingDeadlines;
        if (prompt) setReportingDialogOpen(true);
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

  function patch(body: UpdateOpportunityOrPledgeBody) {
    return update.mutateAsync({ id: opp.id, data: body });
  }

  async function saveName() {
    const trimmed = nameValue.trim();
    if (trimmed === (opp.name ?? "")) {
      setEditingName(false);
      return;
    }
    await patch({ name: trimmed || null });
    setEditingName(false);
  }

  // Resolve entity slugs (from pledge_allocations) to human names so
  // the Allocations summary list can show real labels.
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

  const funderName = useOrganizationName(opp.organizationId ?? null);
  const giverName = usePersonName(opp.individualGiverPersonId ?? null);
  const householdName = useHouseholdName(opp.householdId ?? null);
  const advisorName = usePersonName(opp.individualAdvisorPersonId ?? null);
  const primaryContactName = usePersonName(opp.primaryContactPersonId ?? null);

  // Fetch the linked donor entities so the People card can list the people
  // associated with the funder / household (mirrors the gift-detail layout).
  const funderDetail = useGetOrganization(opp.organizationId ?? "", {
    query: {
      queryKey: getGetOrganizationQueryKey(opp.organizationId ?? ""),
      enabled: !!opp.organizationId,
    },
  });
  const householdDetail = useGetHousehold(opp.householdId ?? "", {
    query: {
      queryKey: getGetHouseholdQueryKey(opp.householdId ?? ""),
      enabled: !!opp.householdId,
    },
  });

  const associatedPeople: PeopleEntityRole[] = [];
  const seenPeople = new Set<string>();
  for (const role of [
    ...(funderDetail.data?.people ?? []),
    ...(householdDetail.data?.people ?? []),
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

  let donorDisplay: ReactNode = (
    <span className="text-muted-foreground">No donor linked.</span>
  );
  if (opp.organizationId) {
    donorDisplay = (
      <span>
        <span className="text-muted-foreground mr-1">Funder:</span>
        <Link
          href={`/organizations/${opp.organizationId}`}
          className="text-primary hover:underline"
        >
          {funderName ?? opp.organizationId}
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

  const funderLinkDisplay: ReactNode = opp.organizationId ? (
    <Link
      href={`/organizations/${opp.organizationId}`}
      className="text-primary hover:underline"
    >
      {funderName ?? opp.organizationId}
    </Link>
  ) : (
    "—"
  );
  const householdLinkDisplay: ReactNode = opp.householdId ? (
    <Link
      href={`/households/${opp.householdId}`}
      className="text-primary hover:underline"
    >
      {householdName ?? opp.householdId}
    </Link>
  ) : (
    "—"
  );
  const individualLinkDisplay: ReactNode = opp.individualGiverPersonId ? (
    <Link
      href={`/individuals/${opp.individualGiverPersonId}`}
      className="text-primary hover:underline"
    >
      {giverName ?? opp.individualGiverPersonId}
    </Link>
  ) : (
    "—"
  );

  // The donor is one of (funder, individual giver, household), DB-enforced XOR.
  // Each setter sends all three FK fields so exactly one stays populated.
  const setFunderDonor = (next: string | null) =>
    patch({ organizationId: next, individualGiverPersonId: null, householdId: null });
  const setHouseholdDonor = (next: string | null) =>
    patch({ householdId: next, organizationId: null, individualGiverPersonId: null });
  const setIndividualDonor = (next: string | null) =>
    patch({ individualGiverPersonId: next, organizationId: null, householdId: null });

  const title = editingName ? (
    <Input
      value={nameValue}
      onChange={(e) => setNameValue(e.target.value)}
      className="h-11 max-w-md font-serif text-2xl font-bold"
      aria-label={`${entityLabel} name`}
      data-testid="input-opp-name"
      autoFocus
    />
  ) : (
    (opp.name ?? `Untitled ${opp.id}`)
  );

  const actions = editingName ? (
    <>
      <Button
        onClick={saveName}
        disabled={update.isPending}
        data-testid="button-save-opp-name"
      >
        {update.isPending ? "Saving…" : "Save"}
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setNameValue(opp.name ?? "");
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
        data-testid="button-edit-opp-name"
      >
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
    </>
  );

  // `status` is fully calculated server-side; the only thing the user can
  // set is the lossType override (dormant/lost). Convenience: when marking
  // a single opp dormant/lost with no completion date yet, default to today
  // so the user doesn't have to set it manually. (The bulk-edit path
  // intentionally does NOT do this.)
  const saveLossType = (next: OpportunityLossType | null) => {
    const body: UpdateOpportunityOrPledgeBody = { lossType: next };
    if (next && !opp.actualCompletionDate) {
      body.actualCompletionDate = new Date().toISOString().slice(0, 10);
    }
    return patch(body);
  };

  const statusBadge = (status: OpportunityStatus | null) =>
    status ? (
      <Badge
        variant={status === "cash_in" || status === "pledge" ? "default" : "outline"}
      >
        {formatEnum(status)}
      </Badge>
    ) : (
      <span className="text-muted-foreground">—</span>
    );

  // Each cell shows ONE of a pair (awarded over ask; actual over projected)
  // but on edit exposes BOTH underlying fields.
  const amountIsAwarded = opp.awardedAmount != null;
  const closeIsActual = opp.actualCompletionDate != null;

  const highlights: Highlight[] = [
    {
      label: "Loss type",
      value: (
        <InlineEditSelect
          align="left"
          label="Loss type"
          testIdBase="opp-loss-type"
          value={opp.lossType ?? null}
          options={LOSS_TYPE_OPTIONS}
          allowNull
          nullLabel="— None —"
          display={opp.lossType ? formatEnum(opp.lossType) : "—"}
          onSave={saveLossType}
        />
      ),
    },
    {
      label: "Stage",
      accent: true,
      value: (
        <InlineEditSelect
          align="left"
          label="Stage"
          testIdBase="opp-stage"
          value={opp.stage ?? null}
          options={STAGE_OPTIONS}
          display={formatEnum(opp.stage) || "—"}
          onSave={(next) => patch({ stage: next })}
        />
      ),
    },
    {
      label: "Type",
      value: (
        <InlineEditSelect
          align="left"
          label="Type"
          testIdBase="opp-type"
          value={opp.type ?? null}
          options={TYPE_OPTIONS}
          display={formatEnum(opp.type) || "—"}
          onSave={(next) => patch({ type: next })}
        />
      ),
    },
    {
      label: amountIsAwarded ? "Awarded" : "Ask",
      value: (
        <InlineEditAmounts
          ask={opp.askAmount ?? null}
          awarded={opp.awardedAmount ?? null}
          onSave={(body) => patch(body)}
        />
      ),
    },
    {
      label: closeIsActual ? "Completed" : "Projected close",
      value: (
        <InlineEditCloseDates
          projected={opp.projectedCloseDate ?? null}
          actual={opp.actualCompletionDate ?? null}
          onSave={(body) => patch(body)}
        />
      ),
    },
    {
      label: "Owner",
      value: (
        <InlineEditUserPicker
          align="left"
          testIdBase="opp-owner"
          value={opp.ownerUserId ?? null}
          display={ownerDisplay}
          onSave={(next) => patch({ ownerUserId: next })}
        />
      ),
    },
  ];

  const allocations = opp.allocations ?? [];
  const payments = opp.payments ?? [];

  // Pill target: awarded amount if present, else the ask. Sums compare
  // allocations / payments against it.
  const targetRaw = opp.awardedAmount ?? opp.askAmount ?? null;
  const targetAmount = targetRaw == null ? null : toNum(targetRaw);
  const allocationsSum = allocations.reduce((s, a) => s + toNum(a.subAmount), 0);
  const paymentsSum = payments.reduce((s, p) => s + toNum(p.amount), 0);

  // Status badge (calculated server-side) and fiscal-year pill shown next to
  // the "Opportunity" type badge in the header.
  const headerBadges = (
    <>
      <span data-testid="text-opp-status" className="flex items-center">
        {statusBadge(opp.status ?? null)}
      </span>
      {opp.fiscalYear ? (
        <Badge
          variant="outline"
          className="rounded-full"
          data-testid="badge-opp-fy"
        >
          {opp.fiscalYear}
        </Badge>
      ) : null}
    </>
  );

  const subtitle = donorDisplay;

  return (
    <>
      <RecordLayout
        backHref={backHref}
        backLabel={backLabel.replace(/^←\s*/, "")}
        title={title}
        typeBadge={entityLabel}
        headerBadges={headerBadges}
        subtitle={subtitle}
        actions={actions}
        highlights={highlights}
        left={
          <>
            <FieldCard title="Pipeline">
              <div className="space-y-1">
                <Row label="Application deadline">
                  <InlineEditDate
                    label="Application deadline"
                    testIdBase="opp-app-deadline"
                    value={opp.applicationDeadline ?? null}
                    display={formatDate(opp.applicationDeadline)}
                    onSave={(next) => patch({ applicationDeadline: next })}
                  />
                </Row>
                <Row label="Win probability">
                  <InlineEditText
                    label="Win probability"
                    testIdBase="opp-winprob"
                    value={opp.winProbability ?? null}
                    placeholder="e.g. 75% or 0.75"
                    display={formatPercent(opp.winProbability)}
                    onSave={(next) => patch({ winProbability: next })}
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
                    File upload via presigned URL → /api/storage/objects/<id>.
                    Setting a URL also flips was_pledge sticky-true on
                    the server side (see applyDerivedOppFields).
                  */}
                  <GrantLetterUpload
                    url={opp.grantLetterUrl ?? null}
                    filename={opp.grantLetterFilename ?? null}
                    onUploaded={(next) =>
                      patch({
                        grantLetterUrl: next.grantLetterUrl,
                        grantLetterFilename: next.grantLetterFilename,
                      })
                    }
                    onCleared={() =>
                      patch({ grantLetterUrl: null, grantLetterFilename: null })
                    }
                  />
                </Row>
              </div>
            </FieldCard>

            <FieldCard title="Conditions">
              <div className="space-y-1">
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
                <div className="pt-2">
                  <EditableNote
                    label="Conditions"
                    testIdBase="opp-conditions"
                    value={opp.conditions ?? null}
                    onSave={(next) => patch({ conditions: next })}
                  />
                </div>
              </div>
            </FieldCard>

            <FieldCard title="Other details" defaultOpen={false}>
              <div className="space-y-4">
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
              </div>
            </FieldCard>

            <RelatedCard
              title="Allocations"
              count={allocations.length}
              action={
                <ProgressPill
                  sum={allocationsSum}
                  target={targetAmount}
                  fullLabel="Fully allocated"
                  overLabel="Over allocated"
                  underLabel="Under allocated"
                />
              }
            >
              <div className="space-y-4 px-2 py-1">
                <div className="space-y-2 text-sm">
                  <DerivedRow label="Covered FYs" hint="derived from allocations">
                    {opp.coveredFiscalYears && opp.coveredFiscalYears.length > 0
                      ? opp.coveredFiscalYears.join(", ")
                      : "—"}
                  </DerivedRow>
                  <DerivedRow label="Entities" hint="derived from allocations">
                    {entityLabels.length === 0 ? "—" : entityLabels.join(", ")}
                  </DerivedRow>
                </div>
                <PledgeAllocationsEditor
                  pledgeOrOpportunityId={opp.id}
                  allocations={opp.allocations ?? []}
                  totalAmount={targetAmount}
                />
              </div>
            </RelatedCard>

            <RelatedCard
              title="Payments"
              count={payments.length}
              action={
                <ProgressPill
                  sum={paymentsSum}
                  target={targetAmount}
                  fullLabel="Fully paid"
                  overLabel="Over paid"
                  underLabel="Not fully paid"
                />
              }
            >
              {payments.length > 0 ? (
                <div>
                  {payments.map((p) => (
                    <div key={p.id} data-testid={`row-opp-payment-${p.id}`}>
                      <RelatedRow
                        name={p.name ?? `Payment ${p.id}`}
                        href={`/gifts/${p.id}`}
                        tone="primary"
                        sub={formatDate(p.dateReceived)}
                        amount={formatCurrency(p.amount)}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-2 py-2 text-sm text-muted-foreground">No payments yet.</p>
              )}
            </RelatedCard>

            <div className="px-1 text-xs text-muted-foreground">
              Created {formatDate(opp.createdAt)} • Updated {formatDate(opp.updatedAt)}
            </div>
          </>
        }
        center={
          // Activity (interactions/emails/calendar/meetings) is scoped to
          // whichever donor this opportunity is linked to — opportunities
          // don't have their own activity arrays — while notes & tasks link
          // to the opportunity itself. Tasks sit above the activity feed.
          (() => {
            const personIds: string[] = [];
            if (opp.individualGiverPersonId) personIds.push(opp.individualGiverPersonId);
            if (opp.primaryContactPersonId && opp.primaryContactPersonId !== opp.individualGiverPersonId) {
              personIds.push(opp.primaryContactPersonId);
            }
            const oppDefaultLinks: Partial<{ personIds: string[]; organizationIds: string[]; householdIds: string[]; opportunityIds: string[]; giftIds: string[] }> = {
              ...(opp.organizationId ? { organizationIds: [opp.organizationId] } : {}),
              ...(opp.householdId ? { householdIds: [opp.householdId] } : {}),
              ...(personIds.length > 0 ? { personIds } : {}),
            };
            return (
              <>
                <TasksPanel opportunityId={opp.id} defaultLinks={oppDefaultLinks} />
                <UnifiedActivityFeed
                  organizationId={opp.organizationId ?? undefined}
                  personId={opp.individualGiverPersonId ?? undefined}
                  householdId={opp.householdId ?? undefined}
                  notesContext={{ opportunityId: opp.id, defaultLinks: oppDefaultLinks }}
                  hideTasks
                />
              </>
            );
          })()
        }
        right={
          <>
            <RelatedCard title="Organizations">
              <div className="space-y-1 px-2 py-1">
                <Row label="Funder">
                  <InlineEditOrganizationPicker
                    testIdBase="opp-funder"
                    value={opp.organizationId ?? null}
                    display={funderLinkDisplay}
                    onSave={setFunderDonor}
                    allowNull={false}
                  />
                </Row>
                <Row label="Household">
                  <InlineEditHouseholdPicker
                    testIdBase="opp-household"
                    value={opp.householdId ?? null}
                    display={householdLinkDisplay}
                    onSave={setHouseholdDonor}
                    allowNull={false}
                  />
                </Row>
              </div>
            </RelatedCard>

            <RelatedCard
              title="People"
              count={associatedPeople.length || undefined}
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
                <Row label="Individual donor">
                  <InlineEditPersonPicker
                    testIdBase="opp-individual-giver"
                    value={opp.individualGiverPersonId ?? null}
                    display={individualLinkDisplay}
                    onSave={setIndividualDonor}
                    allowNull={false}
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
                <Row label="Advisor">
                  <InlineEditPersonPicker
                    testIdBase="opp-advisor"
                    value={opp.individualAdvisorPersonId ?? null}
                    display={advisorDisplay}
                    onSave={(next) => patch({ individualAdvisorPersonId: next })}
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
                      <div key={role.id} data-testid={`row-opp-person-${role.personId}`}>
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
          </>
        }
      />

      <ReportingDeadlinesDialog
        opportunityId={opp.id}
        funderName={funderName ?? null}
        open={reportingDialogOpen}
        onOpenChange={setReportingDialogOpen}
      />
    </>
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

// Coerce a nullable numeric string ("1,200" / "1200.5" / null) to a number,
// guarding against NaN so reduce() sums stay finite.
function toNum(v: string | null | undefined): number {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[,$\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// Compares a running sum against a target (awarded ?? ask). Renders nothing
// when there's no positive target to measure against.
function ProgressPill({
  sum,
  target,
  fullLabel,
  overLabel,
  underLabel,
}: {
  sum: number;
  target: number | null;
  fullLabel: string;
  overLabel: string;
  underLabel: string;
}) {
  if (target == null || target <= 0) return null;
  const diff = sum - target;
  const eps = 0.005;
  if (Math.abs(diff) < eps) {
    return (
      <Badge variant="default" className="rounded-full" data-testid="pill-progress">
        {fullLabel}
      </Badge>
    );
  }
  if (diff > 0) {
    return (
      <Badge variant="destructive" className="rounded-full" data-testid="pill-progress">
        {overLabel}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="rounded-full" data-testid="pill-progress">
      {underLabel}
    </Badge>
  );
}

// Combined Ask + Awarded editor. The cell displays awarded (falling back to
// ask) but on edit exposes BOTH fields and patches them together.
function InlineEditAmounts({
  ask,
  awarded,
  onSave,
}: {
  ask: string | null;
  awarded: string | null;
  onSave: (body: UpdateOpportunityOrPledgeBody) => SaveResult;
}) {
  const [editing, setEditing] = useState(false);
  const { busy, run } = useSaveRunner();
  const [askDraft, setAskDraft] = useState(ask ?? "");
  const [awardedDraft, setAwardedDraft] = useState(awarded ?? "");

  const display = formatCurrency(awarded ?? ask);

  if (!editing) {
    return (
      <EditTriggerRow
        align="left"
        display={display}
        onEdit={() => {
          setAskDraft(ask ?? "");
          setAwardedDraft(awarded ?? "");
          setEditing(true);
        }}
        testIdBase="opp-amounts"
        ariaLabel="Edit ask and awarded amounts"
      />
    );
  }

  const parse = (s: string): { value: string | null; ok: boolean } => {
    const t = s.trim();
    if (t.length === 0) return { value: null, ok: true };
    const n = Number(t.replace(/[,$\s]/g, ""));
    const ok = Number.isFinite(n) && n >= 0;
    return { value: ok ? String(n) : null, ok };
  };

  const askParsed = parse(askDraft);
  const awardedParsed = parse(awardedDraft);
  const askCurrent = ask == null ? null : String(Number(ask));
  const awardedCurrent = awarded == null ? null : String(Number(awarded));
  const dirty =
    askParsed.value !== askCurrent || awardedParsed.value !== awardedCurrent;
  const canSave = askParsed.ok && awardedParsed.ok && dirty;

  const trySave = () => {
    if (!canSave || busy) return;
    run(
      () =>
        onSave({ askAmount: askParsed.value, awardedAmount: awardedParsed.value }),
      () => setEditing(false),
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="w-16 shrink-0 text-left">Ask</span>
        <Input
          value={askDraft}
          onChange={(e) => setAskDraft(e.target.value)}
          inputMode="decimal"
          aria-label="Ask amount"
          aria-invalid={!askParsed.ok}
          disabled={busy}
          data-testid="input-opp-ask"
          className="h-8"
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="w-16 shrink-0 text-left">Awarded</span>
        <Input
          value={awardedDraft}
          onChange={(e) => setAwardedDraft(e.target.value)}
          inputMode="decimal"
          aria-label="Awarded amount"
          aria-invalid={!awardedParsed.ok}
          disabled={busy}
          data-testid="input-opp-awarded"
          className="h-8"
        />
      </label>
      <div className="flex items-center justify-start gap-1">
        <ActionButtons
          busy={busy}
          canSave={canSave}
          onSave={trySave}
          onCancel={() => setEditing(false)}
          testIdBase="opp-amounts"
          label="amounts"
        />
      </div>
    </div>
  );
}

// Combined Projected-close + Actual-completion editor. The cell displays the
// actual date (falling back to projected) but on edit exposes BOTH.
function InlineEditCloseDates({
  projected,
  actual,
  onSave,
}: {
  projected: string | null;
  actual: string | null;
  onSave: (body: UpdateOpportunityOrPledgeBody) => SaveResult;
}) {
  const [editing, setEditing] = useState(false);
  const { busy, run } = useSaveRunner();
  const [projectedDraft, setProjectedDraft] = useState(projected ?? "");
  const [actualDraft, setActualDraft] = useState(actual ?? "");

  const display = formatDate(actual ?? projected);

  if (!editing) {
    return (
      <EditTriggerRow
        align="left"
        display={display}
        onEdit={() => {
          setProjectedDraft(projected ?? "");
          setActualDraft(actual ?? "");
          setEditing(true);
        }}
        testIdBase="opp-close-dates"
        ariaLabel="Edit projected close and actual completion dates"
      />
    );
  }

  const projectedNext = projectedDraft.trim().length === 0 ? null : projectedDraft;
  const actualNext = actualDraft.trim().length === 0 ? null : actualDraft;
  const dirty =
    projectedNext !== (projected ?? null) || actualNext !== (actual ?? null);

  const trySave = () => {
    if (!dirty || busy) return;
    run(
      () =>
        onSave({
          projectedCloseDate: projectedNext,
          actualCompletionDate: actualNext,
        }),
      () => setEditing(false),
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="w-20 shrink-0 text-left">Projected</span>
        <Input
          type="date"
          value={projectedDraft}
          onChange={(e) => setProjectedDraft(e.target.value)}
          aria-label="Projected close date"
          disabled={busy}
          data-testid="input-opp-projected-close"
          className="h-8"
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="w-20 shrink-0 text-left">Completed</span>
        <Input
          type="date"
          value={actualDraft}
          onChange={(e) => setActualDraft(e.target.value)}
          aria-label="Actual completion date"
          disabled={busy}
          data-testid="input-opp-actual-completion"
          className="h-8"
        />
      </label>
      <div className="flex items-center justify-start gap-1">
        <ActionButtons
          busy={busy}
          canSave={dirty}
          onSave={trySave}
          onCancel={() => setEditing(false)}
          testIdBase="opp-close-dates"
          label="dates"
        />
      </div>
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
