import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListStripeStagedCharges,
  useGetStripeStagedChargesSummary,
  getGetStripeStagedChargesSummaryQueryKey,
  useResolveStripeStagedCharge,
  useCreateGiftFromStripeStagedCharge,
  useRejectStripeStagedCharge,
  useExcludeStripeStagedCharge,
  useReIncludeStripeStagedCharge,
  useRevertStripeStagedCharge,
  useRunStripeSync,
  useRematchStripeCharges,
  useGetStripeSyncStatus,
  getGetStripeSyncStatusQueryKey,
  useGetCurrentUser,
  type StripeStagedCharge,
  type StagedPaymentQueue,
  type StagedPaymentSort,
  type StagedPaymentExclusionReason,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
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
  DonorFieldPicker,
  donorBodyFor,
  type DonorType,
} from "@/components/entity-picker";
import { useToast } from "@/hooks/use-toast";
import { essentialSearchToken, looksLikeOrgName } from "@/lib/donor-seed";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  RefreshCw,
  RotateCcw,
  Search,
  Wand2,
} from "lucide-react";

/* ────────────────────────────────────────────────────────────────────────
 * Stripe reconciliation — single-pane review queue.
 *
 * Stripe charges are the source of truth: the sync worker stages one row per
 * charge under the payout it settled in. A fundraiser fixes the donor and either
 * mints a real gift (crediting the GROSS charge amount — the payout net is
 * gross − fees − refunds, the gap being processor fees) or files the row away.
 *
 * Leaner than the QuickBooks reconciler (no two-pane gift matcher): each
 * needs-review row carries its own inline donor picker plus Save / Create gift /
 * Reject / Exclude actions. Payout-level rollups and the non-destructive
 * QuickBooks supersede audit are shown per row so a reviewer can see fees and
 * any conflicting QuickBooks lump at a glance.
 * ──────────────────────────────────────────────────────────────────────── */

const PAGE_SIZE = 25;

const QUEUES: { value: StagedPaymentQueue; label: string }[] = [
  { value: "needs_review", label: "Needs review" },
  { value: "auto_matched", label: "Auto-matched" },
  { value: "done", label: "Done" },
  { value: "excluded", label: "Excluded" },
  { value: "rejected", label: "Rejected" },
];

const SORTS: { value: StagedPaymentSort; label: string }[] = [
  { value: "date_desc", label: "Newest first" },
  { value: "date_asc", label: "Oldest first" },
  { value: "amount_desc", label: "Largest first" },
  { value: "amount_asc", label: "Smallest first" },
  { value: "payer_asc", label: "Payer A–Z" },
  { value: "payer_desc", label: "Payer Z–A" },
];

const EXCLUSION_REASONS: { value: StagedPaymentExclusionReason; label: string }[] =
  [
    { value: "zero_amount", label: "Zero amount" },
    { value: "loan", label: "Loan" },
    { value: "membership", label: "Membership" },
    { value: "interest", label: "Interest" },
    { value: "government_reimbursement", label: "Government reimbursement" },
    { value: "tax_refund", label: "Tax refund" },
    { value: "other_revenue", label: "Other revenue" },
    { value: "earned_income", label: "Earned income" },
    { value: "fiscally_sponsored", label: "Fiscally sponsored" },
    { value: "intercompany_transfer", label: "Intercompany transfer" },
    { value: "insurance", label: "Insurance" },
    { value: "expense_refund", label: "Expense refund" },
    { value: "expensify", label: "Expensify" },
    { value: "returned_wire", label: "Returned wire" },
    { value: "other", label: "Other" },
  ];

const REASON_LABEL: Record<string, string> = Object.fromEntries(
  EXCLUSION_REASONS.map((r) => [r.value, r.label]),
);

