import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCodingFormRows,
  getListCodingFormRowsQueryKey,
  useGetCodingFormSummary,
  useSetCodingFormMatch,
  useApplyCodingFormRow,
  useSkipCodingFormRow,
  useRematchCodingFormRow,
  CodingFormRowStatus,
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
  type ListCodingFormRowsParams,
  type ApplyCodingFormRowBodyDecisions,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { formatDateShort } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  girasol: "Girasol",
};

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

  // Which applicable cross-checks the reviewer has toggled ON to apply.
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: [CODING_KEY_PREFIX] });

  const pending =
    setMatch.isPending ||
    applyMut.isPending ||
    skipMut.isPending ||
    rematchMut.isPending;

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
  const applyable = useMemo(
    () =>
      row.crossChecks.filter(
        (c) =>
          c.applicable &&
          !c.blockedReason &&
          (c.status === "new" || c.status === "conflict"),
      ),
    [row.crossChecks],
  );

  const handleApply = () => {
    const decisions: ApplyCodingFormRowBodyDecisions = {};
    for (const c of applyable) {
      decisions[c.attribute] = selected[c.attribute] ? "apply" : "skip";
    }
    applyMut.mutate(
      { id: row.id, data: { decisions } },
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
                <th className="py-1 pr-3 font-medium">Apply</th>
              </tr>
            </thead>
            <tbody>
              {row.crossChecks.map((c) => {
                const canApply =
                  c.applicable &&
                  !c.blockedReason &&
                  (c.status === "new" || c.status === "conflict") &&
                  row.status !== "applied";
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
          onClick={handleRematch}
          data-testid={`button-rematch-${row.id}`}
        >
          Re-match
        </Button>
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

export default function CodingFormImportPage() {
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
    </div>
  );
}
