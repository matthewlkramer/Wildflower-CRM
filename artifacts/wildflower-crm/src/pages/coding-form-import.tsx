import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCodingFormRows,
  getListCodingFormRowsQueryKey,
  useGetCodingFormSummary,
  useGetCodingFormGrantAgreementsSummary,
  getGetCodingFormGrantAgreementsSummaryQueryKey,
  usePullGrantAgreement,
  useSetCodingFormMatch,
  useApplyCodingFormRow,
  useSkipCodingFormRow,
  useRematchCodingFormRow,
  useRematchPendingCodingFormRows,
  useConfirmCodingFormMatch,
  useConfirmMatchedCodingFormRows,
  useApplyDecidedCodingFormRows,
  usePullGrantAgreementsBulk,
  useReinterpretCodingFormRow,
  useReinterpretCodingFormRows,
  useListEntities,
  CodingFormRowStatus,
  CodingFormGrantAgreementStatus,
  ListCodingFormRowsSource,
  ListCodingFormRowsMatchTier,
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  useGetOpportunityOrPledge,
  getGetOpportunityOrPledgeQueryKey,
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  useGetGiftOrPayment,
  getGetGiftOrPaymentQueryKey,
  type CodingFormRow,
  type CodingFormCrossCheck,
  type CodingFormGrantAgreement,
  type ListCodingFormRowsParams,
  type ApplyCodingFormRowBodyDecisions,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { formatDateShort } from "@/lib/format";
import {
  canOverrideCrossCheck,
  isCrossCheckApplyable,
} from "@/lib/coding-form-gating";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EntityCombobox,
  useOrganizationSearch,
  useOrganizationName,
  usePersonSearch,
  usePersonName,
  useHouseholdSearch,
  useHouseholdName,
} from "@/components/entity-picker";

const CODING_KEY_PREFIX = "/api/coding-form-rows";

type CrossStatus = CodingFormCrossCheck["status"];

const CROSS_STATUS_LABEL: Record<CrossStatus, string> = {
  new: "New",
  same: "Same",
  conflict: "Conflict",
  na: "N/A",
};

const CROSS_STATUS_VARIANT: Record<
  CrossStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  new: "default",
  same: "secondary",
  conflict: "destructive",
  na: "outline",
};

const ROW_STATUS_LABEL: Record<CodingFormRowStatus, string> = {
  pending: "Pending",
  applied: "Applied",
  skipped: "Skipped",
};

const SOURCE_LABEL: Record<string, string> = {
  fy24: "FY24",
  fy25: "FY25",
  fy26: "FY26",
  fy27: "FY27",
  girasol: "Girasol",
};

type GrantAgreementStatus = CodingFormGrantAgreement["status"];

// `held` is a summary-only synthetic bucket (not a per-row derived status):
// ready/failed rows the bulk pull will NOT attempt because the row is skipped
// or its match is unconfirmed — still pullable per-row.
const GA_STATUS_LABEL: Record<GrantAgreementStatus | "held", string> = {
  na: "No link",
  no_match: "No match",
  ready: "Ready",
  imported: "Imported",
  conflict: "Conflict",
  failed: "Failed",
  held: "Held (skipped/unconfirmed)",
};

const GA_STATUS_VARIANT: Record<
  GrantAgreementStatus | "held",
  "default" | "secondary" | "destructive" | "outline"
> = {
  na: "outline",
  no_match: "outline",
  ready: "default",
  imported: "secondary",
  conflict: "destructive",
  failed: "destructive",
  held: "outline",
};

const AI_JUNK_LABEL: Record<string, string> = {
  internalMemo: "Internal memo",
  restrictionLanguage: "Restriction language",
  additionalNotes: "Additional notes",
  circleRaw: "Circle",
  seriesTypeRaw: "Series type",
  donorNameAddressRaw: "Name+address blob",
  reportRequiredRaw: "Report answer",
};

/** AI reinterpretation provenance: what the model changed and why. The
 *  effective values already flow through the cross-checks server-side — this
 *  block only shows the reviewer the AI's contribution (or its failure). */
