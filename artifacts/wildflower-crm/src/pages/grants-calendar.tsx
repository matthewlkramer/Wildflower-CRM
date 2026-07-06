import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListOpportunitiesAndPledges,
  useArchiveOpportunityOrPledge,
  useUpdateOpportunityOrPledge,
  getListOpportunitiesAndPledgesQueryKey,
  type OpportunityOrPledge,
  type OpportunityLossType,
  type UpdateOpportunityOrPledgeBody,
} from "@workspace/api-client-react";
import { RowActionIcons, InlineRowSaveActions } from "@/components/row-action-icons";
import { useSaveRunner } from "@/components/inline-edit";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDateShort, formatEnum } from "@/lib/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { MoreHorizontal } from "lucide-react";
import { SkeletonRows } from "@/components/ui/skeleton";
import { DonorCell } from "@/components/donor-cell";
import { useEntityFilter } from "@/lib/entity-filter-context";

const FETCH_LIMIT = 1000;

// Today's calendar date in Wildflower's booking timezone (America/Chicago),
// formatted as YYYY-MM-DD so it sorts/compares correctly against the
// date-only `applicationDeadline` / `projectedCloseDate` strings the API
// returns. Computed once per render — cheap, and avoids any UTC drift
// around midnight that would briefly hide today's deadlines.
function todayInChicago(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default function GrantsCalendar() {
  const { selected: globalEntityIds } = useEntityFilter();
  const queryParams = useMemo(
    () => ({
      status: ["open" as const],
      limit: FETCH_LIMIT,
      page: 1,
      ...(globalEntityIds.length > 0
        ? { entityId: [...globalEntityIds].sort() }
        : {}),
    }),
    [globalEntityIds],
  );
  const { data, isLoading, isError, error } = useListOpportunitiesAndPledges(
    queryParams,
    { query: { queryKey: getListOpportunitiesAndPledgesQueryKey(queryParams) } },
  );

  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const archiveMut = useArchiveOpportunityOrPledge();

  // Any row action that mutates the opportunity refetches the calendar so the
  // row re-sorts (dates) or drops out (loss type). A shared onError toast keeps
  // per-row handlers focused on the success path.
  const update = useUpdateOpportunityOrPledge({
    mutation: {
      onError: (err: unknown) =>
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getListOpportunitiesAndPledgesQueryKey(),
    });

  // Persist inline date edits (application deadline / projected close). Throws
  // on failure so the row's save runner leaves the editor open.
  const saveDates = async (id: string, body: UpdateOpportunityOrPledgeBody) => {
    await update.mutateAsync({ id, data: body });
    await invalidate();
    toast({ title: "Dates updated" });
  };

  // Set the lossType override (dormant/lost). Mirrors the detail page: when
  // there's no completion date yet, stamp today so the user doesn't have to.
  const resolveOpp = async (o: OpportunityOrPledge, lossType: OpportunityLossType) => {
    const body: UpdateOpportunityOrPledgeBody = { lossType };
    if (!o.actualCompletionDate) {
      body.actualCompletionDate = new Date().toISOString().slice(0, 10);
    }
    await update.mutateAsync({ id: o.id, data: body });
    await invalidate();
    toast({ title: lossType === "lost" ? "Marked lost" : "Marked dormant" });
  };

  // Archiving an opportunity here soft-deletes the underlying record; the list
  // is active-only, so it drops out of the calendar on the next refetch.
  const archiveOpportunity = (o: OpportunityOrPledge) =>
    archiveMut.mutate(
      { id: o.id },
      {
        onSuccess: async () => {
          await invalidate();
          toast({ title: "Opportunity archived" });
        },
        onError: (err: unknown) =>
          toast({
            title: "Archive failed",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );

  const ts = useTableState("grants-calendar", { key: "applicationDeadline", dir: "asc" });
  const STAGE_ORDER: Record<string, number> = {
    cold_lead: 1, warm_lead: 2, in_conversation: 3, convince: 4,
    probable_renewal: 5, verbal_confirmation: 6, complete: 7,
    // deprecated stages retained so any not-yet-backfilled rows still sort sanely
    conditional_commitment: 6, written_commitment: 6, cash_in: 7,
  };
  const today = todayInChicago();
  // Every open opportunity that has an application deadline or a projected
  // close date — including past-due ones (the future-only filter was removed
  // so overdue grants surface instead of silently disappearing). Base sort is
  // soonest-first so overdue items land at the top by default.
  const upcoming = useMemo(() => {
    const rows = data?.data ?? [];
    return rows
      .map((o) => ({
        o,
        sortDate: o.applicationDeadline ?? o.projectedCloseDate ?? "",
      }))
      .filter(({ sortDate }) => Boolean(sortDate))
      .sort((a, b) => a.sortDate.localeCompare(b.sortDate))
      .map(({ o }) => o);
  }, [data]);

  const sortedUpcoming = useMemo(
    () =>
      sortRows(
        upcoming,
        {
          applicationDeadline: (o) => o.applicationDeadline ?? null,
          projectedClose: (o) => o.projectedCloseDate ?? null,
          name: (o) => (o.name ?? "").toLowerCase(),
          funder: (o) =>
            (o.organizationName ?? o.householdName ?? o.individualGiverPersonName ?? "").toLowerCase(),
          primaryContact: (o) => o.primaryContactPersonName?.toLowerCase() ?? null,
          stage: (o) => (o.stage ? (STAGE_ORDER[o.stage] ?? 0) : null),
          ask: (o) => (o.askAmount != null ? Number(o.askAmount) : null),
        },
        ts.sort,
      ),
    [upcoming, ts.sort],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Grants calendar</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Open opportunities with an application deadline (or projected close), sorted soonest first. Overdue items are included and flagged at the top.
          {data && data.pagination.total > FETCH_LIMIT ? (
            <span> Showing the first {FETCH_LIMIT} of {data.pagination.total.toLocaleString()}.</span>
          ) : null}
        </p>
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTH colKey="applicationDeadline" {...ts}>Application deadline</SortableTH>
              <SortableTH colKey="projectedClose" {...ts}>Projected close</SortableTH>
              <SortableTH colKey="name" {...ts}>Name</SortableTH>
              <SortableTH colKey="funder" {...ts}>Funder</SortableTH>
              <SortableTH colKey="primaryContact" {...ts}>Primary contact</SortableTH>
              <SortableTH colKey="stage" {...ts}>Stage</SortableTH>
              <SortableTH colKey="ask" align="right" {...ts}>Ask</SortableTH>
              <TableHead className="w-[140px] text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows cols={8} />
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load opportunities."}
                </TableCell>
              </TableRow>
            ) : sortedUpcoming.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center h-24 text-muted-foreground">No open opportunities with an application deadline or projected close date.</TableCell></TableRow>
            ) : (
              sortedUpcoming.map((o: OpportunityOrPledge) => (
                <CalendarRow
                  key={o.id}
                  o={o}
                  today={today}
                  onOpen={() => navigate(`/opportunities/${o.id}`)}
                  onArchive={() => archiveOpportunity(o)}
                  onSaveDates={saveDates}
                  onResolve={resolveOpp}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// Overdue-aware date display: the driving date (application deadline, else
// projected close) is coloured red and paired with an "Overdue" badge when it's
// in the past.
function DateCell({ date, overdue }: { date: string | null | undefined; overdue: boolean }) {
  return (
    <span className={overdue ? "text-destructive font-medium" : undefined}>
      {formatDateShort(date)}
      {overdue ? (
        <Badge variant="destructive" className="ml-2 align-middle">Overdue</Badge>
      ) : null}
    </span>
  );
}

function CalendarRow({
  o,
  today,
  onOpen,
  onArchive,
  onSaveDates,
  onResolve,
}: {
  o: OpportunityOrPledge;
  today: string;
  onOpen: () => void;
  onArchive: () => void;
  onSaveDates: (id: string, body: UpdateOpportunityOrPledgeBody) => Promise<void>;
  onResolve: (o: OpportunityOrPledge, lossType: OpportunityLossType) => Promise<void>;
}) {
  const [editingDates, setEditingDates] = useState(false);
  const [appDraft, setAppDraft] = useState("");
  const [closeDraft, setCloseDraft] = useState("");
  const [confirmLoss, setConfirmLoss] = useState<OpportunityLossType | null>(null);
  const { busy, run } = useSaveRunner();

  const label = o.name ?? `Opportunity ${o.id}`;
  // Driving date = application deadline, else projected close. Overdue when it's
  // strictly before today in the booking timezone.
  const drivingIsApp = Boolean(o.applicationDeadline);
  const drivingDate = o.applicationDeadline ?? o.projectedCloseDate ?? "";
  const overdue = Boolean(drivingDate) && drivingDate < today;

  const startEditDates = () => {
    setAppDraft(o.applicationDeadline ?? "");
    setCloseDraft(o.projectedCloseDate ?? "");
    setEditingDates(true);
  };

  const saveDates = () => {
    const appNext = appDraft.trim().length === 0 ? null : appDraft;
    const closeNext = closeDraft.trim().length === 0 ? null : closeDraft;
    const dirty =
      appNext !== (o.applicationDeadline ?? null) ||
      closeNext !== (o.projectedCloseDate ?? null);
    if (!dirty) {
      setEditingDates(false);
      return;
    }
    run(
      () =>
        onSaveDates(o.id, {
          applicationDeadline: appNext,
          projectedCloseDate: closeNext,
        }),
      () => setEditingDates(false),
    );
  };

  const confirmResolve = () => {
    if (!confirmLoss) return;
    const lossType = confirmLoss;
    run(() => onResolve(o, lossType), () => setConfirmLoss(null));
  };

  return (
    <TableRow className="hover:bg-muted/50 transition-colors" data-testid={`row-cal-${o.id}`}>
      <TableCell>
        {editingDates ? (
          <Input
            type="date"
            value={appDraft}
            onChange={(e) => setAppDraft(e.target.value)}
            aria-label="Application deadline"
            disabled={busy}
            className="h-8"
            data-testid={`input-app-deadline-cal-${o.id}`}
          />
        ) : (
          <DateCell date={o.applicationDeadline} overdue={overdue && drivingIsApp} />
        )}
      </TableCell>
      <TableCell>
        {editingDates ? (
          <Input
            type="date"
            value={closeDraft}
            onChange={(e) => setCloseDraft(e.target.value)}
            aria-label="Projected close"
            disabled={busy}
            className="h-8"
            data-testid={`input-projected-close-cal-${o.id}`}
          />
        ) : (
          <DateCell date={o.projectedCloseDate} overdue={overdue && !drivingIsApp} />
        )}
      </TableCell>
      <TableCell className="font-medium">
        <Link href={`/opportunities/${o.id}`} className="block w-full">
          {o.name ?? `Untitled ${o.id}`}
        </Link>
      </TableCell>
      <TableCell>
        <DonorCell
          organizationId={o.organizationId}
          organizationName={o.organizationName}
          organizationPriority={o.organizationPriority}
          householdId={o.householdId}
          householdName={o.householdName}
          individualGiverPersonId={o.individualGiverPersonId}
          individualGiverPersonName={o.individualGiverPersonName}
          individualGiverPersonPriority={o.individualGiverPersonPriority}
        />
      </TableCell>
      <TableCell>
        {o.primaryContactPersonId ? (
          <Link
            href={`/individuals/${o.primaryContactPersonId}`}
            className="hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {o.primaryContactPersonName ?? o.primaryContactPersonId}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>{formatEnum(o.stage)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCurrency(o.askAmount)}</TableCell>
      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
        {editingDates ? (
          <InlineRowSaveActions
            onSave={saveDates}
            onCancel={() => setEditingDates(false)}
            saving={busy}
            testIdPrefix={`cal-${o.id}`}
          />
        ) : (
          <div className="flex items-center justify-end gap-0.5">
            <RowActionIcons
              entityLabel={label}
              testIdPrefix={`cal-${o.id}`}
              onOpen={onOpen}
              onEdit={startEditDates}
              onArchive={onArchive}
              disabled={busy}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  disabled={busy}
                  aria-label={`Resolve ${label}`}
                  title="Resolve"
                  data-testid={`button-resolve-cal-${o.id}`}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => setConfirmLoss("lost")}
                  data-testid={`menu-mark-lost-cal-${o.id}`}
                >
                  Mark lost
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setConfirmLoss("dormant")}
                  data-testid={`menu-mark-dormant-cal-${o.id}`}
                >
                  Mark dormant
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        <AlertDialog
          open={confirmLoss !== null}
          onOpenChange={(open) => {
            if (!open) setConfirmLoss(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Mark {confirmLoss === "lost" ? "lost" : "dormant"}?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-left">
                This sets {label}&apos;s loss type to{" "}
                {confirmLoss === "lost" ? "lost" : "dormant"}
                {o.actualCompletionDate ? "" : " and stamps today as the completion date"}, so it
                drops off the grants calendar. You can clear the loss type from the opportunity page
                to bring it back.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmResolve}
                disabled={busy}
                data-testid={`button-confirm-resolve-cal-${o.id}`}
              >
                Confirm
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}
