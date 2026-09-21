import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetProjectionsByFyEntity,
  useGetFundingArrivalsByMonth,
  useListEntities,
  useListFiscalYears,
  useUpdateOpportunityOrPledge,
  getGetProjectionsByFyEntityQueryKey,
  getGetFundingArrivalsByMonthQueryKey,
  getGetOpportunityOrPledgeQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  getListEntitiesQueryKey,
  getListFiscalYearsQueryKey,
  type CashFlowForecastRow,
  type FundraisingCategory,
  type ProjectionByFyEntityRow,
  type ProjectionCombinedFyRow,
  type ProjectionForecastDiagnostic,
  type GetFundingArrivalsByMonthParams,
  type UpdateOpportunityOrPledgeBody,
} from "@workspace/api-client-react";
import {
  currentFiscalYearEndYear,
  currentFiscalYearSlug,
  formatCurrency,
} from "@/lib/format";
import { useEntityFilter } from "@/lib/entity-filter-context";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, ChevronDown } from "lucide-react";

const UNKNOWN_BUCKET = "__unknown__";
type ProjectionCombinedForecastRow = ProjectionCombinedFyRow;

export default function Projections() {
  const { selected: globalEntityIds } = useEntityFilter();
  const [category, setCategory] = useState<FundraisingCategory>("revenue");
  const projParams = useMemo(
    () =>
      globalEntityIds.length > 0 || category
        ? {
            ...(globalEntityIds.length > 0
              ? { entityId: [...globalEntityIds].sort() }
              : {}),
            category,
          }
        : undefined,
    [globalEntityIds, category],
  );
  const proj = useGetProjectionsByFyEntity(projParams, {
    query: { queryKey: getGetProjectionsByFyEntityQueryKey(projParams) },
  });

  const entitiesQ = useListEntities({
    query: { queryKey: getListEntitiesQueryKey() },
  });
  const fyQ = useListFiscalYears(undefined, {
    query: { queryKey: getListFiscalYearsQueryKey() },
  });

  const { fyRows, entityCols, cell } = useMemo(() => {
    const rows = (proj.data?.rows ?? []).filter((r) => r.category === category);
    const fySeen = new Set<string>();
    const entSeen = new Set<string>();
    const cell = new Map<string, ProjectionByFyEntityRow>();
    for (const row of rows) {
      const fy = row.grantYear ?? UNKNOWN_BUCKET;
      const ent = row.entityId ?? UNKNOWN_BUCKET;
      fySeen.add(fy);
      entSeen.add(ent);
      cell.set(`${fy}|${ent}`, row);
    }
    const currentFy = currentFiscalYearSlug();
    const nextFy = `fy${currentFiscalYearEndYear() + 1}`;
    const fiscalYearEnd = (id: string) => {
      const year = Number(id.match(/\d{4}/)?.[0]);
      return Number.isFinite(year) ? year : -Infinity;
    };
    const fyRows = Array.from(fySeen).sort((a, b) => {
      const priority = (id: string) =>
        id === currentFy
          ? 0
          : id === nextFy
            ? 1
            : id === UNKNOWN_BUCKET
              ? 3
              : 2;
      const priorityDifference = priority(a) - priority(b);
      if (priorityDifference !== 0) return priorityDifference;
      if (a === UNKNOWN_BUCKET || b === UNKNOWN_BUCKET) return 0;
      return fiscalYearEnd(b) - fiscalYearEnd(a) || a.localeCompare(b);
    });
    const entityById = new Map(
      (entitiesQ.data ?? []).map((e) => [e.id, e.name] as const),
    );
    const entityCols = Array.from(entSeen).sort((a, b) => {
      if (a === UNKNOWN_BUCKET && b !== UNKNOWN_BUCKET) return 1;
      if (b === UNKNOWN_BUCKET && a !== UNKNOWN_BUCKET) return -1;
      const na = entityById.get(a) ?? a;
      const nb = entityById.get(b) ?? b;
      return na.localeCompare(nb);
    });
    return { fyRows, entityCols, cell };
  }, [proj.data, entitiesQ.data, category]);

  const combinedRows = useMemo(
    () =>
      (proj.data?.combinedRows ?? []).filter(
        (row) => row.category === category,
      ),
    [proj.data?.combinedRows, category],
  );

  const entityName = (id: string) => {
    if (id === UNKNOWN_BUCKET) return "Unknown recipient";
    const name = (entitiesQ.data ?? []).find((e) => e.id === id)?.name;
    return name ?? `Unknown recipient (${id})`;
  };
  const fyLabel = (id: string) => {
    if (id === UNKNOWN_BUCKET) return "Unknown fiscal year";
    const label = (fyQ.data ?? []).find((f) => f.id === id)?.label;
    return label ?? `Unknown fiscal year (${id})`;
  };

  const isLoading = proj.isLoading;
  const isError = proj.isError;
  const error = proj.error;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Projections
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Past fiscal years show amounts received. Current and future years show
          amounts received plus probability-weighted outstanding pledges and
          open opportunities, by recipient.
        </p>
      </div>

      <FundingCategoryToggle category={category} onChange={setCategory} />

      <ForecastTotals
        rows={combinedRows}
        fiscalYears={fyQ.data ?? []}
        category={category}
      />

      <div className="rounded-md border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fiscal year</TableHead>
              {entityCols.map((e) => (
                <TableHead key={e} className="whitespace-nowrap">
                  {entityName(e)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows cols={Math.max(entityCols.length + 1, 2)} />
            ) : isError ? (
              <TableRow>
                <TableCell
                  colSpan={Math.max(entityCols.length + 1, 2)}
                  className="text-center h-24 text-destructive"
                >
                  {error instanceof Error
                    ? error.message
                    : "Failed to load projections."}
                </TableCell>
              </TableRow>
            ) : fyRows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={Math.max(entityCols.length + 1, 2)}
                  className="text-center h-24 text-muted-foreground"
                >
                  No forecast information is available.
                </TableCell>
              </TableRow>
            ) : (
              <>
                {fyRows.map((fy) => {
                  return (
                    <TableRow key={fy} data-testid={`row-projection-${fy}`}>
                      <TableCell className="font-medium whitespace-nowrap">
                        {fyLabel(fy)}
                      </TableCell>
                      {entityCols.map((ent) => {
                        const row = cell.get(`${fy}|${ent}`);
                        return (
                          <TableCell
                            key={ent}
                            className="align-top"
                            data-testid={`cell-${fy}-${ent}`}
                          >
                            {row ? <ProjectionCell row={row} /> : "—"}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </>
            )}
          </TableBody>
        </Table>
      </div>
      {entityCols.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Recipient comparisons are useful for context, but they may not add up
          to the total because payment credit is capped once per opportunity
          within the selected recipient scope.
        </p>
      ) : null}
      <ForecastOmissions diagnostics={proj.data?.diagnostics ?? []} />
    </div>
  );
}

export function CashFlow() {
  const { selected: globalEntityIds } = useEntityFilter();
  const [category, setCategory] = useState<FundraisingCategory>("revenue");
  const params: GetFundingArrivalsByMonthParams = useMemo(
    () => ({
      category,
      ...(globalEntityIds.length > 0
        ? { entityId: [...globalEntityIds].sort() }
        : {}),
    }),
    [globalEntityIds, category],
  );
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Cash flow
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          See when committed and prospective funding is expected to arrive.
        </p>
      </div>
      <FundingCategoryToggle category={category} onChange={setCategory} />
      <CashFlowForecastTable params={params} />
    </div>
  );
}

function FundingCategoryToggle({
  category,
  onChange,
}: {
  category: FundraisingCategory;
  onChange: (category: FundraisingCategory) => void;
}) {
  return (
    <div
      className="flex items-center gap-1"
      data-testid="projections-category-toggle"
    >
      {[
        { value: "revenue" as const, label: "Grants / Revenue" },
        { value: "loan_capital" as const, label: "Loans / Loan Capital" },
      ].map((c) => (
        <button
          key={c.value}
          type="button"
          data-testid={`projections-category-${c.value}`}
          aria-pressed={category === c.value}
          onClick={() => onChange(c.value)}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            category === c.value
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/70"
          }`}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

const weightingLabel = (weighting: string | null) =>
  weighting == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "percent",
        maximumFractionDigits: 0,
      }).format(Number(weighting));

const cashFlowDateLabel = (date: string | null) =>
  date == null
    ? "—"
    : new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${date}T12:00:00Z`));

const cashFlowMoney = (amount: string | null) =>
  amount == null ? "—" : formatCurrency(amount);

const ROLLING_CLOSE_STAGES = ["cold_lead", "warm_lead", "in_conversation"];

function todayInChicago(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

type CashFlowRowUpdate = (
  row: CashFlowForecastRow,
  body: UpdateOpportunityOrPledgeBody,
  successTitle: string,
) => Promise<boolean>;

function CashFlowForecastTable({
  params,
}: {
  params: GetFundingArrivalsByMonthParams;
}) {
  const query = useGetFundingArrivalsByMonth(params, {
    query: { queryKey: getGetFundingArrivalsByMonthQueryKey(params) },
  });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateOpportunityOrPledge();
  const [pendingOpportunityId, setPendingOpportunityId] = useState<
    string | null
  >(null);
  const updateRow: CashFlowRowUpdate = async (row, body, successTitle) => {
    setPendingOpportunityId(row.opportunityId);
    try {
      await update.mutateAsync({ id: row.opportunityId, data: body });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getGetFundingArrivalsByMonthQueryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: getGetOpportunityOrPledgeQueryKey(row.opportunityId),
        }),
        queryClient.invalidateQueries({
          queryKey: getListOpportunitiesAndPledgesQueryKey(),
        }),
      ]);
      toast({ title: successTitle });
      return true;
    } catch (error) {
      toast({
        title: "Update failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
      return false;
    } finally {
      setPendingOpportunityId(null);
    }
  };
  if (query.isLoading)
    return (
      <div className="rounded-md border bg-card overflow-x-auto">
        <Table className="min-w-[1500px]">
          <TableBody>
            <SkeletonRows cols={12} />
          </TableBody>
        </Table>
      </div>
    );
  if (query.isError)
    return (
      <p role="alert" className="text-destructive">
        Could not load the cash-flow forecast.{" "}
        {query.error instanceof Error
          ? query.error.message
          : "Please try again."}
      </p>
    );
  if (!query.data) return null;
  const rows = query.data.rows;
  return (
    <section className="space-y-4" data-testid="cash-flow-forecast">
      <div>
        <h2 className="text-2xl font-serif font-bold">
          Opportunity cash-flow forecast
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Active opportunities and unpaid pledges, grouped by how their
          allocation plans support the Foundation, regions, and the Seed Fund.
        </p>
      </div>
      <div className="rounded-md border bg-card overflow-x-auto">
        <Table
          aria-label="Opportunity cash-flow forecast"
          className="min-w-[1650px]"
        >
          <TableHeader>
            <TableRow>
              <TableHead rowSpan={2} className="min-w-[240px] align-bottom">
                Opportunity or pledge
              </TableHead>
              <TableHead rowSpan={2} className="text-right align-bottom">
                Ask amount
              </TableHead>
              <TableHead rowSpan={2} className="text-right align-bottom">
                Current weighting
              </TableHead>
              <TableHead colSpan={2} className="text-center border-l">
                Wildflower Foundation
              </TableHead>
              <TableHead colSpan={2} className="text-center border-l">
                Region-restricted
              </TableHead>
              <TableHead colSpan={2} className="text-center border-l">
                Seed Fund
              </TableHead>
              <TableHead
                rowSpan={2}
                className="text-right align-bottom border-l"
              >
                Total
              </TableHead>
              <TableHead rowSpan={2} className="align-bottom border-l">
                Forecast cash-flow date
              </TableHead>
              <TableHead rowSpan={2} className="text-right align-bottom">
                Actions
              </TableHead>
            </TableRow>
            <TableRow>
              {["foundation", "regional", "seed"].flatMap((group) => [
                <TableHead
                  key={`${group}-committed`}
                  className="text-right border-l"
                >
                  Committed
                </TableHead>,
                <TableHead key={`${group}-target`} className="text-right">
                  Weighted target
                </TableHead>,
              ])}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={12}
                  className="h-24 text-center text-muted-foreground"
                >
                  No active opportunities or unpaid pledges match this scope.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <CashFlowForecastTableRow
                  key={row.opportunityId}
                  row={row}
                  busy={pendingOpportunityId === row.opportunityId}
                  onUpdate={updateRow}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Committed cells show unpaid pledge balances; weighted targets show open
        allocation amounts multiplied by the current weighting. Each allocation
        appears once: Seed Fund first, then donor-restricted regional work, then
        all other Wildflower Foundation work. The Total column adds those six
        cells. Forecast dates use the earliest remaining payment-plan date or,
        for a one-time prospect without a plan, its projected close date.
      </p>
    </section>
  );
}

function CashFlowForecastTableRow({
  row,
  busy,
  onUpdate,
}: {
  row: CashFlowForecastRow;
  busy: boolean;
  onUpdate: CashFlowRowUpdate;
}) {
  const cells = [
    row.foundationCommitted,
    row.foundationWeightedTarget,
    row.regionalCommitted,
    row.regionalWeightedTarget,
    row.seedFundCommitted,
    row.seedFundWeightedTarget,
  ];
  return (
    <TableRow data-testid={`cash-flow-row-${row.opportunityId}`}>
      <TableCell>
        <div className="flex items-start gap-2">
          {row.hasWeightedAskMismatch ? (
            <span
              className="mt-0.5 shrink-0 text-amber-600"
              aria-label="Total does not equal ask amount times current weighting"
              title="Total does not equal ask amount × current weighting"
              data-testid={`cash-flow-warning-${row.opportunityId}`}
            >
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            </span>
          ) : null}
          <div>
            <Link
              href={`/opportunities/${row.opportunityId}`}
              className="font-medium text-primary hover:underline"
            >
              {row.opportunityName ?? "Unnamed opportunity"}
            </Link>
            <span className="block text-xs text-muted-foreground">
              {row.status === "pledge" ? "Unpaid pledge" : "Opportunity"}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {cashFlowMoney(row.askAmount)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {weightingLabel(row.weighting)}
      </TableCell>
      {cells.map((amount, index) => (
        <TableCell
          key={index}
          className={`text-right tabular-nums ${index % 2 === 0 ? "border-l" : ""}`}
        >
          {cashFlowMoney(amount)}
        </TableCell>
      ))}
      <TableCell className="text-right tabular-nums font-semibold border-l">
        {cashFlowMoney(row.total)}
      </TableCell>
      <TableCell className="whitespace-nowrap border-l">
        <span
          className={
            row.projectedCloseMonthsOut != null &&
            row.forecastBasis === "projected_close"
              ? "italic"
              : undefined
          }
          title={
            row.projectedCloseMonthsOut != null &&
            row.forecastBasis === "projected_close"
              ? `Calculated from ${row.projectedCloseMonthsOut} month${row.projectedCloseMonthsOut === 1 ? "" : "s"} from now`
              : undefined
          }
          data-testid={`cash-flow-date-${row.opportunityId}`}
        >
          {cashFlowDateLabel(row.forecastDate)}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <CashFlowRowActions row={row} busy={busy} onUpdate={onUpdate} />
      </TableCell>
    </TableRow>
  );
}

function CashFlowRowActions({
  row,
  busy,
  onUpdate,
}: {
  row: CashFlowForecastRow;
  busy: boolean;
  onUpdate: CashFlowRowUpdate;
}) {
  const [dialog, setDialog] = useState<
    "rolling" | "date" | "dormant" | "lost" | null
  >(null);
  const [monthsDraft, setMonthsDraft] = useState(
    String(row.projectedCloseMonthsOut ?? 6),
  );
  const [dateDraft, setDateDraft] = useState(
    row.projectedCloseDate ??
      (row.forecastBasis === "projected_close" ? (row.forecastDate ?? "") : ""),
  );
  const rollingAllowed = ROLLING_CLOSE_STAGES.includes(row.stage ?? "");
  const months = Number(monthsDraft);
  const validMonths = Number.isInteger(months) && months >= 1 && months <= 24;
  const label = row.opportunityName ?? "this opportunity";

  const openRollingDialog = () => {
    setMonthsDraft(String(row.projectedCloseMonthsOut ?? 6));
    setDialog("rolling");
  };
  const openDateDialog = () => {
    setDateDraft(
      row.projectedCloseDate ??
        (row.forecastBasis === "projected_close"
          ? (row.forecastDate ?? "")
          : ""),
    );
    setDialog("date");
  };
  const saveRolling = async () => {
    if (!validMonths) return;
    if (
      await onUpdate(
        row,
        { projectedCloseMonthsOut: months },
        `Close timing switched to ${months} month${months === 1 ? "" : "s"} from now`,
      )
    ) {
      setDialog(null);
    }
  };
  const saveDate = async () => {
    if (!dateDraft) return;
    if (
      await onUpdate(
        row,
        { projectedCloseDate: dateDraft },
        "Projected close date updated",
      )
    ) {
      setDialog(null);
    }
  };
  const saveLoss = async () => {
    if (dialog !== "dormant" && dialog !== "lost") return;
    const lossType = dialog;
    if (
      await onUpdate(
        row,
        { lossType, actualCompletionDate: todayInChicago() },
        lossType === "dormant" ? "Marked dormant" : "Marked lost",
      )
    ) {
      setDialog(null);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={busy}
            aria-label={`Actions for ${label}`}
            data-testid={`cash-flow-actions-${row.opportunityId}`}
          >
            Actions
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem
            disabled={!rollingAllowed || busy}
            title={
              rollingAllowed
                ? undefined
                : "Rolling close is available only through In conversation."
            }
            onSelect={() =>
              void onUpdate(
                row,
                { projectedCloseMonthsOut: 6 },
                "Close timing switched to 6 months from now",
              )
            }
          >
            Switch to rolling 6 month close
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!rollingAllowed || busy}
            title={
              rollingAllowed
                ? undefined
                : "Rolling close is available only through In conversation."
            }
            onSelect={openRollingDialog}
          >
            Switch to rolling X month close…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={busy}
            onSelect={() => setDialog("dormant")}
          >
            Mark dormant…
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={busy}
            className="text-destructive focus:text-destructive"
            onSelect={() => setDialog("lost")}
          >
            Mark lost…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={busy} onSelect={openDateDialog}>
            Edit close date…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={dialog === "rolling"}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <DialogContent
          data-testid={`cash-flow-rolling-dialog-${row.opportunityId}`}
        >
          <DialogHeader>
            <DialogTitle>Set a rolling close</DialogTitle>
            <DialogDescription>
              Enter how many months from now {label} should be expected to
              close. The projected date will keep moving forward.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void saveRolling();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`cash-flow-months-${row.opportunityId}`}>
                Future months to close
              </Label>
              <Input
                id={`cash-flow-months-${row.opportunityId}`}
                type="number"
                min="1"
                max="24"
                step="1"
                value={monthsDraft}
                onChange={(event) => setMonthsDraft(event.target.value)}
                disabled={busy}
                autoFocus
                data-testid={`cash-flow-months-input-${row.opportunityId}`}
              />
              <p className="text-xs text-muted-foreground">
                Enter a whole number from 1 to 24.
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialog(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!validMonths || busy}>
                {busy ? "Saving…" : "Switch to rolling close"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog === "date"}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <DialogContent
          data-testid={`cash-flow-date-dialog-${row.opportunityId}`}
        >
          <DialogHeader>
            <DialogTitle>Edit projected close date</DialogTitle>
            <DialogDescription>
              Choose a specific projected close date for {label}. This replaces
              any rolling months-from-now timing.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void saveDate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`cash-flow-date-input-${row.opportunityId}`}>
                Projected close date
              </Label>
              <Input
                id={`cash-flow-date-input-${row.opportunityId}`}
                type="date"
                value={dateDraft}
                onChange={(event) => setDateDraft(event.target.value)}
                disabled={busy}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialog(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!dateDraft || busy}>
                {busy ? "Saving…" : "Save close date"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={dialog === "dormant" || dialog === "lost"}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Mark {label} {dialog === "lost" ? "lost" : "dormant"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This records the lifecycle outcome and removes the row from the
              active cash-flow forecast.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void saveLoss();
              }}
              className={
                dialog === "lost"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
            >
              {busy
                ? "Saving…"
                : dialog === "lost"
                  ? "Mark lost"
                  : "Mark dormant"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ProjectionCell({ row }: { row: ProjectionByFyEntityRow }) {
  const money = (value: string | null | undefined) =>
    value == null ? "—" : formatCurrency(value);
  const historical =
    /^fy\d{4}$/.test(row.grantYear ?? "") &&
    Number(row.grantYear!.slice(2)) < currentFiscalYearEndYear();
  return (
    <div className="min-w-[15rem] space-y-1 text-right text-xs tabular-nums">
      <div className="text-sm" data-testid="projection-cell-total">
        <ProjectionValue
          label={historical ? "Received" : "Received + weighted pipeline"}
          value={money(
            historical ? row.receivedGoalCredit : row.weightedProjection,
          )}
        />
      </div>
      {!historical && (
        <details className="pt-1">
          <summary className="cursor-pointer text-muted-foreground">
            Breakdown
          </summary>
          <ProjectionValue
            label="Received"
            value={money(row.receivedGoalCredit)}
          />
          <ProjectionValue
            label="Face-value unpaid commitments"
            value={money(row.unpaidCommitment)}
          />
          <ProjectionValue
            label="Probability-weighted unpaid commitments"
            value={money(row.unpaidCommitmentWeighted)}
          />
          <ProjectionValue
            label="Probability-weighted open asks"
            value={money(row.openAskWeighted)}
          />
          <ProjectionValue label="Goal" value={money(row.goal)} />
          <ProjectionValue label="Goal gap" value={money(row.goalGap)} />
        </details>
      )}
    </div>
  );
}

function ProjectionValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-left text-muted-foreground">{label}</span>
      <span className="shrink-0 font-medium text-foreground">{value}</span>
    </div>
  );
}

function forecastTotal(row: ProjectionCombinedForecastRow): string {
  if (row.weightedProjection == null) return "—";
  const amount = Number(row.weightedProjection);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

function ForecastTotals({
  rows,
  fiscalYears,
  category,
}: {
  rows: ProjectionCombinedForecastRow[];
  fiscalYears: { id: string; label: string }[];
  category: FundraisingCategory;
}) {
  const currentFy = currentFiscalYearSlug();
  const nextFy = `fy${currentFiscalYearEndYear() + 1}`;
  const rowByYear = new Map(rows.map((row) => [row.grantYear, row]));
  const fiscalYearLabel = (id: string | null) => {
    if (id == null) return "Unknown fiscal year";
    return (
      fiscalYears.find((fiscalYear) => fiscalYear.id === id)?.label ??
      `Unknown fiscal year (${id})`
    );
  };
  const orderedRows = [currentFy, nextFy]
    .map((year) => rowByYear.get(year))
    .filter((row): row is ProjectionCombinedFyRow => row != null);
  if (orderedRows.length === 0) return null;

  return (
    <section
      className="space-y-3 rounded-md border bg-card p-4"
      data-testid="projection-total-forecast"
    >
      <div>
        <h2 className="font-serif text-lg font-semibold">
          Total forecast for selected recipients —{" "}
          {category === "revenue" ? "Grants / Revenue" : "Loans / Loan Capital"}
        </h2>
        <p className="text-xs text-muted-foreground">
          These totals are the authoritative forecast for the selected recipient
          scope. Each opportunity contributes payment credit only once.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {orderedRows.map((row) => (
          <div
            key={row.grantYear}
            className="rounded-md border p-3"
            data-testid={`projection-total-${row.grantYear}`}
          >
            <h3 className="mb-2 font-medium">
              {fiscalYearLabel(row.grantYear)}
            </h3>
            <div className="space-y-1 text-right text-xs tabular-nums">
              <div data-testid="projection-total-amount">
                <ProjectionValue
                  label="Total forecast"
                  value={forecastTotal(row)}
                />
              </div>
              <ProjectionValue
                label="Received goal credit"
                value={formatCurrency(row.receivedGoalCredit)}
              />
              <ProjectionValue
                label="Face-value unpaid commitments"
                value={formatCurrency(row.unpaidCommitment)}
              />
              <ProjectionValue
                label="Probability-weighted unpaid commitments"
                value={formatCurrency(row.unpaidCommitmentWeighted)}
              />
              <ProjectionValue
                label="Probability-weighted open asks"
                value={formatCurrency(row.openAskWeighted)}
              />
              <ProjectionValue
                label="Goal"
                value={row.goal == null ? "—" : formatCurrency(row.goal)}
              />
              <ProjectionValue
                label="Goal gap"
                value={row.goalGap == null ? "—" : formatCurrency(row.goalGap)}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const OMISSION_REASON_LABELS: Record<string, string> = {
  missing_amount: "Amount is missing",
  missing_fiscal_year: "Fiscal year is missing",
  missing_recipient: "Recipient is missing",
  missing_reimbursement_type: "Reimbursement type is missing",
  no_allocations: "No forecast information is recorded",
  unused_capacity: "Cost-reimbursement unused capacity",
  direct_reimbursement_excluded:
    "Direct reimbursement is excluded from the forecast",
  zero_weight_early_prospect:
    "Early prospect has zero probability (weighted amount is $0)",
};

const NEEDS_ATTENTION_REASONS = new Set([
  "missing_amount",
  "missing_fiscal_year",
  "missing_recipient",
  "missing_reimbursement_type",
  "no_allocations",
]);

const INFORMATION_REASONS = new Set([
  "unused_capacity",
  "direct_reimbursement_excluded",
  "zero_weight_early_prospect",
]);

function ForecastOmissions({
  diagnostics,
}: {
  diagnostics: ProjectionForecastDiagnostic[];
}) {
  if (diagnostics.length === 0) return null;
  const needsAttention = diagnostics.filter((diagnostic) =>
    diagnostic.reasons.some((reason) => NEEDS_ATTENTION_REASONS.has(reason)),
  );
  const information = diagnostics.filter((diagnostic) =>
    diagnostic.reasons.some((reason) => INFORMATION_REASONS.has(reason)),
  );
  const renderDiagnostic = (diagnostic: ProjectionForecastDiagnostic) => (
    <li
      key={`${diagnostic.opportunityId}-${diagnostic.allocationId ?? "opportunity"}`}
      className="rounded-md border p-2"
    >
      <Link
        href={`/opportunities/${diagnostic.opportunityId}`}
        className="font-medium text-foreground hover:underline"
      >
        {diagnostic.opportunityName ?? diagnostic.opportunityId}
      </Link>
      <div className="mt-1 text-xs text-muted-foreground">
        {diagnostic.message ? <div>{diagnostic.message}</div> : null}
        <div>
          {diagnostic.reasons
            .map(
              (reason) =>
                OMISSION_REASON_LABELS[reason] ?? "Additional forecast detail",
            )
            .join("; ")}
        </div>
      </div>
    </li>
  );
  return (
    <section
      className="space-y-3 rounded-md border border-amber-300 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-950/20"
      data-testid="projection-omissions"
    >
      <div>
        {needsAttention.length > 0 ? (
          <div data-testid="projection-needs-attention">
            <h2 className="font-serif text-lg font-semibold">
              Needs attention
            </h2>
            <p className="text-xs text-muted-foreground">
              These records are missing details needed to place them in a
              forecast. A known-year amount with an unknown recipient can still
              count in the all-recipients total.
            </p>
            <ul className="mt-2 grid gap-2 md:grid-cols-2">
              {needsAttention.map(renderDiagnostic)}
            </ul>
          </div>
        ) : null}
        {information.length > 0 ? (
          <div
            className={
              needsAttention.length > 0
                ? "border-t border-amber-300 pt-3 dark:border-amber-900"
                : undefined
            }
            data-testid="projection-information"
          >
            <h2 className="font-serif text-lg font-semibold">Information</h2>
            <p className="text-xs text-muted-foreground">
              These notes explain forecast treatment. A known-year amount with
              an unknown recipient can still count in the all-recipients total.
            </p>
            <ul className="mt-2 grid gap-2 md:grid-cols-2">
              {information.map(renderDiagnostic)}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