function AiInterpretationBlock({ row }: { row: CodingFormRow }) {
  const ai = row.aiInterpretation ?? null;
  if (!ai && !row.aiError) return null;

  if (!ai) {
    return (
      <div
        className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
        data-testid={`ai-error-${row.id}`}
      >
        <span className="font-medium">AI reinterpretation failed: </span>
        {row.aiError}
      </div>
    );
  }

  const address = ai.address
    ? [
        ai.address.street,
        ai.address.city,
        ai.address.state,
        ai.address.postal,
        ai.address.country,
      ]
        .filter(Boolean)
        .join(", ")
    : null;

  const items: Array<{ label: string; value: string }> = [];
  if (ai.donorName) items.push({ label: "Donor name", value: ai.donorName });
  if (address) items.push({ label: "Address", value: address });
  if (ai.reportRequired !== null && ai.reportRequired !== undefined)
    items.push({
      label: "Report required",
      value: ai.reportRequired ? "Yes" : "No",
    });
  if (ai.reportDueDate)
    items.push({ label: "Report due", value: ai.reportDueDate });

  return (
    <div
      className="rounded-md border border-violet-200 bg-violet-50 p-2 text-xs text-violet-950 space-y-1"
      data-testid={`ai-interpretation-${row.id}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium uppercase text-[11px]">
          AI interpretation
        </span>
        <span className="text-violet-700">
          {row.aiModel ?? "model"}
          {row.aiInterpretedAt
            ? ` · ${formatDateShort(row.aiInterpretedAt)}`
            : ""}
        </span>
      </div>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5">
          {items.map((it) => (
            <span key={it.label}>
              <span className="text-violet-700">{it.label}: </span>
              <span className="font-medium">{it.value}</span>
            </span>
          ))}
        </div>
      ) : null}
      {ai.junkFields.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-violet-700">Flagged as junk:</span>
          {ai.junkFields.map((f) => (
            <Badge
              key={f}
              variant="outline"
              className="border-violet-300 text-violet-900"
            >
              {AI_JUNK_LABEL[f] ?? f}
            </Badge>
          ))}
        </div>
      ) : null}
      {ai.notes ? <p className="text-violet-800 italic">{ai.notes}</p> : null}
    </div>
  );
}

type DonorKind = "organization" | "individual" | "household";

function donorKindOf(row: CodingFormRow): DonorKind {
  if (row.individualGiverPersonId) return "individual";
  if (row.householdId) return "household";
  return "organization";
}

const PICKER_LIMIT = 20;
const PICKER_STALE = 60_000;

function useOpportunitySearch(query: string) {
  const params = query
    ? { search: query, limit: PICKER_LIMIT }
    : { limit: PICKER_LIMIT };
  const q = useListOpportunitiesAndPledges(params, {
    query: {
      queryKey: getListOpportunitiesAndPledgesQueryKey(params),
      staleTime: PICKER_STALE,
    },
  });
  const items = useMemo(
    () =>
      (q.data?.data ?? []).map((o) => ({
        id: o.id,
        label: o.name ?? o.id,
      })),
    [q.data],
  );
  return { items, isLoading: q.isLoading };
}

function useOpportunityName(id: string | null): string | null {
  const q = useGetOpportunityOrPledge(id ?? "", {
    query: {
      queryKey: getGetOpportunityOrPledgeQueryKey(id ?? ""),
      enabled: !!id,
      staleTime: 5 * 60_000,
    },
  });
  return id && q.data ? q.data.name ?? q.data.id : null;
}

function useGiftSearch(query: string) {
  const params = query
    ? { search: query, limit: PICKER_LIMIT }
    : { limit: PICKER_LIMIT };
  const q = useListGiftsAndPayments(params, {
    query: {
      queryKey: getListGiftsAndPaymentsQueryKey(params),
      staleTime: PICKER_STALE,
    },
  });
  const items = useMemo(
    () =>
      (q.data?.data ?? []).map((g) => ({
        id: g.id,
        label: g.name ?? g.id,
        sublabel: [g.amount ? `$${g.amount}` : null, g.dateReceived ?? null]
          .filter(Boolean)
          .join(" · "),
      })),
    [q.data],
  );
  return { items, isLoading: q.isLoading };
}

function useGiftName(id: string | null): string | null {
  const q = useGetGiftOrPayment(id ?? "", {
    query: {
      queryKey: getGetGiftOrPaymentQueryKey(id ?? ""),
      enabled: !!id,
      staleTime: 5 * 60_000,
    },
  });
  return id && q.data ? q.data.name ?? q.data.id : null;
}

/** Per-row donor picker enforcing donor XOR. */
function DonorMatchEditor({
  row,
  onSet,
  disabled,
}: {
  row: CodingFormRow;
  onSet: (next: {
    organizationId: string | null;
    individualGiverPersonId: string | null;
    householdId: string | null;
  }) => void;
  disabled?: boolean;
}) {
  const [kind, setKind] = useState<DonorKind>(donorKindOf(row));

  const currentId =
    kind === "organization"
      ? row.organizationId ?? null
      : kind === "individual"
        ? row.individualGiverPersonId ?? null
        : row.householdId ?? null;

  const handleChange = (next: string | null) => {
    onSet({
      organizationId: kind === "organization" ? next : null,
      individualGiverPersonId: kind === "individual" ? next : null,
      householdId: kind === "household" ? next : null,
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={kind}
        onValueChange={(v) => setKind(v as DonorKind)}
        disabled={disabled}
      >
        <SelectTrigger className="w-40" data-testid={`select-donor-kind-${row.id}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="organization">Organization</SelectItem>
          <SelectItem value="individual">Individual</SelectItem>
          <SelectItem value="household">Household</SelectItem>
        </SelectContent>
      </Select>
      <div className="min-w-[16rem]">
        {kind === "organization" ? (
          <EntityCombobox
            useSearch={useOrganizationSearch}
            useResolve={useOrganizationName}
            value={currentId}
            onChange={handleChange}
            allowNull
            disabled={disabled}
            placeholder="Search organizations…"
            testId={`donor-org-${row.id}`}
          />
        ) : kind === "individual" ? (
          <EntityCombobox
            useSearch={usePersonSearch}
            useResolve={usePersonName}
            value={currentId}
            onChange={handleChange}
            allowNull
            disabled={disabled}
            placeholder="Search people…"
            testId={`donor-person-${row.id}`}
          />
        ) : (
          <EntityCombobox
            useSearch={useHouseholdSearch}
            useResolve={useHouseholdName}
            value={currentId}
            onChange={handleChange}
            allowNull
            disabled={disabled}
            placeholder="Search households…"
            testId={`donor-household-${row.id}`}
          />
        )}
      </div>
    </div>
  );
}

function RowCard({ row }: { row: CodingFormRow }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const setMatch = useSetCodingFormMatch();
  const applyMut = useApplyCodingFormRow();
  const skipMut = useSkipCodingFormRow();
  const rematchMut = useRematchCodingFormRow();
  const confirmMut = useConfirmCodingFormMatch();
  const reinterpretMut = useReinterpretCodingFormRow();

  // Which applicable cross-checks the reviewer has toggled ON to apply.
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  // Per-attribute override values. Initialized from stored overrideValue
  // returned by the server; reviewer can change them before applying.
  const [overrides, setOverrides] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const c of row.crossChecks) {
      if (c.overrideValue != null) init[c.attribute] = c.overrideValue;
    }
    return init;
  });

  // Fund entities for the allocationEntity override picker.
  const { data: entities } = useListEntities();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: [CODING_KEY_PREFIX] });

  const pending =
    setMatch.isPending ||
    applyMut.isPending ||
    skipMut.isPending ||
    rematchMut.isPending ||
    confirmMut.isPending ||
    reinterpretMut.isPending;

  const onError = (verb: string) => (err: unknown) =>
    toast({
      title: `Couldn't ${verb}`,
      description: err instanceof Error ? err.message : "Something went wrong.",
      variant: "destructive",
    });

  // Merge a partial change with the row's current match so changing the donor
  // never clobbers the opportunity/gift link (the PATCH route writes ALL five
  // fields from the body), and vice-versa.
  const handleSetMatch = (next: {
    organizationId?: string | null;
    individualGiverPersonId?: string | null;
    householdId?: string | null;
    matchedOpportunityId?: string | null;
    matchedGiftId?: string | null;
  }) => {
    const data = {
      organizationId:
        next.organizationId !== undefined
          ? next.organizationId
          : row.organizationId ?? null,
      individualGiverPersonId:
        next.individualGiverPersonId !== undefined
          ? next.individualGiverPersonId
          : row.individualGiverPersonId ?? null,
      householdId:
        next.householdId !== undefined
          ? next.householdId
          : row.householdId ?? null,
      matchedOpportunityId:
        next.matchedOpportunityId !== undefined
          ? next.matchedOpportunityId
          : row.matchedOpportunityId ?? null,
      matchedGiftId:
        next.matchedGiftId !== undefined
          ? next.matchedGiftId
          : row.matchedGiftId ?? null,
    };
    setMatch.mutate(
      { id: row.id, data },
      {
        onSuccess: () => {
          void invalidate();
          toast({ title: "Match updated" });
        },
        onError: onError("update match"),
      },
    );
  };

  // Applyable attrs: applicable, not blocked, and a difference exists (new/conflict).
  // timeRestriction is override-driven: server-side it only becomes applicable
  // once an override exists, so a locally typed (not yet saved) override must
  // also make it applyable — the override is sent in the same apply request.
  const applyable = useMemo(
    () => row.crossChecks.filter((c) => isCrossCheckApplyable(c, overrides)),
    [row.crossChecks, overrides],
  );

  const handleApply = () => {
    const decisions: ApplyCodingFormRowBodyDecisions = {};
    for (const c of applyable) {
      decisions[c.attribute] = selected[c.attribute] ? "apply" : "skip";
    }
    // Send only non-empty override values; omit the address attribute (no override).
    const activeOverrides: Record<string, string> = {};
    for (const [k, v] of Object.entries(overrides)) {
      if (v && v.trim().length > 0) activeOverrides[k] = v.trim();
    }
    applyMut.mutate(
      { id: row.id, data: { decisions, overrides: activeOverrides } },
      {
        onSuccess: (res) => {
          void invalidate();
          toast({
            title: "Applied",
            description:
              res.applied.length > 0
                ? `Wrote: ${res.applied.join(", ")}`
                : "Nothing to write (all skipped or unchanged).",
          });
        },
        onError: onError("apply"),
      },
    );
  };

  const handleSkip = () => {
    skipMut.mutate(
      { id: row.id },
      {
        onSuccess: () => {
          void invalidate();
          toast({ title: "Row skipped" });
        },
        onError: onError("skip"),
      },
    );
  };

  const handleRematch = () => {
    rematchMut.mutate(
      { id: row.id },
      {
        onSuccess: () => {
          void invalidate();
          toast({ title: "Re-matched" });
        },
        onError: onError("re-match"),
      },
    );
  };

  // Always re-runs the model, even when a payload exists (per-row = explicit
  // reviewer intent); a failure is recorded on the row, prior payload kept.
  const handleReinterpret = () => {
    reinterpretMut.mutate(
      { id: row.id },
      {
        onSuccess: (res) => {
          void invalidate();
          if (res.ok) {
            toast({ title: "AI reinterpretation updated" });
          } else {
            toast({
              title: "AI reinterpretation failed",
              description: res.error ?? "The model call failed.",
              variant: "destructive",
            });
          }
        },
        onError: onError("reinterpret"),
      },
    );
  };

  // Approve the current proposed link as-is (stamps the confirmation without
  // rewriting the proposal — unlike editing a picker, which re-stamps it as a
  // manual match).
  const handleConfirm = () => {
    confirmMut.mutate(
      { id: row.id },
      {
        onSuccess: () => {
          void invalidate();
          toast({ title: "Link confirmed" });
        },
        onError: onError("confirm link"),
      },
    );
  };

  const hasDonor = Boolean(
    row.organizationId || row.individualGiverPersonId || row.householdId,
  );
  const anySelected = applyable.some((c) => selected[c.attribute]);

  return (
    <div
      className="rounded-lg border p-4 space-y-3"
      data-testid={`coding-row-${row.id}`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{SOURCE_LABEL[row.source] ?? row.source}</Badge>
        <Badge variant="outline">row {row.sourceRowIndex}</Badge>
        <Badge
          variant={
            row.status === "applied"
              ? "secondary"
              : row.status === "skipped"
                ? "outline"
                : "default"
          }
        >
          {ROW_STATUS_LABEL[row.status]}
        </Badge>
        {row.matchTier ? (
          <Badge variant="outline">match: {row.matchTier}</Badge>
        ) : null}
        {row.matchConfirmedAt ? (
          <Badge
            className="border-transparent bg-emerald-100 text-emerald-900 hover:bg-emerald-100"
            data-testid={`badge-link-confirmed-${row.id}`}
          >
            Link confirmed
          </Badge>
        ) : null}
        <span className="ml-auto text-sm text-muted-foreground">
          {row.amount ? `$${row.amount}` : "—"}
          {row.donationDate ? ` · ${formatDateShort(row.donationDate)}` : ""}
        </span>
      </div>

      {/* Raw donor + memo */}
      <div className="text-sm">
        <span className="font-medium">{row.donorNameRaw ?? "(no name)"}</span>
        {row.internalMemo ? (
          <span className="text-muted-foreground"> — {row.internalMemo}</span>
        ) : null}
      </div>

      {/* AI provenance */}
      <AiInterpretationBlock row={row} />

      {/* Donor match */}
      <div className="space-y-1.5">
        <div className="text-xs font-medium uppercase text-muted-foreground">
          Donor match
        </div>
        <DonorMatchEditor row={row} onSet={handleSetMatch} disabled={pending} />
      </div>

      {/* Opportunity & gift match */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Opportunity / pledge
          </div>
          <EntityCombobox
            useSearch={useOpportunitySearch}
            useResolve={useOpportunityName}
            value={row.matchedOpportunityId ?? null}
            onChange={(next) =>
              handleSetMatch({ matchedOpportunityId: next })
            }
            allowNull
            disabled={pending}
            placeholder="Search opportunities…"
            testId={`opp-match-${row.id}`}
          />
          {row.matchedOpportunityId ? (
            <Link
              href={`/opportunities/${row.matchedOpportunityId}`}
              className="text-xs text-primary underline-offset-2 hover:underline"
              data-testid={`link-opp-${row.id}`}
            >
              Open opportunity ↗
            </Link>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Gift / payment
          </div>
          <EntityCombobox
            useSearch={useGiftSearch}
            useResolve={useGiftName}
            value={row.matchedGiftId ?? null}
            onChange={(next) => handleSetMatch({ matchedGiftId: next })}
            allowNull
            disabled={pending}
            placeholder="Search gifts…"
            testId={`gift-match-${row.id}`}
          />
          {row.matchedGiftId ? (
            <Link
              href={`/gifts/${row.matchedGiftId}`}
              className="text-xs text-primary underline-offset-2 hover:underline"
              data-testid={`link-gift-${row.id}`}
            >
              Open gift ↗
            </Link>
          ) : null}
          {!row.matchedGiftId && (row.giftCandidates?.length ?? 0) > 0 ? (
            <div className="space-y-1 rounded-md border border-dashed p-2">
              <div className="text-[11px] font-medium uppercase text-muted-foreground">
                Gifts at this amount (±90 days)
              </div>
              {!hasDonor ? (
                <p className="text-[11px] text-muted-foreground">
                  Picking one fills in the donor from the gift.
                </p>
              ) : null}
              {(row.giftCandidates ?? []).map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="min-w-0 truncate">
                    {c.name ?? `Gift ${c.id}`}
                    {c.dateReceived
                      ? ` · ${formatDateShort(c.dateReceived)}`
                      : ""}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-xs"
                    disabled={pending}
                    onClick={() => handleSetMatch({ matchedGiftId: c.id })}
                    data-testid={`button-pick-gift-${row.id}-${c.id}`}
                  >
                    Use
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {row.driveLink ? (
        <a
          href={row.driveLink}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary underline-offset-2 hover:underline"
        >
          Coding form (Drive) ↗
        </a>
      ) : null}

      {/* Cross-checks */}
      <div className="space-y-1.5">
        <div className="text-xs font-medium uppercase text-muted-foreground">
          Cross-check (spreadsheet vs CRM)
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Attribute</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 pr-3 font-medium">Spreadsheet</th>
                <th className="py-1 pr-3 font-medium">CRM</th>
                <th className="py-1 pr-3 font-medium">Override</th>
                <th className="py-1 pr-3 font-medium">Apply will write…</th>
                <th className="py-1 pr-3 font-medium">Apply</th>
              </tr>
            </thead>
            <tbody>
              {row.crossChecks.map((c) => {
                // Mirrors the `applyable` memo: timeRestriction with a locally
                // typed override is applyable even while the server-computed
                // check reads not-applicable ("na").
                const canApply =
                  isCrossCheckApplyable(c, overrides) &&
                  row.status !== "applied";
                // timeRestriction is override-driven: it only becomes
                // applicable once an override is set, so its picker must be
                // offered even while the check reads not-applicable.
                const canOverride = canOverrideCrossCheck(c, row.status);
                const overrideInput = (() => {
                  if (!canOverride) return null;
                  if (c.attribute === "allocationEntity") {
                    return (
                      <Select
                        value={overrides[c.attribute] ?? ""}
                        onValueChange={(v) =>
                          setOverrides((o) => ({
                            ...o,
                            [c.attribute]: v === "__clear__" ? "" : v,
                          }))
                        }
                        disabled={pending}
                      >
                        <SelectTrigger className="h-7 text-xs w-[14rem]">
                          <SelectValue placeholder="Pick entity…" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__clear__">
                            <span className="text-muted-foreground">
                              — use sheet default —
                            </span>
                          </SelectItem>
                          {(entities ?? []).map((e) => (
                            <SelectItem key={e.id} value={e.id}>
                              {e.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    );
                  }
                  if (
                    c.attribute === "otherRestriction" ||
                    c.attribute === "timeRestriction"
                  ) {
                    return (
                      <Select
                        value={overrides[c.attribute] ?? ""}
                        onValueChange={(v) =>
                          setOverrides((o) => ({
                            ...o,
                            [c.attribute]: v === "__clear__" ? "" : v,
                          }))
                        }
                        disabled={pending}
                      >
                        <SelectTrigger className="h-7 text-xs w-[12rem]">
                          <SelectValue placeholder="Pick axis…" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__clear__">
                            <span className="text-muted-foreground">
                              — use sheet default —
                            </span>
                          </SelectItem>
                          <SelectItem value="donor_restricted">
                            Donor restricted
                          </SelectItem>
                          <SelectItem value="unrestricted">
                            Unrestricted
                          </SelectItem>
                          <SelectItem value="wf_restricted">
                            WF restricted
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    );
                  }
                  if (c.attribute === "reportDeadline") {
                    return (
                      <Input
                        type="date"
                        className="h-7 text-xs w-[10rem]"
                        value={overrides[c.attribute] ?? ""}
                        onChange={(e) =>
                          setOverrides((o) => ({
                            ...o,
                            [c.attribute]: e.target.value,
                          }))
                        }
                        disabled={pending}
                      />
                    );
                  }
                  // Default: plain text input for restrictionDescription,
                  // purposeVerbatim, circle, seriesType, additionalNotes,
                  // internalMemo, regionalRestriction.
                  return (
                    <Input
                      className="h-7 text-xs w-[14rem]"
                      placeholder="Override…"
                      value={overrides[c.attribute] ?? ""}
                      onChange={(e) =>
                        setOverrides((o) => ({
                          ...o,
                          [c.attribute]: e.target.value,
                        }))
                      }
                      disabled={pending}
                    />
                  );
                })();
                return (
                  <tr
                    key={c.attribute}
                    className="border-t align-top"
                    data-testid={`crosscheck-${row.id}-${c.attribute}`}
                  >
                    <td className="py-1.5 pr-3">{c.label}</td>
                    <td className="py-1.5 pr-3">
                      <Badge variant={CROSS_STATUS_VARIANT[c.status]}>
                        {CROSS_STATUS_LABEL[c.status]}
                      </Badge>
                    </td>
                    <td className="py-1.5 pr-3 break-words max-w-[18rem]">
                      {c.sheetValue || "—"}
                    </td>
                    <td className="py-1.5 pr-3 break-words max-w-[18rem]">
                      {c.crmValue || "—"}
                    </td>
                    <td className="py-1.5 pr-3">
                      {overrideInput ?? (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td
                      className="py-1.5 pr-3 break-words max-w-[24rem]"
                      data-testid={`willwrite-${row.id}-${c.attribute}`}
                    >
                      {c.willWrite && row.status !== "applied" ? (
                        <div className="space-y-0.5">
                          <div className="text-xs text-muted-foreground">
                            {c.willWriteTo}:
                          </div>
                          <div className="font-medium">{c.willWrite}</div>
                        </div>
                      ) : c.applicable && c.status === "same" ? (
                        <span className="text-xs text-muted-foreground">
                          nothing — CRM already matches
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      {canApply ? (
                        <Checkbox
                          checked={!!selected[c.attribute]}
                          onCheckedChange={(v) =>
                            setSelected((s) => ({
                              ...s,
                              [c.attribute]: v === true,
                            }))
                          }
                          disabled={pending}
                          data-testid={`apply-${row.id}-${c.attribute}`}
                        />
                      ) : c.blockedReason ? (
                        <span className="text-xs text-muted-foreground">
                          {c.blockedReason}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Needs-decision (no schema home) */}
      {row.needsDecision.length > 0 ? (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-2 text-xs text-amber-900">
          <span className="font-medium">Needs a decision (no schema home): </span>
          {row.needsDecision
            .map((n) => `${n.label}${n.value ? `: ${n.value}` : ""}`)
            .join(" · ")}
        </div>
      ) : null}

      {/* Actions */}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={handleReinterpret}
          data-testid={`button-reinterpret-${row.id}`}
        >
          {reinterpretMut.isPending ? "Reinterpreting…" : "AI reinterpret"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={handleRematch}
          data-testid={`button-rematch-${row.id}`}
        >
          Re-match
        </Button>
        {!row.matchConfirmedAt && hasDonor ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={handleConfirm}
            data-testid={`button-confirm-link-${row.id}`}
          >
            Confirm link
          </Button>
        ) : null}
        {row.status === "pending" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={handleSkip}
            data-testid={`button-skip-${row.id}`}
          >
            Skip row
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={pending || !hasDonor || !anySelected}
          onClick={handleApply}
          data-testid={`button-apply-${row.id}`}
        >
          Apply selected
        </Button>
      </div>
    </div>
  );
}

/** One grant-agreement backfill row: status, links, before/after, Pull/Replace. */
function GrantAgreementRow({
  row,
  busy,
  onPull,
}: {
  row: CodingFormRow;
  busy: boolean;
  onPull: (row: CodingFormRow, replace: boolean) => void;
}) {
  const ga = row.grantAgreement;
  const status: GrantAgreementStatus = ga?.status ?? "na";
  // opportunity-else-gift: the server says where the letter goes.
  const targetType = ga?.targetType ?? null;
  const targetNoun = targetType === "gift" ? "gift" : "opportunity";
  const oppName = useOpportunityName(
    targetType === "opportunity" ? row.matchedOpportunityId ?? null : null,
  );
  const giftName = useGiftName(
    targetType === "gift" ? row.matchedGiftId ?? null : null,
  );

  return (
    <div
      className="rounded-lg border p-4 space-y-2"
      data-testid={`ga-row-${row.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">
          {SOURCE_LABEL[row.source] ?? row.source}
        </Badge>
        <Badge variant="outline">row {row.sourceRowIndex}</Badge>
        <Badge
          variant={GA_STATUS_VARIANT[status]}
          data-testid={`ga-status-${row.id}`}
        >
          {GA_STATUS_LABEL[status]}
        </Badge>
        <span className="ml-auto text-sm text-muted-foreground">
          {row.amount ? `$${row.amount}` : "—"}
          {row.donationDate ? ` · ${formatDateShort(row.donationDate)}` : ""}
        </span>
      </div>

      <div className="text-sm">
        <span className="font-medium">{row.donorNameRaw ?? "(no name)"}</span>
      </div>

      {/* Target link (opportunity-else-gift) / no-match notice */}
      {targetType === "opportunity" && row.matchedOpportunityId ? (
        <Link
          href={`/opportunities/${row.matchedOpportunityId}`}
          className="text-xs text-primary underline-offset-2 hover:underline"
          data-testid={`ga-link-opp-${row.id}`}
        >
          {oppName ?? "Open opportunity"} ↗
        </Link>
      ) : targetType === "gift" && row.matchedGiftId ? (
        <Link
          href={`/gifts/${row.matchedGiftId}`}
          className="text-xs text-primary underline-offset-2 hover:underline"
          data-testid={`ga-link-gift-${row.id}`}
        >
          {giftName ?? "Open gift"} ↗ <span className="text-muted-foreground">(gift — no opportunity matched)</span>
        </Link>
      ) : (
        <p className="text-xs text-muted-foreground">
          No matched opportunity or gift — match one in the coding-form view
          first.
        </p>
      )}

      {/* Drive link */}
      {row.driveLink ? (
        <div>
          <a
            href={row.driveLink}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary underline-offset-2 hover:underline"
            data-testid={`ga-drive-${row.id}`}
          >
            Grant agreement (Drive) ↗
          </a>
        </div>
      ) : null}

      {/* Before / after */}
      {ga?.oppExistingUrl ? (
        <p className="text-xs text-muted-foreground">
          Existing letter on {targetNoun}:{" "}
          <a
            href={ga.oppExistingUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-2 hover:underline"
          >
            {ga.oppExistingFilename ?? "view"} ↗
          </a>
        </p>
      ) : null}
      {ga?.importedUrl ? (
        <p className="text-xs text-muted-foreground">
          Imported:{" "}
          <a
            href={ga.importedUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-2 hover:underline"
          >
            {ga.importedFilename ?? "view"} ↗
          </a>
          {ga.importedAt ? ` · ${formatDateShort(ga.importedAt)}` : ""}
        </p>
      ) : null}
      {status === "failed" && ga?.error ? (
        <p className="text-xs text-destructive" data-testid={`ga-error-${row.id}`}>
          {ga.error}
        </p>
      ) : null}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {status === "ready" ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onPull(row, false)}
            data-testid={`button-pull-${row.id}`}
          >
            Pull onto {targetNoun}
          </Button>
        ) : null}
        {status === "failed" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onPull(row, false)}
            data-testid={`button-retry-${row.id}`}
          >
            Retry
          </Button>
        ) : null}
        {status === "conflict" ? (
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => onPull(row, true)}
            data-testid={`button-replace-${row.id}`}
          >
            Replace existing letter
          </Button>
        ) : null}
        {status === "imported" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onPull(row, true)}
            data-testid={`button-repull-${row.id}`}
          >
            Re-pull
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Grant-agreement backfill view: pull ~270 Drive documents onto matched opps. */
function GrantAgreementsView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);

  const params: ListCodingFormRowsParams = { hasDriveLink: true, limit: 500 };
  const { data, isLoading, isError } = useListCodingFormRows(params, {
    query: { queryKey: getListCodingFormRowsQueryKey(params) },
  });
  const { data: summary } = useGetCodingFormGrantAgreementsSummary({
    query: { queryKey: getGetCodingFormGrantAgreementsSummaryQueryKey() },
  });

  const pullMut = usePullGrantAgreement();
  const bulkPullMut = usePullGrantAgreementsBulk();
  const rows = data?.data ?? [];

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: [CODING_KEY_PREFIX] }),
      queryClient.invalidateQueries({
        queryKey: getGetCodingFormGrantAgreementsSummaryQueryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: ["/api/opportunities-and-pledges"],
      }),
      // Letters can also land on gifts (opportunity-else-gift).
      queryClient.invalidateQueries({
        queryKey: ["/api/gifts-and-payments"],
      }),
    ]);

  const pullOne = (id: string, replace: boolean) =>
    pullMut.mutateAsync({ id, data: { replace } });

  const handlePull = async (row: CodingFormRow, replace: boolean) => {
    setBusyId(row.id);
    try {
      const res = await pullOne(row.id, replace);
      await invalidate();
      if (res.outcome === "failed") {
        toast({
          title: "Pull failed",
          description: res.error ?? "Could not fetch the Drive file.",
          variant: "destructive",
        });
      } else if (res.outcome === "already_imported") {
        toast({ title: "Already imported" });
      } else {
        toast({
          title: res.replaced ? "Replaced grant letter" : "Grant letter attached",
        });
      }
    } catch (e) {
      toast({
        title: "Pull failed",
        description: e instanceof Error ? e.message : "Request failed.",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  // ONE server-side pass over every actionable row (ready + recorded
  // failures); skips na/no_match/imported and never replaces an existing
  // letter — conflicts stay for per-row review.
  const handleImportAllReady = () => {
    setBulkRunning(true);
    bulkPullMut.mutate(undefined, {
      onSuccess: async (res) => {
        await invalidate();
        setBulkRunning(false);
        const parts = [
          `${res.imported} attached`,
          res.alreadyImported ? `${res.alreadyImported} already imported` : null,
          res.conflict ? `${res.conflict} conflict (existing letter kept)` : null,
          res.noMatch ? `${res.noMatch} without a matched record` : null,
          res.failed ? `${res.failed} failed` : null,
        ].filter(Boolean);
        toast({
          title: `Bulk pull — ${res.attempted} attempted`,
          description: `${parts.join(" · ")}.`,
          variant: res.failed ? "destructive" : undefined,
        });
      },
      onError: (err) => {
        setBulkRunning(false);
        toast({
          title: "Bulk pull failed",
          description:
            err instanceof Error ? err.message : "Something went wrong.",
          variant: "destructive",
        });
      },
    });
  };

  const readyCount =
    summary?.byStatus.find((s) => s.key === "ready")?.count ?? 0;
  const failedCount =
    summary?.byStatus.find((s) => s.key === "failed")?.count ?? 0;
  const actionableCount = readyCount + failedCount;

  return (
    <div className="space-y-6">
      {summary ? (
        <div className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-xs uppercase text-muted-foreground">
              Grant agreements ({summary.totalWithLink} with a Drive link)
            </div>
            <Button
              size="sm"
              className="ml-auto"
              disabled={bulkRunning || actionableCount === 0}
              onClick={handleImportAllReady}
              data-testid="button-import-all-ready"
            >
              {bulkRunning
                ? "Importing…"
                : failedCount
                  ? `Import ready (${readyCount}) + retry failed (${failedCount})`
                  : `Import all ready (${readyCount})`}
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {summary.byStatus.map((s) => (
              <Badge
                key={s.key}
                variant={
                  GA_STATUS_VARIANT[s.key as GrantAgreementStatus] ?? "outline"
                }
              >
                {GA_STATUS_LABEL[s.key as GrantAgreementStatus] ?? s.key}:{" "}
                {s.count}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Loading grant-agreement rows…
        </p>
      ) : isError ? (
        <p className="text-sm text-destructive py-8 text-center">
          Failed to load grant-agreement rows.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No rows carry a grant-agreement Drive link.
        </p>
      ) : (
        <div className="space-y-4">
          {rows.map((row) => (
            <GrantAgreementRow
              key={row.id}
              row={row}
              busy={busyId === row.id || bulkRunning}
              onPull={handlePull}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function CodingFormImportPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"coding" | "grants">("coding");
  const [status, setStatus] = useState<CodingFormRowStatus | "all">("pending");
  const [source, setSource] = useState<ListCodingFormRowsSource | "all">("all");
  const [matchTier, setMatchTier] = useState<
    ListCodingFormRowsMatchTier | "all"
  >("all");

  const params: ListCodingFormRowsParams = {
    ...(status !== "all" ? { status } : {}),
    ...(source !== "all" ? { source } : {}),
    ...(matchTier !== "all" ? { matchTier } : {}),
    limit: 500,
  };

  const { data, isLoading, isError } = useListCodingFormRows(params, {
    query: { queryKey: getListCodingFormRowsQueryKey(params) },
  });
  const { data: summary } = useGetCodingFormSummary();

  // Bulk matcher pass over every still-pending, never-confirmed row (the server
  // query excludes confirmed/applied/skipped rows, so no human decision can be
  // clobbered). Adds the exact-amount same-donor ±90-day gift proposals.
  const rematchPendingMut = useRematchPendingCodingFormRows();
  const handleRematchPending = () => {
    rematchPendingMut.mutate(undefined, {
      onSuccess: (res) => {
        void queryClient.invalidateQueries({
          queryKey: [CODING_KEY_PREFIX],
        });
        toast({
          title: "Re-matched pending rows",
          description: `${res.scanned} scanned · ${res.updated} updated · ${res.giftMatches} now carry a proposed gift.`,
        });
      },
      onError: (err) =>
        toast({
          title: "Couldn't re-match pending rows",
          description:
            err instanceof Error ? err.message : "Something went wrong.",
          variant: "destructive",
        }),
    });
  };

  // Bulk-approve every still-pending, never-confirmed row that has BOTH a
  // donor AND a matched gift — freezes the auto-matcher's proposals without
  // touching rows a human already confirmed / applied / skipped.
  const confirmMatchedMut = useConfirmMatchedCodingFormRows();
  const handleConfirmMatched = () => {
    confirmMatchedMut.mutate(undefined, {
      onSuccess: (res) => {
        void queryClient.invalidateQueries({
          queryKey: [CODING_KEY_PREFIX],
        });
        toast({
          title: "Confirmed matched rows",
          description:
            res.confirmed === 0
              ? "No unconfirmed rows with both a donor and a gift link were found."
              : `${res.confirmed} ${res.confirmed === 1 ? "link" : "links"} confirmed.`,
        });
      },
      onError: (err) =>
        toast({
          title: "Couldn't confirm matched rows",
          description:
            err instanceof Error ? err.message : "Something went wrong.",
          variant: "destructive",
        }),
    });
  };

  // Bulk apply: every pending + match-confirmed row with stored per-attribute
  // decisions runs through the SAME apply path as the per-row Apply button.
  // Rows whose approved attributes aren't actionable stay pending for per-row
  // review; per-row failures are summarized, never thrown.
  const applyDecidedMut = useApplyDecidedCodingFormRows();
  const handleApplyDecided = () => {
    applyDecidedMut.mutate(undefined, {
      onSuccess: (res) => {
        void queryClient.invalidateQueries({
          queryKey: [CODING_KEY_PREFIX],
        });
        const parts: string[] = [];
        if (res.applied) parts.push(`${res.applied} applied`);
        if (res.nothingToApply)
          parts.push(`${res.nothingToApply} left pending (nothing to apply)`);
        if (res.failed) parts.push(`${res.failed} failed`);
        toast({
          title: "Apply decided — done",
          description:
            res.scanned === 0
              ? "No pending rows with a confirmed match and stored decisions were found."
              : `${res.scanned} rows scanned · ${parts.join(" · ")}.`,
          variant: res.failed ? "destructive" : undefined,
        });
      },
      onError: (err) =>
        toast({
          title: "Couldn't apply decided rows",
          description:
            err instanceof Error ? err.message : "Something went wrong.",
          variant: "destructive",
        }),
    });
  };

  // Bulk AI pass over pending rows that have no stored payload yet (the
  // server default; per-row "AI reinterpret" is the explicit re-run path).
  // Chunked: one full pass would outlive the HTTP request, so we ask for a
  // small batch at a time and keep going while full chunks come back. The
  // server processes never-failed rows first, so a chunk with zero successes
  // means only persistently-failing rows remain — stop there.
  const [reinterpretRunning, setReinterpretRunning] = useState(false);
  const reinterpretAllMut = useReinterpretCodingFormRows();
  const handleReinterpretAll = async () => {
    const CHUNK = 10;
    setReinterpretRunning(true);
    let total = 0;
    let succeeded = 0;
    let failed = 0;
    try {
      // 40 chunks × 200-row max backlog is unreachable; the cap only guards
      // against a runaway loop.
      for (let i = 0; i < 40; i++) {
        const res = await reinterpretAllMut.mutateAsync({
          data: { limit: CHUNK },
        });
        total += res.total;
        succeeded += res.succeeded;
        failed += res.failed;
        if (res.total < CHUNK || res.succeeded === 0) break;
      }
      toast({
        title: "AI reinterpretation — done",
        description:
          total === 0
            ? "Every pending row already has an AI interpretation."
            : `${total} rows · ${succeeded} succeeded${failed ? ` · ${failed} failed` : ""}.`,
        variant: failed ? "destructive" : undefined,
      });
    } catch (err) {
      toast({
        title: "Couldn't run AI reinterpretation",
        description: `${err instanceof Error ? err.message : "Something went wrong."}${succeeded ? ` (${succeeded} rows were already updated.)` : ""}`,
        variant: "destructive",
      });
    } finally {
      setReinterpretRunning(false);
      void queryClient.invalidateQueries({ queryKey: [CODING_KEY_PREFIX] });
    }
  };

  const bulkBusy =
    rematchPendingMut.isPending ||
    confirmMatchedMut.isPending ||
    applyDecidedMut.isPending ||
    reinterpretRunning;

  const rows = data?.data ?? [];

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Donation Coding Form Import
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          One-time reconciliation of the FY24–FY26 and Girasol donation coding
          forms. Each row is matched to a CRM donor and opportunity/gift, then
          cross-checked against the CRM. Apply only fills missing values and
          surfaces conflicts — it never overwrites existing CRM data.
        </p>
      </div>

      {/* View toggle */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={view === "coding" ? "default" : "outline"}
          onClick={() => setView("coding")}
          data-testid="view-coding"
        >
          Coding form
        </Button>
        <Button
          size="sm"
          variant={view === "grants" ? "default" : "outline"}
          onClick={() => setView("grants")}
          data-testid="view-grants"
        >
          Grant agreements
        </Button>
        {view === "coding" ? (
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleReinterpretAll}
              disabled={bulkBusy}
              data-testid="button-reinterpret-pending"
            >
              {reinterpretRunning
                ? "Reinterpreting…"
                : "AI reinterpret pending"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRematchPending}
              disabled={bulkBusy}
              data-testid="button-rematch-pending"
            >
              {rematchPendingMut.isPending
                ? "Re-matching…"
                : "Re-match all pending"}
            </Button>
            <Button
              size="sm"
              onClick={handleConfirmMatched}
              disabled={bulkBusy}
              data-testid="button-confirm-matched"
            >
              {confirmMatchedMut.isPending
                ? "Confirming…"
                : "Confirm all matched"}
            </Button>
            <Button
              size="sm"
              onClick={handleApplyDecided}
              disabled={bulkBusy}
              data-testid="button-apply-decided"
            >
              {applyDecidedMut.isPending ? "Applying…" : "Apply decided"}
            </Button>
          </div>
        ) : null}
      </div>

      {view === "grants" ? <GrantAgreementsView /> : null}

      {view === "coding" ? (
        <>
      {/* Summary */}
      {summary ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border p-3">
            <div className="text-xs uppercase text-muted-foreground">Total</div>
            <div className="text-2xl font-semibold">{summary.total}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {summary.byStatus.map((s) => (
                <Badge key={s.key} variant="outline">
                  {ROW_STATUS_LABEL[s.key as CodingFormRowStatus] ?? s.key}:{" "}
                  {s.count}
                </Badge>
              ))}
            </div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs uppercase text-muted-foreground">
              By source
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {summary.bySource.map((s) => (
                <Badge key={s.key} variant="outline">
                  {SOURCE_LABEL[s.key] ?? s.key}: {s.count}
                </Badge>
              ))}
            </div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs uppercase text-muted-foreground">
              Needs a decision (no schema home)
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {summary.needsDecision.length === 0 ? (
                <span className="text-sm text-muted-foreground">None</span>
              ) : (
                summary.needsDecision.map((s) => (
                  <Badge key={s.key} variant="secondary">
                    {s.key}: {s.count}
                  </Badge>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger className="w-40" data-testid="filter-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="applied">Applied</SelectItem>
            <SelectItem value="skipped">Skipped</SelectItem>
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={(v) => setSource(v as typeof source)}>
          <SelectTrigger className="w-40" data-testid="filter-source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="fy24">FY24</SelectItem>
            <SelectItem value="fy25">FY25</SelectItem>
            <SelectItem value="fy26">FY26</SelectItem>
            <SelectItem value="fy27">FY27</SelectItem>
            <SelectItem value="girasol">Girasol</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={matchTier}
          onValueChange={(v) => setMatchTier(v as typeof matchTier)}
        >
          <SelectTrigger className="w-44" data-testid="filter-match-tier">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All match tiers</SelectItem>
            <SelectItem value="high">High confidence</SelectItem>
            <SelectItem value="suggested">Suggested</SelectItem>
            <SelectItem value="none">Unmatched</SelectItem>
          </SelectContent>
        </Select>
        {!isLoading && !isError ? (
          <span className="ml-auto text-sm text-muted-foreground">
            {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"}
          </span>
        ) : null}
      </div>

      {/* Rows */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Loading coding-form rows…
        </p>
      ) : isError ? (
        <p className="text-sm text-destructive py-8 text-center">
          Failed to load coding-form rows.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No rows match these filters.
        </p>
      ) : (
        <div className="space-y-4">
          {rows.map((row) => (
            <RowCard key={row.id} row={row} />
          ))}
        </div>
      )}
        </>
      ) : null}
    </div>
  );
}
