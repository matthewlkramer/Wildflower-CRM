import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  useListGiftsMissingQb,
  useListEntities,
  getListEntitiesQueryKey,
  useSearchReconciliationQbStaged,
  getSearchReconciliationQbStagedQueryKey,
  useReconcileStagedPayment,
  useRevertStagedPayment,
  useLinkStripeChargeToGift,
  useRevertStripeStagedCharge,
  useUpdateGiftAllocation,
  useArchiveGiftOrPayment,
  useRevertGiftToOpportunity,
  getGetGiftOrPaymentQueryOptions,
  getGetGiftOrPaymentQueryKey,
  GiftPaymentMethod,
  type GiftMissingQb,
  type GiftOrPaymentDetail,
  type ListGiftsMissingQbParams,
  type ListGiftsMissingQbFundingSource,
  type SearchReconciliationQbStagedParams,
  type UpdateGiftAllocationBody,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FlagForResearchDialog,
  BulkFlagForResearchDialog,
} from "@/components/flag-for-research-dialog";
import { BulkSelectBar } from "@/components/bulk-select-bar";
import { MergeGiftsDialog } from "@/components/gift-merge-dialogs";
import { useDebounce } from "@/hooks/use-debounce";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDateShort, formatEnum } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Combine,
  Flag,
  Loader2,
} from "lucide-react";

/* ────────────────────────────────────────────────────────────────────────
 * CRM-only worklist — "Gift allocations missing a QuickBooks record".
 *
 * One row PER gift_allocation (not per gift): a gift with three allocations is
 * three rows, each independently actionable. Gifts with no allocations still
 * surface as a single row. Allocations whose fund entity is not expected to
 * carry a per-gift QB record (entities.expectsPayment=false) are excluded
 * server-side, so nothing here reads as unreconciled when it isn't.
 *
 * The "Recorded method" column is the donor's stated payment method on the gift
 * (check, DAF, etc.) — it is NOT a found payment match.
 *
 * Per-row actions (the ⋯ menu):
 *   • Link allocation → payment   (reconcile the gift AND record this allocation
 *                                  onto the cash-application ledger row)
 *   • Link gift → payment         (reconcile the gift; header-only, no allocation)
 *   • Edit row                    (PATCH this gift_allocation inline)
 *   • Revert gift → opportunity   (mint an open opportunity, archive the gift)
 *   • Revert gift → pledge        (mint a written pledge, archive the gift)
 *   • Flag for research           (add the gift to the Cleanup Queue)
 *
 * NB: reconciliation (the tie/book-once math) is still gift-level — a payment
 * settles a GIFT. "Link allocation → payment" additionally stamps the chosen
 * gift_allocation onto the ledger row as a narrowing pointer, so the reviewer's
 * intent is recorded; "Link gift → payment" leaves that pointer null. The
 * allocation pointer is only sent when the row actually has an allocation.
 * ──────────────────────────────────────────────────────────────────────── */

const PAGE_SIZE = 50;
const MISSING_QB_KEY_PREFIX = "/api/reconciliation/gifts-missing-qb";

const PAYMENT_METHODS: GiftPaymentMethod[] = [
  "ach",
  "check",
  "wire",
  "stock",
  "donor_box",
  "daf_ach",
  "daf_check",
  "daf_bill_com",
];

const ANY = "__any__";

// Funding-source facet for this column only (server-side, mirrors the
// gifts-missing-qb route). qb_direct = money not routed through Stripe/Donorbox.
const FUNDING_SOURCES: { id: string; name: string }[] = [
  { id: ANY, name: "All sources" },
  { id: "stripe", name: "Stripe" },
  { id: "qb_direct", name: "QuickBooks direct" },
  { id: "donorbox", name: "Donorbox" },
];

