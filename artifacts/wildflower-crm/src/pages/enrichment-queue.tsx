import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListEnrichmentSuggestionsQueryKey,
  useBulkResolveEnrichmentSuggestions,
  useGenerateHomeRegionSuggestions,
  useGetCurrentUser,
  useImportEnrichmentSuggestionsCsv,
  useListEnrichmentSuggestions,
  useListUsers,
  useResolveEnrichmentSuggestion,
  type EnrichmentBulkResolveResult,
  type EnrichmentCsvImportResult,
  type ListEnrichmentSuggestionsEntityType,
  type ListEnrichmentSuggestionsConfidence,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateShort } from "@/lib/format";
import { userDisplayName } from "@/components/user-picker";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Upload, WandSparkles, X } from "lucide-react";

export const EMPLOYER_SOURCE = "Current employer office address";
const PAGE_SIZE = 50;

export type QueueRow = {
  id: string;
  entityType: "person" | "organization";
  entityId: string;
  recordName: string;
  fieldName: string;
  currentValue: string | null;
  suggestedValueDisplay: string;
  sourceLabel: string;
  sourceDetail: string | null;
  confidence: string | null;
  createdAt: string;
  viewerCanResolve: boolean;
  viewerCannotResolveReason: string | null;
};

export type EnrichmentQueueScope = {
  fieldName: string;
  sourceLabel: string;
  entityType: string;
  ownerUserId: string;
  confidence: string;
  page: number;
};

export function enrichmentScopeKey(scope: EnrichmentQueueScope) {
  return JSON.stringify(scope);
}

export function isDefaultEnrichmentSelection(row: Pick<QueueRow, "viewerCanResolve" | "sourceLabel">) {
  return row.viewerCanResolve && row.sourceLabel !== EMPLOYER_SOURCE;
}

export function bulkFailureMap(
  outcomes: Array<{ id: string; success: boolean; message?: string | null; error?: string | null }>,
) {
  return Object.fromEntries(
    outcomes
      .filter((outcome) => !outcome.success)
      .map((outcome) => [outcome.id, outcome.message ?? outcome.error ?? "Could not resolve"]),
  );
}

function recordHref(row: QueueRow) {
  return row.entityType === "person"
    ? `/individuals/${row.entityId}`
    : `/organizations/${row.entityId}`;
}

function fieldLabel(fieldName: string) {
  return fieldName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (value) => value.toUpperCase());
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The request failed.";
}