function fmtMoney(v: string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v.length <= 10 ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function donorTypeFromRow(row: StripeStagedCharge): DonorType {
  if (row.organizationId != null) return "organization";
  if (row.individualGiverPersonId != null) return "individual";
  if (row.householdId != null) return "household";
  return "organization";
}

function donorIdFromRow(row: StripeStagedCharge, t: DonorType): string | null {
  if (t === "organization") return row.organizationId ?? null;
  if (t === "individual") return row.individualGiverPersonId ?? null;
  return row.householdId ?? null;
}

function donorNameFromRow(row: StripeStagedCharge): string | null {
  return (
    row.organizationName ??
    row.individualGiverPersonName ??
    row.householdName ??
    null
  );
}

// A single-word seed for the donor combobox: a person's last name or an org's
// brand word. The picker stays editable, so an imperfect guess is recoverable.
function donorSearchSeed(row: StripeStagedCharge): string {
  const base = donorNameFromRow(row) ?? row.payerName ?? "";
  if (!base) return "";
  const kind: "person" | "org" = looksLikeOrgName(base) ? "org" : "person";
  return essentialSearchToken(base, kind);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Unknown error";
}

export default function StripeStagedCharges() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [queue, setQueue] = useState<StagedPaymentQueue>("needs_review");
  const [sort, setSort] = useState<StagedPaymentSort>("date_desc");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to page 1 whenever the filter set changes.
  useEffect(() => {
    setPage(1);
  }, [queue, sort, debounced]);

  const { data: me } = useGetCurrentUser();
  const isAdmin = me?.role === "admin";

  const params = useMemo(
    () => ({
      queue,
      sort,
      page,
      pageSize: PAGE_SIZE,
      ...(debounced ? { search: debounced } : {}),
    }),
    [queue, sort, page, debounced],
  );

  const list = useListStripeStagedCharges(params);
  const summary = useGetStripeStagedChargesSummary();
  const syncStatus = useGetStripeSyncStatus({
    query: { queryKey: getGetStripeSyncStatusQueryKey(), enabled: isAdmin },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["/api/stripe-staged-charges"] });
    qc.invalidateQueries({
      queryKey: getGetStripeStagedChargesSummaryQueryKey(),
    });
  };
  const invalidateGifts = () =>
    qc.invalidateQueries({ queryKey: ["/api/gifts-and-payments"] });
  const invalidateStatus = () =>
    qc.invalidateQueries({ queryKey: getGetStripeSyncStatusQueryKey() });

  const runSync = useRunStripeSync({
    mutation: {
      onSuccess: (s) => {
        invalidate();
        invalidateStatus();
        toast({
          title: s.ran ? "Stripe sync complete" : "Sync skipped",
          description: s.ran
            ? `${s.payouts} payouts · ${s.staged} new charges · ${s.matched} matched · ${s.autoApplied} auto-applied`
            : "Another sync was already running, or Stripe is not configured.",
        });
      },
      onError: (e) =>
        toast({
          title: "Stripe sync failed",
          description: errMessage(e),
          variant: "destructive",
        }),
    },
  });

  const rematch = useRematchStripeCharges({
    mutation: {
      onSuccess: (s) => {
        invalidate();
        toast({
          title: s.ran ? "Rematch complete" : "Rematch skipped",
          description: s.ran
            ? `${s.scanned} scanned · ${s.matched} newly matched`
            : "A sync or rematch was already running.",
        });
      },
      onError: (e) =>
        toast({
          title: "Rematch failed",
          description: errMessage(e),
          variant: "destructive",
        }),
    },
  });

  const counts = summary.data;
  const queueCount = (v: StagedPaymentQueue): number | undefined => {
    if (!counts) return undefined;
    switch (v) {
      case "needs_review":
        return counts.needsReview;
      case "auto_matched":
        return counts.autoMatched;
      case "done":
        return counts.done;
      case "excluded":
        return counts.excluded;
      case "rejected":
        return counts.rejected;
    }
  };

  const rows = list.data?.data ?? [];
  const total = list.data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6 p-6" data-testid="stripe-staged-charges-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <CreditCard className="h-6 w-6 text-muted-foreground" />
            Stripe Review
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Incoming Stripe charges staged for review. Donors are credited the
            gross charge; the payout net is gross minus processor fees and
            refunds. Approving a charge records a gift in the CRM.
          </p>
        </div>
        {isAdmin && (
          <div className="flex flex-col items-end gap-2">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={rematch.isPending || runSync.isPending}
                onClick={() => rematch.mutate()}
                data-testid="button-stripe-rematch"
              >
                <Wand2 className="mr-2 h-4 w-4" />
                {rematch.isPending ? "Rematching…" : "Rematch"}
              </Button>
              <Button
                size="sm"
                disabled={runSync.isPending}
                onClick={() => runSync.mutate()}
                data-testid="button-stripe-sync"
              >
                <RefreshCw
                  className={`mr-2 h-4 w-4 ${runSync.isPending ? "animate-spin" : ""}`}
                />
                {runSync.isPending ? "Syncing…" : "Sync now"}
              </Button>
            </div>
            <SyncStatusLine
              configured={syncStatus.data?.configured ?? false}
              lastRunAt={syncStatus.data?.lastRunAt ?? null}
              lastRunStatus={syncStatus.data?.lastRunStatus ?? null}
              lastError={syncStatus.data?.lastError ?? null}
              consecutiveErrors={syncStatus.data?.consecutiveErrors ?? 0}
            />
          </div>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={queue}
              onValueChange={(v) => setQueue(v as StagedPaymentQueue)}
            >
              <SelectTrigger
                className="w-[200px]"
                data-testid="select-stripe-queue"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUEUES.map((q) => {
                  const c = queueCount(q.value);
                  return (
                    <SelectItem key={q.value} value={q.value}>
                      {q.label}
                      {c != null ? ` (${c})` : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>

            <div className="relative min-w-[220px] flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search payer, email, description…"
                className="pl-8"
                data-testid="input-stripe-search"
              />
            </div>

            <Select
              value={sort}
              onValueChange={(v) => setSort(v as StagedPaymentSort)}
            >
              <SelectTrigger
                className="w-[160px]"
                data-testid="select-stripe-sort"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {list.isLoading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Loading…
            </p>
          ) : list.isError ? (
            <p className="py-10 text-center text-sm text-destructive">
              Failed to load staged charges.
            </p>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Nothing in this queue.
            </p>
          ) : (
            rows.map((row) => (
              <ChargeRow
                key={row.id}
                row={row}
                queue={queue}
                onChanged={invalidate}
                onGiftChanged={invalidateGifts}
                toast={toast}
              />
            ))
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages} · {total} total
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  data-testid="button-stripe-prev"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  data-testid="button-stripe-next"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SyncStatusLine({
  configured,
  lastRunAt,
  lastRunStatus,
  lastError,
  consecutiveErrors,
}: {
  configured: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
  consecutiveErrors: number;
}) {
  if (!configured) {
    return (
      <span className="text-xs text-muted-foreground">
        Sync has not run yet.
      </span>
    );
  }
  const errored = lastRunStatus === "error" || consecutiveErrors > 0;
  return (
    <span
      className={`text-xs ${errored ? "text-destructive" : "text-muted-foreground"}`}
      data-testid="text-stripe-sync-status"
    >
      Last sync {fmtDate(lastRunAt)}
      {errored
        ? ` · error${consecutiveErrors > 1 ? ` ×${consecutiveErrors}` : ""}${
            lastError ? `: ${lastError}` : ""
          }`
        : " · ok"}
    </span>
  );
}

function ChargeRow({
  row,
  queue,
  onChanged,
  onGiftChanged,
  toast,
}: {
  row: StripeStagedCharge;
  queue: StagedPaymentQueue;
  onChanged: () => void;
  onGiftChanged: () => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const [donorType, setDonorType] = useState<DonorType>(donorTypeFromRow(row));
  const [donorId, setDonorId] = useState<string | null>(
    donorIdFromRow(row, donorTypeFromRow(row)),
  );
  const [reason, setReason] =
    useState<StagedPaymentExclusionReason>("other_revenue");

  const resolve = useResolveStripeStagedCharge();
  const createGift = useCreateGiftFromStripeStagedCharge();
  const reject = useRejectStripeStagedCharge();
  const exclude = useExcludeStripeStagedCharge();
  const reInclude = useReIncludeStripeStagedCharge();
  const revert = useRevertStripeStagedCharge();

  const busy =
    resolve.isPending ||
    createGift.isPending ||
    reject.isPending ||
    exclude.isPending ||
    reInclude.isPending ||
    revert.isPending;

  const qbConflict = row.payoutQbSupersedeStatus === "conflict_approved";
  const qbSuperseded = row.payoutQbSupersedeStatus === "excluded_pending";

  const donorBody = () => {
    const b = donorBodyFor(donorType, donorId);
    return {
      organizationId: b.organizationId ?? null,
      individualGiverPersonId: b.individualGiverPersonId ?? null,
      householdId: b.householdId ?? null,
      paymentIntermediaryId: row.matchedPaymentIntermediaryId ?? null,
    };
  };

  const onSaveMatch = async () => {
    if (!donorId) return;
    try {
      await resolve.mutateAsync({ id: row.id, data: donorBody() });
      onChanged();
      toast({ title: "Donor saved" });
    } catch (e) {
      toast({
        title: "Save failed",
        description: errMessage(e),
        variant: "destructive",
      });
    }
  };

  const onCreateGift = async () => {
    if (!donorId) return;
    try {
      // Persist the picked donor first (no-op if unchanged), then mint the
      // gift from that snapshot — the server reads the donor off the row.
      await resolve.mutateAsync({ id: row.id, data: donorBody() });
      await createGift.mutateAsync({ id: row.id });
      onChanged();
      onGiftChanged();
      toast({ title: "Gift created" });
    } catch (e) {
      toast({
        title: "Create gift failed",
        description: errMessage(e),
        variant: "destructive",
      });
    }
  };

  const onReject = async () => {
    try {
      await reject.mutateAsync({ id: row.id });
      onChanged();
      toast({ title: "Charge rejected" });
    } catch (e) {
      toast({
        title: "Reject failed",
        description: errMessage(e),
        variant: "destructive",
      });
    }
  };

  const onExclude = async () => {
    try {
      await exclude.mutateAsync({
        id: row.id,
        data: { exclusionReason: reason },
      });
      onChanged();
      toast({ title: "Charge excluded" });
    } catch (e) {
      toast({
        title: "Exclude failed",
        description: errMessage(e),
        variant: "destructive",
      });
    }
  };

  const onReInclude = async () => {
    try {
      await reInclude.mutateAsync({ id: row.id });
      onChanged();
      toast({ title: "Charge re-included" });
    } catch (e) {
      toast({
        title: "Re-include failed",
        description: errMessage(e),
        variant: "destructive",
      });
    }
  };

  const onRevert = async () => {
    try {
      await revert.mutateAsync({ id: row.id });
      onChanged();
      onGiftChanged();
      toast({ title: "Reverted to pending" });
    } catch (e) {
      toast({
        title: "Revert failed",
        description: errMessage(e),
        variant: "destructive",
      });
    }
  };

  return (
    <div
      className="rounded-lg border p-4"
      data-testid={`stripe-charge-${row.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium" data-testid="text-stripe-payer">
              {row.payerName || "Unknown payer"}
            </span>
            {row.refunded && <Badge variant="outline">Refunded</Badge>}
            {row.disputed && <Badge variant="destructive">Disputed</Badge>}
          </div>
          {row.payerEmail && (
            <p className="text-xs text-muted-foreground">{row.payerEmail}</p>
          )}
          {row.description && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {row.description}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {fmtDate(row.dateReceived ?? row.chargeCreated)} · {row.id}
          </p>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold" data-testid="text-stripe-gross">
            {fmtMoney(row.grossAmount)}
          </div>
          <div className="text-xs text-muted-foreground">
            fee {fmtMoney(row.feeAmount)} · net {fmtMoney(row.netAmount)}
            {row.amountRefunded && Number(row.amountRefunded) > 0
              ? ` · refunded ${fmtMoney(row.amountRefunded)}`
              : ""}
          </div>
        </div>
      </div>

      {(row.stripePayoutId || qbConflict || qbSuperseded) && (
        <div className="mt-2 space-y-1 text-xs">
          {row.stripePayoutId && (
            <p className="text-muted-foreground">
              Payout {row.stripePayoutId}
              {row.payoutArrivalDate
                ? ` · arrived ${fmtDate(row.payoutArrivalDate)}`
                : ""}
              {row.payoutNetTotal
                ? ` · net ${fmtMoney(row.payoutNetTotal)} (gross ${fmtMoney(
                    row.payoutGrossTotal,
                  )}, fees ${fmtMoney(row.payoutFeeTotal)})`
                : ""}
            </p>
          )}
          {qbConflict && (
            <p className="flex items-start gap-1.5 rounded bg-destructive/10 p-2 text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              This payout is already booked as an approved QuickBooks lump.
              Resolve the QuickBooks side before creating per-charge gifts here.
            </p>
          )}
          {qbSuperseded && (
            <p className="flex items-start gap-1.5 rounded bg-muted p-2 text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              The QuickBooks lump for this payout was auto-excluded so these
              per-charge gifts replace it.
            </p>
          )}
        </div>
      )}

      {/* Resolved gift linkage (auto-matched / done queues). */}
      {row.resolvedGiftId && (
        <p className="mt-2 text-xs text-muted-foreground">
          Linked to gift {row.resolvedGiftName || row.resolvedGiftId}
          {row.resolvedGiftAmount ? ` · ${fmtMoney(row.resolvedGiftAmount)}` : ""}
          {row.resolvedGiftDate ? ` · ${fmtDate(row.resolvedGiftDate)}` : ""}
        </p>
      )}

      {/* Excluded reason display. */}
      {queue === "excluded" && row.exclusionReason && (
        <p className="mt-2 text-xs text-muted-foreground">
          Excluded as: {REASON_LABEL[row.exclusionReason] ?? row.exclusionReason}
        </p>
      )}

      {/* Actions by queue. */}
      {queue === "needs_review" && (
        <div className="mt-3 space-y-3 border-t pt-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <Label className="text-xs text-muted-foreground">Donor</Label>
              <div className="mt-1">
                <DonorFieldPicker
                  type={donorType}
                  id={donorId}
                  onChange={(t, id) => {
                    setDonorType(t);
                    setDonorId(id);
                  }}
                  testIdBase={`stripe-donor-${row.id}`}
                  disabled={busy || qbConflict}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!donorId || busy}
                onClick={onSaveMatch}
                data-testid={`button-stripe-save-${row.id}`}
              >
                Save match
              </Button>
              <Button
                size="sm"
                disabled={!donorId || busy || qbConflict}
                onClick={onCreateGift}
                data-testid={`button-stripe-create-gift-${row.id}`}
              >
                Create gift
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={reason}
              onValueChange={(v) =>
                setReason(v as StagedPaymentExclusionReason)
              }
            >
              <SelectTrigger
                className="h-8 w-[200px] text-xs"
                data-testid={`select-stripe-reason-${row.id}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXCLUSION_REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onExclude}
              data-testid={`button-stripe-exclude-${row.id}`}
            >
              Exclude
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onReject}
              data-testid={`button-stripe-reject-${row.id}`}
            >
              Reject
            </Button>
          </div>
        </div>
      )}

      {(queue === "auto_matched" || queue === "done") && (
        <div className="mt-3 border-t pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onRevert}
            data-testid={`button-stripe-revert-${row.id}`}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Revert to pending
          </Button>
        </div>
      )}

      {queue === "excluded" && (
        <div className="mt-3 border-t pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onReInclude}
            data-testid={`button-stripe-re-include-${row.id}`}
          >
            Re-include
          </Button>
        </div>
      )}
    </div>
  );
}