export function StrayGiftsWorklist() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [entityId, setEntityId] = useState<string>(ANY);
  const [paymentMethod, setPaymentMethod] = useState<string>(ANY);
  const [fundingSource, setFundingSource] = useState<string>(ANY);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);

  // Bulk multi-select (this column only). Keyed by rowKey (gift:allocation).
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);

  const reconcile = useReconcileStagedPayment();
  const linkStripe = useLinkStripeChargeToGift();

  const debouncedSearch = useDebounce(search.trim());

  const entitiesQ = useListEntities({
    query: { queryKey: getListEntitiesQueryKey(), staleTime: 5 * 60_000 },
  });
  const entities = entitiesQ.data ?? [];

  // Reset paging whenever any filter changes.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, entityId, paymentMethod, fundingSource, dateFrom, dateTo]);

  const params = useMemo<ListGiftsMissingQbParams>(() => {
    const p: ListGiftsMissingQbParams = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (debouncedSearch) p.q = debouncedSearch;
    if (entityId !== ANY) p.entityId = entityId;
    if (paymentMethod !== ANY)
      p.paymentMethod = paymentMethod as GiftPaymentMethod;
    if (fundingSource !== ANY)
      p.fundingSource = fundingSource as ListGiftsMissingQbFundingSource;
    if (dateFrom) p.dateFrom = dateFrom;
    if (dateTo) p.dateTo = dateTo;
    return p;
  }, [
    debouncedSearch,
    entityId,
    paymentMethod,
    fundingSource,
    dateFrom,
    dateTo,
    page,
  ]);

  const { data, isLoading, isError } = useListGiftsMissingQb(params);

  const rows = data?.data ?? [];
  // Gifts matching the search text that are EXCLUDED from the worklist because
  // they are already tied to money — surfaced grayed-out so a search never reads
  // as "the gift doesn't exist" (mirrors the payment-side "Already linked" note).
  const linkedMatches = data?.linkedMatches ?? [];
  const total = data?.pagination.total ?? 0;
  const showingFrom = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const showingTo = Math.min((page + 1) * PAGE_SIZE, total);

  // Clear the selection whenever the underlying page of rows changes (filter,
  // paging, or a mutation refetch) so we never act on stale rowKeys.
  useEffect(() => {
    setSelectedKeys(new Set());
  }, [data]);

  const allKeys = rows.map((r) => r.rowKey);
  const selectedRows = rows.filter((r) => selectedKeys.has(r.rowKey));
  const allSelected =
    allKeys.length > 0 && allKeys.every((k) => selectedKeys.has(k));

  const toggleSelectKey = (rowKey: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedKeys((prev) => {
      const on = allKeys.every((k) => prev.has(k));
      return on ? new Set() : new Set(allKeys);
    });
  };

  // Bulk "Approve" = link each selected gift to ITS OWN suggested payment.
  // Only rows that actually carry a proposed payment can be linked; rows without
  // one are skipped (the user must search per-gift). Dedupe by gift id so a gift
  // split across allocation rows is only linked once. Runs sequentially through
  // the same guarded endpoints as the per-row Link button.
  const bulkLinkSelected = async () => {
    const seenGift = new Set<string>();
    const linkable = selectedRows.filter((g) => {
      if (!g.proposedPayment) return false;
      if (seenGift.has(g.id)) return false;
      seenGift.add(g.id);
      return true;
    });
    if (linkable.length === 0) {
      toast({
        title: "Nothing to link",
        description: "None of the selected gifts have a suggested payment.",
      });
      return;
    }
    setBulkBusy(true);
    let ok = 0;
    let failed = 0;
    for (const g of linkable) {
      const proposal = g.proposedPayment;
      if (!proposal) continue;
      try {
        if (proposal.source === "stripe") {
          if (!proposal.stripeChargeId) {
            failed += 1;
            continue;
          }
          await linkStripe.mutateAsync({
            id: proposal.stripeChargeId,
            data: { giftId: g.id },
          });
        } else {
          if (!proposal.stagedPaymentId) {
            failed += 1;
            continue;
          }
          await reconcile.mutateAsync({
            id: proposal.stagedPaymentId,
            data: {
              giftId: g.id,
              ...(g.allocationId ? { allocationId: g.allocationId } : {}),
            },
          });
        }
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setBulkBusy(false);
    setSelectedKeys(new Set());
    void queryClient.invalidateQueries({ queryKey: [MISSING_QB_KEY_PREFIX] });
    toast({
      title: `Linked ${ok} ${ok === 1 ? "gift" : "gifts"} to payments`,
      description:
        failed > 0
          ? `${failed} couldn't be linked and were skipped.`
          : "Each gift is now reconciled to its suggested payment.",
    });
  };

  // Snapshot the flag targets when the dialog opens. Reading them live from
  // `selectedRows` would let a background refetch (the `[data]` reset effect)
  // empty the selection while the dialog is open, disabling submit mid-review.
  const [flagTargets, setFlagTargets] = useState<
    { targetType: "gift"; targetId: string }[]
  >([]);
  const openFlagResearch = () => {
    setFlagTargets(
      selectedRows.map((g) => ({ targetType: "gift" as const, targetId: g.id })),
    );
    setFlagOpen(true);
  };

  // Combine selected gifts (design §4.6a) — collapse an over-split gift (one real
  // gift entered as several, e.g. once per restriction) into ONE gift with several
  // allocation rows, via the shared MergeGiftsDialog. Rows here are per-allocation,
  // so a gift split across allocations selects as several rows — dedupe to distinct
  // gift ids and require at least two. Snapshot the ids on open so the `[data]`
  // reset effect can't empty the dialog mid-review, then load each gift's full
  // detail (the dialog blocks submit until every selected gift resolves).
  const distinctSelectedGiftCount = new Set(selectedRows.map((r) => r.id)).size;
  // Rows are per-allocation, so selecting several rows of ONE gift is a common
  // trap: the selection looks like "several gifts" but there is nothing to
  // combine. Call it out explicitly instead of leaving the button silently gray.
  const sameGiftSelection =
    selectedRows.length >= 2 && distinctSelectedGiftCount < 2;
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeGiftIds, setMergeGiftIds] = useState<string[]>([]);
  const openCombine = () => {
    const ids = Array.from(new Set(selectedRows.map((r) => r.id)));
    if (ids.length < 2) return;
    setMergeGiftIds(ids);
    setMergeOpen(true);
  };
  const mergeQueries = useQueries({
    queries: mergeGiftIds.map((id) =>
      getGetGiftOrPaymentQueryOptions(id, {
        query: {
          enabled: mergeOpen,
          staleTime: 30_000,
          queryKey: getGetGiftOrPaymentQueryKey(id),
        },
      }),
    ),
  });
  const mergeRecords = useMemo<GiftOrPaymentDetail[]>(
    () =>
      mergeQueries
        .map((q) => q.data)
        .filter((d): d is GiftOrPaymentDetail => !!d),
    [mergeQueries],
  );
  const mergeExpectedCount = mergeGiftIds.length;
  const mergeLoadError = mergeQueries.some((q) => q.isError);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search donor or gift name…"
          className="h-9"
          data-testid="stray-gifts-search"
        />
        <Select value={entityId} onValueChange={setEntityId}>
          <SelectTrigger className="h-9" data-testid="stray-gifts-entity">
            <SelectValue placeholder="Entity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All entities</SelectItem>
            {entities.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={paymentMethod} onValueChange={setPaymentMethod}>
          <SelectTrigger className="h-9" data-testid="stray-gifts-method">
            <SelectValue placeholder="Payment method" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All methods</SelectItem>
            {PAYMENT_METHODS.map((m) => (
              <SelectItem key={m} value={m}>
                {formatEnum(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={fundingSource} onValueChange={setFundingSource}>
          <SelectTrigger className="h-9" data-testid="stray-gifts-funding">
            <SelectValue placeholder="Funding source" />
          </SelectTrigger>
          <SelectContent>
            {FUNDING_SOURCES.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="h-9"
          aria-label="Date from"
          data-testid="stray-gifts-date-from"
        />
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="h-9"
          aria-label="Date to"
          data-testid="stray-gifts-date-to"
        />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading allocations…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">Couldn't load allocations.</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent
            className="py-10 text-center text-sm text-muted-foreground"
            data-testid="stray-gifts-empty"
          >
            {debouncedSearch
              ? linkedMatches.length > 0
                ? "No unmatched gifts for this search — the matching gifts below are already tied to money."
                : "No gifts match this search in this column. If the money arrived but no gift record exists yet, create the gift from its payment card in the left column."
              : "No gift allocations missing a QuickBooks record for these filters."}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="rounded-md border bg-muted/30 px-2 py-2">
            <BulkSelectBar
              selectedCount={selectedRows.length}
              allSelected={allSelected}
              onToggleAll={toggleSelectAll}
              testId="checkbox-select-all-stray"
            >
              <Button
                size="sm"
                variant="outline"
                disabled={selectedRows.length === 0 || bulkBusy}
                onClick={bulkLinkSelected}
                data-testid="button-bulk-approve-stray"
              >
                {bulkBusy ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="mr-1 h-3.5 w-3.5" />
                )}
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={selectedRows.length === 0 || bulkBusy}
                onClick={openFlagResearch}
                data-testid="button-bulk-flag-stray"
              >
                <Flag className="mr-1 h-3.5 w-3.5" />
                Flag for research
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={distinctSelectedGiftCount < 2 || bulkBusy}
                onClick={openCombine}
                title={
                  sameGiftSelection
                    ? "The selected rows are all allocations of the same gift — it is already one combined gift."
                    : "Combine the selected gifts into one gift with several allocation rows (for a single grant entered as several gifts)."
                }
                data-testid="button-bulk-combine-stray"
              >
                <Combine className="mr-1 h-3.5 w-3.5" />
                Combine gifts
              </Button>
              {sameGiftSelection && (
                <span
                  className="text-xs text-muted-foreground"
                  data-testid="text-same-gift-selection-hint"
                >
                  These rows are parts (allocations) of one gift — it's already
                  combined.
                </span>
              )}
            </BulkSelectBar>
          </div>
          <div className="space-y-3">
            {rows.map((g) => (
              <StrayGiftCard
                key={g.rowKey}
                g={g}
                entities={entities}
                selected={selectedKeys.has(g.rowKey)}
                onToggleSelect={() => toggleSelectKey(g.rowKey)}
              />
            ))}
          </div>
        </>
      )}

      {!isLoading && !isError && linkedMatches.length > 0 && (
        <div className="space-y-1" data-testid="stray-gifts-linked-matches">
          <p className="text-xs font-medium text-muted-foreground">
            Matching gifts already tied to money (not in this worklist)
          </p>
          {linkedMatches.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm opacity-70"
              data-testid={`linked-match-${m.id}`}
            >
              <span className="min-w-0">
                <Link
                  href={`/gifts/${m.id}`}
                  className="font-medium hover:underline"
                >
                  {m.giftName?.trim() ||
                    m.donorName ||
                    `Gift ${m.id.slice(0, 8)}`}
                </Link>
                <span className="block text-xs text-muted-foreground">
                  {[
                    m.donorName,
                    m.dateReceived ? formatDateShort(m.dateReceived) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="block text-[10px] text-amber-600">
                  {m.linkedVia === "quickbooks"
                    ? "Already matched to a QuickBooks payment."
                    : "Settled through Stripe/Donorbox — money already booked."}
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatCurrency(m.amount)}
              </span>
            </div>
          ))}
        </div>
      )}

      <BulkFlagForResearchDialog
        targets={flagTargets}
        open={flagOpen}
        onOpenChange={setFlagOpen}
        onDone={() => setSelectedKeys(new Set())}
      />

      <MergeGiftsDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        gifts={mergeRecords}
        expectedCount={mergeExpectedCount}
        loadError={mergeLoadError}
        onDone={() => {
          setSelectedKeys(new Set());
          void queryClient.invalidateQueries({
            queryKey: [MISSING_QB_KEY_PREFIX],
          });
        }}
      />

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Showing {showingFrom}–{showingTo} of {total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              data-testid="stray-gifts-prev"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={showingTo >= total}
              onClick={() => setPage((p) => p + 1)}
              data-testid="stray-gifts-next"
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type EntityOption = { id: string; name: string };

type RowDialog =
  | null
  | "link-allocation"
  | "link-gift"
  | "edit"
  | "revert-opportunity"
  | "revert-pledge"
  | "archive-gift"
  | "flag";

/* ── One stray gift, rendered as a two-lane card ───────────────────────────
 * Mirrors the middle-column ReconCard frame (rounded-lg border bg-card, two
 * flex-1 lanes with an arrow between). Gift on the LEFT lane, the best-guess
 * UNLINKED QuickBooks payment on the RIGHT lane. Primary "Link" reconciles the
 * gift to that proposed payment; the ⋯ resolve menu covers the manual escape
 * hatches. There is deliberately NO "create a matching record" action — the QB
 * side is pull-only, so money can never be minted from here.
 * ──────────────────────────────────────────────────────────────────────── */
function StrayGiftCard({
  g,
  entities,
  selected = false,
  onToggleSelect,
}: {
  g: GiftMissingQb;
  entities: EntityOption[];
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<RowDialog>(null);
  const close = () => setDialog(null);

  const recordLabel = g.giftName?.trim()
    ? g.giftName
    : `Gift ${g.id.slice(0, 8)}`;

  const proposal = g.proposedPayment ?? null;
  const isStripe = proposal?.source === "stripe";
  const sourceLabel = isStripe ? "Stripe" : "QuickBooks";
  const reconcile = useReconcileStagedPayment();
  const linkStripe = useLinkStripeChargeToGift();
  const linking = reconcile.isPending || linkStripe.isPending;
  const archiveGift = useArchiveGiftOrPayment();

  const onLinkSuccess = () => {
    void queryClient.invalidateQueries({ queryKey: [MISSING_QB_KEY_PREFIX] });
    toast({
      title: "Linked to payment",
      description: `The gift is now reconciled to the ${sourceLabel} payment.`,
    });
  };
  const onLinkError = (err: unknown) =>
    toast({
      title: "Couldn't link",
      description: err instanceof Error ? err.message : "Something went wrong.",
      variant: "destructive",
    });

  // Primary action: reconcile the gift to the proposed unlinked payment.
  // QuickBooks staged payments reconcile through the QB path (carrying the
  // allocation pointer when this row has one); Stripe charges link through the
  // Stripe evidence path, which ties a charge to the gift (no allocation
  // pointer — the charge is gift-level evidence).
  const linkProposed = () => {
    if (!proposal) return;
    if (proposal.source === "stripe") {
      if (!proposal.stripeChargeId) return;
      linkStripe.mutate(
        { id: proposal.stripeChargeId, data: { giftId: g.id } },
        { onSuccess: onLinkSuccess, onError: onLinkError },
      );
      return;
    }
    if (!proposal.stagedPaymentId) return;
    reconcile.mutate(
      {
        id: proposal.stagedPaymentId,
        data: {
          giftId: g.id,
          ...(g.allocationId ? { allocationId: g.allocationId } : {}),
        },
      },
      { onSuccess: onLinkSuccess, onError: onLinkError },
    );
  };

  const amountText =
    g.allocationAmount != null
      ? formatCurrency(g.allocationAmount)
      : g.displayAmount != null
        ? formatCurrency(g.displayAmount)
        : null;
  const usageText =
    g.displayUsage ?? (g.intendedUsage ? formatEnum(g.intendedUsage) : null);
  const laneMeta = [g.entityName, usageText].filter(Boolean).join(" · ");

  return (
    <div
      className={cn(
        "rounded-lg border bg-card shadow-sm",
        selected && "ring-2 ring-primary",
      )}
      data-testid={`stray-gift-${g.rowKey}`}
    >
      <div className="flex items-stretch gap-0">
        {/* Select checkbox */}
        {onToggleSelect && (
          <div className="flex items-start p-3 pr-0">
            <Checkbox
              checked={selected}
              onCheckedChange={onToggleSelect}
              aria-label="Select gift"
              data-testid={`stray-gift-select-${g.rowKey}`}
            />
          </div>
        )}

        {/* Left lane — the CRM gift */}
        <div className="min-w-0 flex-1 break-words p-3">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            CRM gift
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Link
              href={`/gifts/${g.id}`}
              className="font-medium underline-offset-2 hover:underline"
            >
              {recordLabel}
            </Link>
          </div>
          <div className="text-lg font-semibold tabular-nums">
            {amountText ?? (
              <span className="text-sm font-normal text-muted-foreground">
                No amount recorded
              </span>
            )}
            {amountText && g.allocationAmount == null && (
              <span
                className="ml-1.5 text-xs font-normal text-muted-foreground"
                title="Gift header amount (allocation sub-amount not set)"
              >
                gift header
              </span>
            )}
          </div>
          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            <div>{g.donorName ?? "No donor"}</div>
            <div>
              {g.displayDate != null
                ? formatDateShort(g.displayDate)
                : "No date recorded"}
              {g.paymentMethod ? ` · ${formatEnum(g.paymentMethod)}` : ""}
            </div>
            {laneMeta && <div>{laneMeta}</div>}
            <div>
              {g.allocationId
                ? `Allocation ${g.allocationId.slice(0, 8)}`
                : "No allocation"}
            </div>
          </div>
        </div>

        {/* Arrow between lanes */}
        <div className="flex items-center px-1 text-muted-foreground">
          <ArrowRight className="h-4 w-4" />
        </div>

        {/* Right lane — the proposed payment (QuickBooks or Stripe; pull-only) */}
        <div className="min-w-0 flex-1 break-words p-3">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {proposal ? `${sourceLabel} payment` : "QuickBooks payment"}
          </div>
          {proposal ? (
            <>
              <div className="font-medium">
                {proposal.payerName ?? "Unknown payer"}
              </div>
              <div className="text-lg font-semibold tabular-nums">
                {proposal.amount != null ? formatCurrency(proposal.amount) : "—"}
              </div>
              <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                <div>
                  {proposal.dateReceived != null
                    ? formatDateShort(proposal.dateReceived)
                    : "No date"}
                  {proposal.paymentMethod ? ` · ${proposal.paymentMethod}` : ""}
                </div>
                {proposal.reference && (
                  <div className="truncate" title={proposal.reference}>
                    {proposal.reference}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div
              className="flex h-full min-h-[3.5rem] items-center text-sm text-muted-foreground"
              data-testid={`stray-gift-no-match-${g.rowKey}`}
            >
              No suggested payment — search to link.
            </div>
          )}
        </div>
      </div>

      {/* Footer — primary Link + resolve menu */}
      <div className="flex items-center gap-2 border-t p-3">
        <Button
          size="sm"
          className="gap-1 bg-emerald-600 text-white hover:bg-emerald-700"
          onClick={linkProposed}
          disabled={!proposal || linking}
          data-testid={`stray-gift-link-${g.rowKey}`}
        >
          {linking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          Link
        </Button>
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1"
                data-testid={`stray-gift-actions-${g.rowKey}`}
              >
                Resolve <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Resolve</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setDialog("link-gift")}>
                Search a different payment…
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!g.allocationId}
                onSelect={() => g.allocationId && setDialog("edit")}
              >
                Edit allocation
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setDialog("revert-opportunity")}>
                Revert gift → opportunity
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("revert-pledge")}>
                Revert gift → pledge
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => setDialog("archive-gift")}
              >
                Archive gift
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("flag")}>
                Flag for research
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {(dialog === "link-allocation" || dialog === "link-gift") && (
        <PaymentLinkDialog
          g={g}
          scope={g.allocationId ? "allocation" : "gift"}
          onClose={close}
        />
      )}
      {dialog === "edit" && g.allocationId && (
        <EditAllocationDialog g={g} entities={entities} onClose={close} />
      )}
      {(dialog === "revert-opportunity" || dialog === "revert-pledge") && (
        <RevertGiftDialog
          g={g}
          asPledge={dialog === "revert-pledge"}
          onClose={close}
        />
      )}
      <FlagForResearchDialog
        targetType="gift"
        targetId={g.id}
        recordLabel={recordLabel}
        hideTrigger
        open={dialog === "flag"}
        onOpenChange={(v) => (v ? setDialog("flag") : close())}
      />
      <AlertDialog
        open={dialog === "archive-gift"}
        onOpenChange={(v) => (v ? setDialog("archive-gift") : close())}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this gift?</AlertDialogTitle>
            <AlertDialogDescription>
              Archiving removes{" "}
              <span className="font-medium">{recordLabel}</span> from lists and
              financial totals. You can restore it later from the archive.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiveGift.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={archiveGift.isPending}
              data-testid={`stray-gift-archive-confirm-${g.rowKey}`}
              onClick={(e) => {
                e.preventDefault();
                archiveGift.mutate(
                  { id: g.id },
                  {
                    onSuccess: () => {
                      void queryClient.invalidateQueries({
                        queryKey: [MISSING_QB_KEY_PREFIX],
                      });
                      toast({
                        title: "Gift archived",
                        description: `“${recordLabel}” was archived.`,
                      });
                      close();
                    },
                    onError: (err) =>
                      toast({
                        title: "Couldn't archive gift",
                        description:
                          err instanceof Error
                            ? err.message
                            : "Something went wrong.",
                        variant: "destructive",
                      }),
                  },
                );
              }}
            >
              {archiveGift.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : null}
              Archive gift
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ── Link to payment ──────────────────────────────────────────────────────
 * Search QuickBooks staged payments AND Stripe charges (interleaved by
 * amount/date proximity, labeled by source) and reconcile the GIFT to the
 * picked one. Reconciliation is gift-level in the data model, so both the
 * allocation- and gift-scoped menu entries land here; the scope changes the
 * copy only. Picking a QB row goes through the staged-payment reconcile path
 * (optionally stamping the allocation pointer); picking a Stripe charge goes
 * through the per-charge link-gift path (gift-level evidence — no allocation
 * pointer exists for Stripe). A grayed already-linked row unlinks via the
 * matching revert path for its source.
 * ──────────────────────────────────────────────────────────────────────── */
function PaymentLinkDialog({
  g,
  scope,
  onClose,
}: {
  g: GiftMissingQb;
  scope: "allocation" | "gift";
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [q, setQ] = useState(g.donorName ?? "");
  const debouncedQ = useDebounce(q.trim());

  const amount = g.allocationAmount ?? g.displayAmount ?? undefined;
  const date = g.displayDate ?? undefined;

  const searchParams = useMemo<SearchReconciliationQbStagedParams>(() => {
    // includeStripe: this dialog hunts BOTH sources — QuickBooks staged
    // payments and Stripe charges — interleaved server-side by amount/date
    // proximity. Other qb-search callers stay QB-only (the default).
    const p: SearchReconciliationQbStagedParams = {
      limit: 25,
      includeStripe: true,
    };
    if (debouncedQ) p.q = debouncedQ;
    if (amount != null) p.amount = amount;
    if (date != null) {
      p.date = date;
      p.days = 30;
    }
    return p;
  }, [debouncedQ, amount, date]);

  const searchQ = useSearchReconciliationQbStaged(searchParams, {
    query: { queryKey: getSearchReconciliationQbStagedQueryKey(searchParams) },
  });
  const candidates = searchQ.data?.data ?? [];

  const reconcile = useReconcileStagedPayment();
  const revert = useRevertStagedPayment();
  const linkStripe = useLinkStripeChargeToGift();
  const revertStripe = useRevertStripeStagedCharge();
  const linkPending = reconcile.isPending || linkStripe.isPending;
  const unlinkPending = revert.isPending || revertStripe.isPending;

  // "Link allocation → payment" records the chosen allocation onto the ledger
  // row; "Link gift → payment" links the header only (no allocation pointer).
  const allocationLink = scope === "allocation" && g.allocationId != null;

  // Free a payment that's already tied to ANOTHER gift by reverting that
  // link (the source-matching revert path: staged-payment revert for QB,
  // per-charge revert for Stripe), then refresh the search so the row becomes
  // linkable. A minted (created) gift can't be reverted — the server 409s
  // "not_revertible"; surface that message rather than failing silently.
  const unlink = (c: { nodeType: string; id: string }) => {
    const onSuccess = () => {
      void queryClient.invalidateQueries({
        queryKey: getSearchReconciliationQbStagedQueryKey(searchParams),
      });
      // Reverting the other link also frees that gift back into the
      // gifts-missing-QB worklist, so refresh it too (mirrors `link`).
      void queryClient.invalidateQueries({
        queryKey: [MISSING_QB_KEY_PREFIX],
      });
      toast({
        title: "Unlinked",
        description: "Freed the payment from the other gift.",
      });
    };
    const onError = (err: unknown) =>
      toast({
        title: "Couldn't unlink",
        description:
          err instanceof Error ? err.message : "Something went wrong.",
        variant: "destructive",
      });
    if (c.nodeType === "stripe") {
      revertStripe.mutate({ id: c.id }, { onSuccess, onError });
    } else {
      revert.mutate({ id: c.id }, { onSuccess, onError });
    }
  };

  const link = (c: { nodeType: string; id: string }) => {
    const isStripe = c.nodeType === "stripe";
    const onSuccess = () => {
      void queryClient.invalidateQueries({
        queryKey: [MISSING_QB_KEY_PREFIX],
      });
      toast({
        title: "Linked to payment",
        description: isStripe
          ? // Stripe evidence is gift-level only — there is no allocation
            // pointer on the Stripe link path, even from the allocation row.
            "The gift is now linked to the Stripe charge."
          : allocationLink
            ? "This allocation is now linked to the QuickBooks payment."
            : "The gift is now reconciled to the QuickBooks payment.",
      });
      onClose();
    };
    const onError = (err: unknown) =>
      toast({
        title: "Couldn't link",
        description:
          err instanceof Error ? err.message : "Something went wrong.",
        variant: "destructive",
      });
    if (isStripe) {
      linkStripe.mutate({ id: c.id, data: { giftId: g.id } }, { onSuccess, onError });
    } else {
      reconcile.mutate(
        {
          id: c.id,
          data: {
            giftId: g.id,
            ...(allocationLink ? { allocationId: g.allocationId } : {}),
          },
        },
        { onSuccess, onError },
      );
    }
  };

  return (
    <Dialog open onOpenChange={(v) => (!v && !linkPending ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {scope === "allocation"
              ? "Link allocation to a payment"
              : "Link gift to a payment"}
          </DialogTitle>
          <DialogDescription>
            Find the QuickBooks or Stripe payment for{" "}
            <span className="font-medium">{g.donorName ?? "this donor"}</span>{" "}
            and link it.{" "}
            {allocationLink
              ? "A QuickBooks link is recorded against this allocation; a Stripe link is recorded against the whole gift."
              : "The link is recorded against the whole gift."}
          </DialogDescription>
        </DialogHeader>
        <div
          className="rounded-md border bg-muted/40 px-3 py-2"
          data-testid="payment-link-anchor-summary"
        >
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Matching this gift
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <span className="font-medium">{g.donorName ?? "No donor"}</span>
            <span className="font-semibold tabular-nums">
              {amount != null ? formatCurrency(amount) : "No amount"}
            </span>
            <span className="text-muted-foreground">
              {date != null ? formatDateShort(date) : "No date"}
            </span>
            {g.paymentMethod && (
              <span className="text-xs text-muted-foreground">
                {formatEnum(g.paymentMethod)}
              </span>
            )}
          </div>
        </div>
        <div className="space-y-3">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search payer, memo, reference…"
            data-testid="payment-link-search"
          />
          <div className="max-h-80 overflow-y-auto rounded-md border">
            {searchQ.isLoading ? (
              <p className="p-4 text-sm text-muted-foreground">Searching…</p>
            ) : candidates.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No matching payments.
              </p>
            ) : (
              <ul className="divide-y">
                {candidates.map((c) => {
                  // This payment is already tied to another gift — gray it and
                  // offer an unlink instead of a second (double-counting) link.
                  // A server-labeled conflictReason (excluded / already
                  // settled) also blocks: labeled, never hidden, so the user
                  // can spot a mis-derived status.
                  const blocked =
                    c.alreadyLinkedGiftId != null || c.conflictReason != null;
                  const isStripe = c.nodeType === "stripe";
                  // The whole row links (not just the small button) — but only
                  // for linkable rows; unlink stays behind its explicit button.
                  const rowClickable = !blocked && !linkPending;
                  return (
                    <li
                      key={`${c.nodeType}-${c.id}`}
                      className={cn(
                        "flex items-center justify-between gap-3 p-3",
                        blocked && "opacity-60",
                        rowClickable &&
                          "cursor-pointer transition-colors hover:bg-muted/50",
                      )}
                      onClick={rowClickable ? () => link(c) : undefined}
                      data-testid={`payment-link-row-${c.id}`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {c.label}
                          </span>
                          <Badge
                            variant="outline"
                            className="shrink-0 text-[10px] font-normal"
                            data-testid={`payment-link-source-${c.id}`}
                          >
                            {isStripe ? "Stripe" : "QuickBooks"}
                          </Badge>
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {[
                            c.amount != null ? formatCurrency(c.amount) : null,
                            c.date != null ? formatDateShort(c.date) : null,
                            c.sublabel ?? null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                        {blocked && (
                          <div className="mt-0.5 truncate text-xs text-amber-600">
                            {c.conflictReason ?? "Already linked to another gift"}
                          </div>
                        )}
                      </div>
                      {c.alreadyLinkedGiftId != null ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={unlinkPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            unlink(c);
                          }}
                          data-testid={`payment-link-unlink-${c.id}`}
                        >
                          {unlinkPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            "Unlink"
                          )}
                        </Button>
                      ) : blocked ? (
                        // conflictReason-blocked (excluded / already settled):
                        // no unlink to offer — the label above says why.
                        <Button
                          size="sm"
                          variant="outline"
                          disabled
                          data-testid={`payment-link-pick-${c.id}`}
                        >
                          Link
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={linkPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            link(c);
                          }}
                          data-testid={`payment-link-pick-${c.id}`}
                        >
                          {linkPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            "Link"
                          )}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={linkPending}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Edit row (one gift_allocation) ───────────────────────────────────────── */
function EditAllocationDialog({
  g,
  entities,
  onClose,
}: {
  g: GiftMissingQb;
  entities: EntityOption[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [subAmount, setSubAmount] = useState(g.allocationAmount ?? "");
  const [allocEntityId, setAllocEntityId] = useState(g.entityId ?? ANY);

  const update = useUpdateGiftAllocation();

  const save = () => {
    if (!g.allocationId) return;
    const body: UpdateGiftAllocationBody = {
      subAmount: subAmount.trim() === "" ? null : subAmount.trim(),
      entityId: allocEntityId === ANY ? null : allocEntityId,
    };
    update.mutate(
      { id: g.allocationId, data: body },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: [MISSING_QB_KEY_PREFIX],
          });
          toast({ title: "Allocation updated" });
          onClose();
        },
        onError: (err) =>
          toast({
            title: "Couldn't update",
            description:
              err instanceof Error ? err.message : "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(v) => (!v && !update.isPending ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit allocation</DialogTitle>
          <DialogDescription>
            Update this allocation row on{" "}
            <span className="font-medium">{g.giftName ?? "the gift"}</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="edit-alloc-amount">Sub-amount</Label>
            <Input
              id="edit-alloc-amount"
              inputMode="decimal"
              value={subAmount}
              onChange={(e) => setSubAmount(e.target.value)}
              placeholder="0.00"
              data-testid="edit-alloc-amount"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Fund entity</Label>
            <Select value={allocEntityId} onValueChange={setAllocEntityId}>
              <SelectTrigger data-testid="edit-alloc-entity">
                <SelectValue placeholder="Entity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>None</SelectItem>
                {entities.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={update.isPending} data-testid="edit-alloc-save">
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Revert gift → opportunity / pledge ───────────────────────────────────── */
function RevertGiftDialog({
  g,
  asPledge,
  onClose,
}: {
  g: GiftMissingQb;
  asPledge: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const revert = useRevertGiftToOpportunity();

  const target = asPledge ? "pledge" : "opportunity";

  const confirm = () => {
    revert.mutate(
      { id: g.id, data: { asPledge } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: [MISSING_QB_KEY_PREFIX],
          });
          toast({
            title: `Reverted to ${target}`,
            description: `The gift was archived and a new ${target} was created.`,
          });
          onClose();
        },
        onError: (err) =>
          toast({
            title: "Couldn't revert",
            description:
              err instanceof Error ? err.message : "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <AlertDialog open onOpenChange={(v) => (!v && !revert.isPending ? onClose() : undefined)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revert gift to {target}?</AlertDialogTitle>
          <AlertDialogDescription>
            This archives the gift{" "}
            <span className="font-medium">{g.giftName ?? g.donorName ?? ""}</span>{" "}
            and mints a new {target} with the gift's allocations carried over.
            {asPledge
              ? " The new pledge is marked as a written pledge."
              : " The new opportunity is open (not yet committed)."}{" "}
            Gifts linked to a QuickBooks payment can't be reverted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revert.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              confirm();
            }}
            disabled={revert.isPending}
            data-testid="revert-gift-confirm"
          >
            {revert.isPending ? "Reverting…" : `Revert to ${target}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