export default function EnrichmentQueuePage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const currentUser = useGetCurrentUser();
  const isAdmin = currentUser.data?.role === "admin";
  const { data: users } = useListUsers();
  const [fieldName, setFieldName] = useState("all");
  const [sourceLabel, setSourceLabel] = useState("");
  const [entityType, setEntityType] = useState("all");
  const [ownerUserId, setOwnerUserId] = useState("all");
  const [confidence, setConfidence] = useState("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rowFailures, setRowFailures] = useState<Record<string, string>>({});
  const [importSummary, setImportSummary] = useState<{
    created: number;
    skipped: number;
    invalid: number;
    reasons?: string[];
  } | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const scopeKey = enrichmentScopeKey({
    fieldName,
    sourceLabel,
    entityType,
    ownerUserId,
    confidence,
    page,
  });

  // Selection is intentionally scoped to the currently visible query. Do not
  // let IDs from a previous filter/page silently reappear in bulk actions.
  useEffect(() => {
    setSelected(new Set());
    setRowFailures({});
  }, [scopeKey]);

  const params = {
    fieldName: fieldName === "all" ? undefined : fieldName,
    sourceLabel: sourceLabel.trim() || undefined,
    entityType: entityType === "all" ? undefined : entityType as ListEnrichmentSuggestionsEntityType,
    ownerUserId: ownerUserId === "all" ? undefined : ownerUserId,
    confidence: confidence === "all" ? undefined : confidence as ListEnrichmentSuggestionsConfidence,
    page,
    limit: PAGE_SIZE,
  };
  const query = useListEnrichmentSuggestions(params, {
    query: { queryKey: getListEnrichmentSuggestionsQueryKey(params) },
  });
  const resolveMutation = useResolveEnrichmentSuggestion();
  const bulkMutation = useBulkResolveEnrichmentSuggestions();
  const generateMutation = useGenerateHomeRegionSuggestions();
  const importMutation = useImportEnrichmentSuggestionsCsv();
  const rows = (query.data?.data ?? []) as QueueRow[];
  const pagination = query.data?.pagination;
  const countsByField = query.data?.countsByField ?? {};
  const usersById = useMemo(
    () => new Map((users ?? []).map((user) => [user.id, userDisplayName(user)])),
    [users],
  );
  const resolvableRows = rows.filter((row) => row.viewerCanResolve);
  const defaultSelectableIds = useMemo(
    () =>
      new Set(
        resolvableRows
          .filter(isDefaultEnrichmentSelection)
          .map((row) => row.id),
      ),
    [resolvableRows],
  );
  const allDefaultSelected =
    defaultSelectableIds.size > 0 &&
    [...defaultSelectableIds].every((id) => selected.has(id));

  const invalidateEnrichment = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/enrichment-suggestions"] });
    void queryClient.invalidateQueries({ queryKey: ["/api"] });
  };

  const toggleSelected = (row: QueueRow) => {
    if (!row.viewerCanResolve) return;
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  };

  const selectDefaultRows = () => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (allDefaultSelected) {
        defaultSelectableIds.forEach((id) => next.delete(id));
      } else {
        defaultSelectableIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const resolveOne = (row: QueueRow, status: "accepted" | "dismissed") => {
    resolveMutation.mutate(
      { id: row.id, data: { status } },
      {
        onSuccess: () => {
          setSelected((previous) => {
            const next = new Set(previous);
            next.delete(row.id);
            return next;
          });
          invalidateEnrichment();
          toast({ title: status === "accepted" ? "Suggestion accepted" : "Suggestion dismissed" });
        },
        onError: (error) => {
          setRowFailures((previous) => ({ ...previous, [row.id]: errorMessage(error) }));
          toast({ title: "Suggestion could not be resolved", description: errorMessage(error), variant: "destructive" });
        },
      },
    );
  };

  const resolveBulk = (status: "accepted" | "dismissed") => {
    const ids = [...selected].filter((id) => rows.some((row) => row.id === id && row.viewerCanResolve));
    if (!ids.length) return;
    bulkMutation.mutate(
      // The generated client owns the exact request type; this shape is the
      // contract shared with the bulk row-by-row resolver.
      { data: { ids, status } },
      {
        onSuccess: (result: EnrichmentBulkResolveResult) => {
          const outcomes = result.outcomes;
          const failures = bulkFailureMap(outcomes);
          setRowFailures(failures);
          setSelected(new Set());
          invalidateEnrichment();
          const failureCount = result.failed;
          toast({
            title: `${result.succeeded} suggestion${result.succeeded === 1 ? "" : "s"} processed`,
            description: failureCount ? `${failureCount} row${failureCount === 1 ? "" : "s"} failed and remain visible below.` : undefined,
            variant: failureCount ? "destructive" : "default",
          });
        },
        onError: (error: unknown) => toast({ title: "Bulk resolve failed", description: errorMessage(error), variant: "destructive" }),
      },
    );
  };

  const handleCsvImport = async (file: File) => {
    try {
      const csvText = await file.text();
      importMutation.mutate(
        { data: { csvText } },
        {
          onSuccess: (result: unknown) => {
          const importResult = result as EnrichmentCsvImportResult;
          setImportSummary({
              created: importResult.created,
              skipped: importResult.skipped,
              invalid: importResult.invalid,
              reasons: importResult.rows.map((row) => `Row ${row.row}: ${row.reason}`),
            });
            invalidateEnrichment();
            toast({ title: "Reviewed suggestions imported" });
          },
          onError: (error: unknown) => toast({ title: "CSV import failed", description: errorMessage(error), variant: "destructive" }),
        },
      );
    } catch (error) {
      toast({ title: "Could not read CSV", description: errorMessage(error), variant: "destructive" });
    } finally {
      if (importInput.current) importInput.current.value = "";
    }
  };

  const resetFilters = () => {
    setFieldName("all");
    setSourceLabel("");
    setEntityType("all");
    setOwnerUserId("all");
    setConfidence("all");
    setPage(1);
    setSelected(new Set());
  };

  return (
    <div className="max-w-[1500px] space-y-6" data-testid="page-enrichment-queue">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-bold text-foreground">Enrichment Queue</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Review proposed improvements across people and organizations. Accept only evidence you trust; every decision is audited.
          </p>
        </div>
        {isAdmin ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={generateMutation.isPending}
              onClick={() =>
                generateMutation.mutate(undefined, {
                  onSuccess: () => {
                    invalidateEnrichment();
                    toast({ title: "Home-region suggestions generated" });
                  },
                  onError: (error: unknown) => toast({ title: "Could not generate suggestions", description: errorMessage(error), variant: "destructive" }),
                })
              }
              data-testid="button-generate-home-region-suggestions"
            >
              <WandSparkles className="mr-2 h-4 w-4" />
              Generate home-region suggestions
            </Button>
            <input
              ref={importInput}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleCsvImport(file);
              }}
              data-testid="input-enrichment-csv"
            />
            <Button variant="outline" disabled={importMutation.isPending} onClick={() => importInput.current?.click()} data-testid="button-import-enrichment-csv">
              <Upload className="mr-2 h-4 w-4" />
              Import reviewed CSV
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2" data-testid="enrichment-field-counts">
        {Object.entries(countsByField).map(([field, count]) => (
          <button
            type="button"
            key={field}
            onClick={() => { setFieldName(field); setPage(1); }}
            className={`rounded-full border px-3 py-1.5 text-sm transition ${fieldName === field ? "border-primary bg-primary/10 text-primary" : "bg-card hover:bg-muted"}`}
            data-testid={`count-field-${field}`}
          >
            {fieldLabel(field)} <span className="ml-1 font-semibold">{String(count)}</span>
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-52 flex-1">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Source label (exact match)</label>
            <Input value={sourceLabel} onChange={(event) => { setSourceLabel(event.target.value); setPage(1); }} placeholder="Exact source label" data-testid="input-filter-source" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Field</label>
            <Select value={fieldName} onValueChange={(value) => { setFieldName(value); setPage(1); }}>
              <SelectTrigger className="w-48" data-testid="select-filter-field"><SelectValue placeholder="All fields" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All fields</SelectItem>{Object.keys(countsByField).map((field) => <SelectItem key={field} value={field}>{fieldLabel(field)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Record type</label>
            <Select value={entityType} onValueChange={(value) => { setEntityType(value); setPage(1); }}>
              <SelectTrigger className="w-40" data-testid="select-filter-entity-type"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">People & organizations</SelectItem><SelectItem value="person">People</SelectItem><SelectItem value="organization">Organizations</SelectItem></SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Owner</label>
            <Select value={ownerUserId} onValueChange={(value) => { setOwnerUserId(value); setPage(1); }}>
              <SelectTrigger className="w-48" data-testid="select-filter-owner"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All owners</SelectItem>{(users ?? []).map((user) => <SelectItem key={user.id} value={user.id}>{userDisplayName(user)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Confidence</label>
            <Select value={confidence} onValueChange={(value) => { setConfidence(value); setPage(1); }}>
              <SelectTrigger className="w-36" data-testid="select-filter-confidence"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All confidence</SelectItem><SelectItem value="high">High</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="low">Low</SelectItem></SelectContent>
            </Select>
          </div>
          <Button variant="ghost" onClick={resetFilters} data-testid="button-reset-enrichment-filters">Reset</Button>
        </CardContent>
      </Card>

      {importSummary ? (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="space-y-2 p-4 text-sm" data-testid="enrichment-import-summary">
            <div className="font-semibold">Import summary</div>
            <div className="flex flex-wrap gap-4"><span>Created: <strong>{importSummary.created}</strong></span><span>Skipped: <strong>{importSummary.skipped}</strong></span><span>Invalid: <strong>{importSummary.invalid}</strong></span></div>
            {importSummary.reasons?.length ? <ul className="list-disc pl-5 text-muted-foreground">{importSummary.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
          </CardContent>
        </Card>
      ) : null}

      {selected.size ? (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-background/95 p-3 shadow-sm backdrop-blur" data-testid="enrichment-bulk-toolbar">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Button size="sm" disabled={bulkMutation.isPending} onClick={() => resolveBulk("accepted")} data-testid="button-bulk-accept"><Check className="mr-1 h-4 w-4" />Accept</Button>
          <Button size="sm" variant="outline" disabled={bulkMutation.isPending} onClick={() => resolveBulk("dismissed")} data-testid="button-bulk-dismiss"><X className="mr-1 h-4 w-4" />Dismiss</Button>
        </div>
      ) : null}

      {query.isLoading ? <p className="py-12 text-center text-sm text-muted-foreground">Loading enrichment suggestions…</p> : query.isError ? <p className="py-12 text-center text-sm text-destructive">Could not load the enrichment queue.</p> : rows.length === 0 ? <p className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">No pending enrichment suggestions match these filters.</p> : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-3"><input type="checkbox" checked={allDefaultSelected} onChange={selectDefaultRows} aria-label="Select default resolvable suggestions" data-testid="checkbox-select-all-enrichment" /></th>
                <th className="px-3 py-3">Record</th><th className="px-3 py-3">Field</th><th className="px-3 py-3">Current</th><th className="px-3 py-3">Suggested</th><th className="px-3 py-3">Evidence</th><th className="px-3 py-3">Confidence</th><th className="px-3 py-3">Created</th><th className="px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => {
                const failure = rowFailures[row.id];
                return (
                  <tr key={row.id} className="align-top" data-testid={`enrichment-row-${row.id}`}>
                    <td className="px-3 py-4"><input type="checkbox" checked={selected.has(row.id)} disabled={!row.viewerCanResolve} onChange={() => toggleSelected(row)} aria-label={`Select ${row.recordName}`} data-testid={`checkbox-enrichment-${row.id}`} /></td>
                    <td className="px-3 py-4"><Link className="font-medium text-primary hover:underline" href={recordHref(row)} data-testid={`link-enrichment-record-${row.id}`}>{row.recordName}</Link><div className="mt-1 text-xs text-muted-foreground">{row.entityType}</div></td>
                    <td className="px-3 py-4"><Badge variant="secondary">{fieldLabel(row.fieldName)}</Badge></td>
                    <td className="max-w-40 break-words px-3 py-4 text-muted-foreground">{row.currentValue || "—"}</td>
                    <td className="max-w-48 break-words px-3 py-4 font-medium">{row.suggestedValueDisplay || "—"}</td>
                    <td className="max-w-72 px-3 py-4"><div className="font-semibold text-foreground">{row.sourceLabel}</div>{row.sourceDetail ? <div className="mt-1 text-xs text-muted-foreground">{row.sourceDetail}</div> : null}</td>
                    <td className="px-3 py-4">{row.confidence ? <Badge variant={row.confidence === "high" ? "default" : "outline"}>{row.confidence}</Badge> : <span className="text-muted-foreground">—</span>}</td>
                    <td className="whitespace-nowrap px-3 py-4 text-xs text-muted-foreground">{formatDateShort(row.createdAt)}</td>
                    <td className="px-3 py-4 text-right"><div className="flex justify-end gap-2"><Button size="sm" disabled={!row.viewerCanResolve || resolveMutation.isPending} onClick={() => resolveOne(row, "accepted")} data-testid={`button-accept-enrichment-${row.id}`}>Accept</Button><Button size="sm" variant="outline" disabled={!row.viewerCanResolve || resolveMutation.isPending} onClick={() => resolveOne(row, "dismissed")} data-testid={`button-dismiss-enrichment-${row.id}`}>Dismiss</Button></div>{!row.viewerCanResolve ? <div className="mt-2 max-w-48 text-xs text-muted-foreground">{row.viewerCannotResolveReason ?? "Only the record owner or an admin can resolve this."}</div> : null}{failure ? <div className="mt-2 flex max-w-56 items-start gap-1 text-left text-xs text-destructive"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{failure}</div> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.total > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, pagination.total)} of {pagination.total}</span>
          <div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} data-testid="button-enrichment-previous"><ChevronLeft className="mr-1 h-4 w-4" />Previous</Button><Button variant="outline" size="sm" disabled={page * PAGE_SIZE >= pagination.total} onClick={() => setPage((value) => value + 1)} data-testid="button-enrichment-next">Next<ChevronRight className="ml-1 h-4 w-4" /></Button></div>
        </div>
      ) : null}
    </div>
  );
}
