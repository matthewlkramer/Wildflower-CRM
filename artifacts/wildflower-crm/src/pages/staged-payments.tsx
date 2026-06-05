import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListStagedPayments,
  getListStagedPaymentsQueryKey,
  getGetStagedPaymentsSummaryQueryKey,
  useGetStagedPaymentsSummary,
  useReIncludeStagedPayment,
  useReconcileStagedPayment,
  useRevertStagedPayment,
  useExcludeStagedPayment,
  useConfirmStagedPaymentMatch,
  useUnmatchStagedPayment,
  useRunQuickbooksSync,
  useRematchStagedPayments,
  useReclassifyStagedPayments,
  useGetCurrentUser,
  useCreateOrganization,
  useCreatePerson,
  useCreateHousehold,
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  useCreateGiftOrPayment,
  getGetQuickbooksOauthStatusQueryKey,
  type StagedPayment,
  type StagedPaymentQueue,
  type StagedPaymentSort,
  type StagedPaymentExclusionReason,
  type StagedPaymentMatchMethod,
  type QuickbooksEntityType,
  type GiftOrPayment,
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DonorFieldPicker,
  donorBodyFor,
  type DonorType,
} from "@/components/entity-picker";
import { useToast } from "@/hooks/use-toast";

/* ────────────────────────────────────────────────────────────────────────
 * QuickBooks reconciliation — two-table reconciler.
 *
 * LEFT pane  = staged QuickBooks imports, filtered by queue + sortable. Each
 *              needs-review row shows its (read-only) donor + gift linkage, a
 *              badge-adjacent unmatch toggle, and an Exclude flow; it also acts
 *              as the "left selection" for matching. Donor matching is driven
 *              entirely from the right pane (no per-row donor picker).
 * RIGHT pane = CRM gifts, with free-text search (name + linked donor /
 *              intermediary), a date window, and a linked-to-QuickBooks
 *              filter. Each row is the "right selection" and, when already
 *              linked, offers an unmatch (revert) action.
 *
 * Selecting a left row + a right gift and pressing "Match" reconciles the
 * staged payment to the existing gift (no new gift minted). "Create new gift"
 * opens a dialog (donor search + create-if-none + gift fields) and, when a
 * left row is selected, reconciles the payment to the freshly-created gift.
 * ──────────────────────────────────────────────────────────────────────── */

const QUEUES: { value: StagedPaymentQueue; label: string }[] = [
  { value: "needs_review", label: "Needs review" },
  { value: "auto_matched", label: "Auto-matched" },
  { value: "done", label: "Done" },
  { value: "excluded", label: "Excluded" },
  { value: "rejected", label: "Rejected" },
];

const SORTS: { value: StagedPaymentSort; label: string }[] = [
  { value: "date_desc", label: "Date (newest)" },
  { value: "date_asc", label: "Date (oldest)" },
  { value: "amount_desc", label: "Amount (high → low)" },
  { value: "amount_asc", label: "Amount (low → high)" },
  { value: "payer_asc", label: "Payer (A → Z)" },
  { value: "payer_desc", label: "Payer (Z → A)" },
];

const EXCLUSION_REASON_LABELS: Record<StagedPaymentExclusionReason, string> = {
  zero_amount: "Zero amount",
  loan: "Loan activity",
  membership: "Membership dues",
  interest: "Interest / investment income",
  government_reimbursement: "Government reimbursement",
  tax_refund: "Tax / insurance refund",
  other_revenue: "Other revenue (non-gift)",
  earned_income: "Earned income (non-gift)",
  fiscally_sponsored: "Fiscally sponsored project",
  intercompany_transfer: "Intercompany transfer",
  other: "Other (not a gift)",
};

const QB_ENTITY_TYPE_LABELS: Record<QuickbooksEntityType, string> = {
  sales_receipt: "Sales Receipt",
  payment: "Payment",
  deposit: "Deposit",
};

const MATCH_METHOD_LABELS: Record<StagedPaymentMatchMethod, string> = {
  email: "Email match",
  name: "Name match",
  name_amount_date: "Name + amount + date",
  amount_date: "Amount + date",
  memo: "Memo match",
  intermediary: "Payment intermediary",
  manual: "Manual",
};

type LinkedFilter = "all" | "linked" | "unlinked";

function donorTypeFromRow(row: StagedPayment): DonorType {
  if (row.organizationId != null) return "organization";
  if (row.individualGiverPersonId != null) return "individual";
  if (row.householdId != null) return "household";
  return "organization";
}

function donorIdFromRow(row: StagedPayment, t: DonorType): string | null {
  if (t === "organization") return row.organizationId ?? null;
  if (t === "individual") return row.individualGiverPersonId ?? null;
  return row.householdId ?? null;
}

function donorNameFromRow(row: StagedPayment): string | null {
  return (
    row.organizationName ??
    row.individualGiverPersonName ??
    row.householdName ??
    null
  );
}

function giftDonorName(g: GiftOrPayment): string | null {
  return (
    g.organizationName ??
    g.individualGiverPersonName ??
    g.householdName ??
    null
  );
}

function formatAmount(amount: string | null | undefined): string {
  if (amount == null) return "—";
  const n = Number(amount);
  if (Number.isNaN(n)) return amount;
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

// Compact one-line label for a gift, shown in the cross-pane match bar so the
// operator can confirm exactly which gift is selected before pressing Match.
function giftRowLabel(g: GiftOrPayment): string {
  const donor = giftDonorName(g);
  return [g.name ?? "Untitled gift", formatAmount(g.amount), donor ?? undefined]
    .filter(Boolean)
    .join(" · ");
}

function formatDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

// Shift a yyyy-mm-dd date string by `days` and return yyyy-mm-dd (UTC math so
// the window is stable regardless of the viewer's timezone).
function shiftIsoDate(date: string | null | undefined, days: number): string {
  const base = date ? new Date(`${date}T00:00:00Z`) : new Date();
  if (Number.isNaN(base.getTime())) return "";
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

// When a candidate gift is larger than the QB net amount, surface the gap as a
// likely processing fee (CRM $50 gift vs QB $47.25 deposit → "+$2.75 fee?").
function feeDeltaLabel(
  stagedAmount: string | null | undefined,
  giftAmount: string | null | undefined,
): string {
  if (stagedAmount == null || giftAmount == null) return "";
  const staged = Number(stagedAmount);
  const gift = Number(giftAmount);
  if (Number.isNaN(staged) || Number.isNaN(gift)) return "";
  const delta = gift - staged;
  if (delta <= 0.01) return "";
  return ` · +${delta.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  })} fee?`;
}

// Three derived donor-match states for the badge / actions.
type MatchState = "unmatched" | "suggested" | "confirmed";

function matchStateOf(row: StagedPayment): MatchState {
  if (row.matchConfirmedAt != null) return "confirmed";
  const hasDonor =
    row.organizationId != null ||
    row.individualGiverPersonId != null ||
    row.householdId != null;
  if (!hasDonor || row.matchStatus === "unmatched") return "unmatched";
  return "suggested";
}

const MATCH_STATE_LABEL: Record<MatchState, string> = {
  unmatched: "Unmatched",
  suggested: "Suggested",
  confirmed: "Confirmed",
};

/* ──────────────────────────────────────────────────────────────────────── */

export default function StagedPayments() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const me = useGetCurrentUser().data ?? null;
  const isAdmin = me?.role === "admin";

  // Left pane (staged imports) state.
  const [queue, setQueue] = useState<StagedPaymentQueue>("needs_review");
  const [sort, setSort] = useState<StagedPaymentSort>("date_desc");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;

  // Cross-pane selection.
  const [selectedStaged, setSelectedStaged] = useState<StagedPayment | null>(
    null,
  );
  const [selectedGiftId, setSelectedGiftId] = useState<string | null>(null);
  const [selectedGiftLabel, setSelectedGiftLabel] = useState<string | null>(
    null,
  );

  // Single entry point for choosing a gift on the right pane so the id and the
  // human-readable label in the match bar never drift apart.
  const selectGift = (giftId: string | null, label: string | null) => {
    setSelectedGiftId(giftId);
    setSelectedGiftLabel(giftId ? label : null);
  };

  // Right pane (CRM gifts) filters.
  const [giftSearch, setGiftSearch] = useState("");
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState("");
  const [linkedFilter, setLinkedFilter] = useState<LinkedFilter>("all");
  const [giftPage, setGiftPage] = useState(1);
  const GIFT_PAGE_SIZE = 25;

  // Create-gift dialog.
  const [createOpen, setCreateOpen] = useState(false);

  const listParams = { queue, sort, limit: PAGE_SIZE, page };
  const listQ = useListStagedPayments(listParams, {
    query: { queryKey: getListStagedPaymentsQueryKey(listParams) },
  });
  const summaryQ = useGetStagedPaymentsSummary({
    query: { queryKey: getGetStagedPaymentsSummaryQueryKey() },
  });

  const invalidateStaged = () => {
    qc.invalidateQueries({ queryKey: ["/staged-payments"] });
    qc.invalidateQueries({ queryKey: getGetStagedPaymentsSummaryQueryKey() });
  };
  const invalidateGifts = () => {
    qc.invalidateQueries({ queryKey: ["/gifts-and-payments"] });
  };
  const invalidateAll = () => {
    invalidateStaged();
    invalidateGifts();
  };

  // ── Inline donor creation (org / person / household) ──────────────────────
  const createOrg = useCreateOrganization();
  const createPerson = useCreatePerson();
  const createHousehold = useCreateHousehold();

  const onCreateOrganization = (name: string): Promise<string | null> =>
    new Promise((resolve) => {
      createOrg.mutate(
        { data: { name } },
        {
          onSuccess: (created) => resolve(created?.id ?? null),
          onError: (e: unknown) => {
            toast({
              title: "Create organization failed",
              description: e instanceof Error ? e.message : "Unknown error",
              variant: "destructive",
            });
            resolve(null);
          },
        },
      );
    });

  const onCreatePerson = (name: string): Promise<string | null> =>
    new Promise((resolve) => {
      createPerson.mutate(
        { data: { fullName: name } },
        {
          onSuccess: (created) => resolve(created?.id ?? null),
          onError: (e: unknown) => {
            toast({
              title: "Create person failed",
              description: e instanceof Error ? e.message : "Unknown error",
              variant: "destructive",
            });
            resolve(null);
          },
        },
      );
    });

  const onCreateHousehold = (name: string): Promise<string | null> =>
    new Promise((resolve) => {
      createHousehold.mutate(
        { data: { name } },
        {
          onSuccess: (created) => resolve(created?.id ?? null),
          onError: (e: unknown) => {
            toast({
              title: "Create household failed",
              description: e instanceof Error ? e.message : "Unknown error",
              variant: "destructive",
            });
            resolve(null);
          },
        },
      );
    });

  const syncNow = useRunQuickbooksSync({
    mutation: {
      onSuccess: (data) => {
        invalidateAll();
        qc.invalidateQueries({ queryKey: getGetQuickbooksOauthStatusQueryKey() });
        toast({
          title: "Sync complete",
          description: data.ran
            ? `Pulled ${data.pulled}, staged ${data.staged} new (${data.autoApplied} auto-applied, ${data.matched} matched).`
            : "A sync was already in progress.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Sync failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const rematch = useRematchStagedPayments({
    mutation: {
      onSuccess: (data) => {
        invalidateStaged();
        toast({
          title: data.ran ? "Re-match complete" : "Re-match skipped",
          description: data.ran
            ? `Checked ${data.scanned} unmatched, newly suggested ${data.matched}.`
            : "A sync or re-match was already in progress.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Re-match failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const reclassify = useReclassifyStagedPayments({
    mutation: {
      onSuccess: (data) => {
        invalidateStaged();
        toast({
          title: data.ran ? "Reclassify complete" : "Reclassify skipped",
          description: data.ran
            ? `Scanned ${data.scanned}; excluded ${data.excluded}, restored ${data.included}.`
            : "A sync, re-match, or reclassify was already in progress.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Reclassify failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  // ── Cross-pane reconcile (Match) + unmatch (revert) ───────────────────────
  const reconcile = useReconcileStagedPayment({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        selectGift(null, null);
        setSelectedStaged(null);
        toast({
          title: "Matched",
          description: "Tied the payment to an existing gift.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Match failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const revert = useRevertStagedPayment({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        toast({
          title: "Unmatched",
          description: "Returned the payment to the needs-review queue.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Unmatch failed",
          description:
            e instanceof Error
              ? e.message
              : "Could not unmatch (a manually-created gift must be reverted from its own record).",
          variant: "destructive",
        }),
    },
  });

  const rows = listQ.data?.data ?? [];
  const total = listQ.data?.pagination?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const summary = summaryQ.data;

  useEffect(() => {
    if (!listQ.isFetching && page > totalPages) setPage(totalPages);
  }, [listQ.isFetching, page, totalPages]);

  // Drop a stale left selection if it falls out of the current queue/page.
  useEffect(() => {
    if (selectedStaged && !rows.some((r) => r.id === selectedStaged.id)) {
      setSelectedStaged(null);
    }
  }, [rows, selectedStaged]);

  const countFor = (q: StagedPaymentQueue): number | undefined => {
    if (!summary) return undefined;
    switch (q) {
      case "needs_review":
        return summary.needsReview;
      case "auto_matched":
        return summary.autoMatched;
      case "done":
        return summary.done;
      case "excluded":
        return summary.excluded;
      case "rejected":
        return summary.rejected;
    }
  };

  const activeLabel =
    QUEUES.find((q) => q.value === queue)?.label.toLowerCase() ?? "";

  // Selecting a payment seeds the gift pane with a donor-centric + date-window
  // search so likely existing gifts surface immediately. Filters stay editable.
  const selectStaged = (row: StagedPayment) => {
    if (selectedStaged?.id === row.id) {
      setSelectedStaged(null);
      selectGift(null, null);
      return;
    }
    setSelectedStaged(row);
    // Drop any gift carried over from a previous payment so a stale right-side
    // selection can never be matched to the newly chosen payment by accident.
    selectGift(null, null);
    setGiftSearch(donorNameFromRow(row) ?? row.payerName ?? "");
    setDateAfter(shiftIsoDate(row.dateReceived, -30));
    setDateBefore(shiftIsoDate(row.dateReceived, 30));
    setLinkedFilter("all");
    setGiftPage(1);
  };

  const canMatch =
    queue === "needs_review" &&
    selectedStaged != null &&
    selectedStaged.status === "pending" &&
    selectedGiftId != null &&
    !reconcile.isPending;

  const doMatch = () => {
    if (!selectedStaged || !selectedGiftId) return;
    reconcile.mutate({
      id: selectedStaged.id,
      data: { giftId: selectedGiftId },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            QuickBooks Reconciliation
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Incoming payments from QuickBooks on the left, your CRM gifts on the
            right. High-confidence matches are applied automatically
            (reversible); for the rest, pick a payment and an existing gift then
            press <span className="font-medium">Match</span>, or record a new
            gift.
          </p>
        </div>
        {isAdmin ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => reclassify.mutate()}
              disabled={
                reclassify.isPending || rematch.isPending || syncNow.isPending
              }
              data-testid="staged-reclassify"
              title="Re-run the non-gift classifier over auto-classified rows. Never touches a category you set by hand."
            >
              {reclassify.isPending ? "Reclassifying…" : "Reclassify"}
            </Button>
            <Button
              variant="outline"
              onClick={() => rematch.mutate()}
              disabled={
                rematch.isPending || syncNow.isPending || reclassify.isPending
              }
              data-testid="staged-rematch"
              title="Re-run donor auto-match over still-unmatched rows. Never overwrites a match you've already made."
            >
              {rematch.isPending ? "Re-matching…" : "Re-run matching"}
            </Button>
            <Button
              onClick={() => syncNow.mutate()}
              disabled={
                syncNow.isPending || rematch.isPending || reclassify.isPending
              }
              data-testid="staged-sync-now"
            >
              {syncNow.isPending ? "Syncing…" : "Sync now"}
            </Button>
          </div>
        ) : null}
      </div>

      {/* Cross-pane match bar. */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-3">
          <div className="text-sm">
            <span className="text-muted-foreground">Payment: </span>
            {selectedStaged ? (
              <span className="font-medium" data-testid="match-selected-staged">
                {selectedStaged.payerName ?? "Unknown payer"} ·{" "}
                {formatAmount(selectedStaged.amount)} ·{" "}
                {selectedStaged.dateReceived ?? "no date"}
              </span>
            ) : (
              <span className="text-muted-foreground">none selected</span>
            )}
          </div>
          <div className="text-sm">
            <span className="text-muted-foreground">Gift: </span>
            {selectedGiftId ? (
              <span className="font-medium" data-testid="match-selected-gift">
                {selectedGiftLabel ?? "selected"}
              </span>
            ) : (
              <span className="text-muted-foreground">none selected</span>
            )}
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              onClick={doMatch}
              disabled={!canMatch}
              data-testid="match-button"
              title={
                queue !== "needs_review"
                  ? "Switch to the Needs review queue to match a payment."
                  : "Reconcile the selected payment to the selected gift."
              }
            >
              {reconcile.isPending ? "Matching…" : "Match →"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(true)}
              disabled={createOpen}
              data-testid="open-create-gift"
              title="Record a brand-new gift (optionally from the selected payment)."
            >
              Create new gift…
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ── LEFT: staged QuickBooks imports ── */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={queue}
              onValueChange={(v) => {
                setQueue(v as StagedPaymentQueue);
                setPage(1);
                setSelectedStaged(null);
              }}
            >
              <SelectTrigger className="h-9 w-[170px]" data-testid="staged-queue">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUEUES.map((q) => {
                  const c = countFor(q.value);
                  return (
                    <SelectItem
                      key={q.value}
                      value={q.value}
                      data-testid={`staged-queue-${q.value}`}
                    >
                      {q.label}
                      {typeof c === "number" ? ` (${c})` : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <Select
              value={sort}
              onValueChange={(v) => {
                setSort(v as StagedPaymentSort);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9 w-[185px]" data-testid="staged-sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map((s) => (
                  <SelectItem
                    key={s.value}
                    value={s.value}
                    data-testid={`staged-sort-${s.value}`}
                  >
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {listQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : listQ.isError ? (
            <p className="text-sm text-red-700">
              Failed to load staged payments.
            </p>
          ) : rows.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No {activeLabel} payments.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {rows.map((row) => (
                <StagedPaymentCard
                  key={row.id}
                  row={row}
                  queue={queue}
                  selected={selectedStaged?.id === row.id}
                  onSelect={() => selectStaged(row)}
                  onChanged={invalidateAll}
                />
              ))}
            </div>
          )}

          {total > PAGE_SIZE || page > 1 ? (
            <div className="flex items-center justify-between pt-2">
              <p className="text-sm text-muted-foreground">
                Page {page} of {totalPages} · {total} total
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || listQ.isFetching}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  data-testid="staged-page-prev"
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || listQ.isFetching}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  data-testid="staged-page-next"
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {/* ── RIGHT: CRM gifts ── */}
        <GiftsPanel
          search={giftSearch}
          setSearch={(v) => {
            setGiftSearch(v);
            setGiftPage(1);
          }}
          dateAfter={dateAfter}
          setDateAfter={(v) => {
            setDateAfter(v);
            setGiftPage(1);
          }}
          dateBefore={dateBefore}
          setDateBefore={(v) => {
            setDateBefore(v);
            setGiftPage(1);
          }}
          linkedFilter={linkedFilter}
          setLinkedFilter={(v) => {
            setLinkedFilter(v);
            setGiftPage(1);
          }}
          page={giftPage}
          setPage={setGiftPage}
          pageSize={GIFT_PAGE_SIZE}
          selectedGiftId={selectedGiftId}
          onSelectGift={selectGift}
          stagedAmount={selectedStaged?.amount}
          onUnmatch={(stagedPaymentId) =>
            revert.mutate({ id: stagedPaymentId })
          }
          unmatching={revert.isPending}
        />
      </div>

      <CreateGiftDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        fromStaged={selectedStaged}
        onCreateOrganization={onCreateOrganization}
        onCreatePerson={onCreatePerson}
        onCreateHousehold={onCreateHousehold}
        onCreated={(giftId) => {
          invalidateGifts();
          // If a payment is selected and still pending, tie it to the new gift.
          if (
            selectedStaged &&
            selectedStaged.status === "pending" &&
            queue === "needs_review"
          ) {
            reconcile.mutate(
              {
                id: selectedStaged.id,
                data: { giftId },
              },
              {
                // The gift already exists at this point; if the link step
                // fails (e.g. the payment changed underneath) say so clearly
                // so the operator links it by hand instead of re-creating it.
                onError: (e: unknown) =>
                  toast({
                    title: "Gift created, but not linked",
                    description: `The new gift was saved but couldn't be tied to the payment automatically (${
                      e instanceof Error ? e.message : "unknown error"
                    }). Find it on the right and press Match.`,
                    variant: "destructive",
                  }),
              },
            );
          } else {
            toast({
              title: "Gift created",
              description: "Recorded a new gift.",
            });
          }
        }}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * LEFT: a single staged-payment card.
 * ──────────────────────────────────────────────────────────────────────── */

function StagedPaymentCard({
  row,
  queue,
  selected,
  onSelect,
  onChanged,
}: {
  row: StagedPayment;
  queue: StagedPaymentQueue;
  selected: boolean;
  onSelect: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();

  const editable = queue === "needs_review";
  const isExcluded = queue === "excluded";

  // A staged "deposit" row is a single direct deposit line with NO linked
  // Payment/SalesReceipt (those are skipped at pull time) — i.e. an uncertain
  // "might be an unrecorded donation" record. Keep it labeled "Deposit" so it
  // stays visually distinct, but surface the line's OWN description (which
  // usually carries the donor name / gift note) instead of the deposit-level
  // memo/bank-account name.
  const isDepositLine = row.qbEntityType === "deposit";
  const entityTypeLabel =
    QB_ENTITY_TYPE_LABELS[row.qbEntityType] ?? row.qbEntityType;
  const referenceText = isDepositLine
    ? (row.lineDescription ?? row.rawReference)
    : row.rawReference;

  const reInclude = useReIncludeStagedPayment({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({
          title: "Re-included",
          description: "Moved back to the needs-review queue.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Re-include failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const confirmMatch = useConfirmStagedPaymentMatch({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({ title: "Match confirmed" });
      },
      onError: (e: unknown) =>
        toast({
          title: "Confirm failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const unmatch = useUnmatchStagedPayment({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({ title: "Match cleared" });
      },
      onError: (e: unknown) =>
        toast({
          title: "Unmatch failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const revert = useRevertStagedPayment({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({
          title: "Reverted",
          description: "Returned to the needs-review queue.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Revert failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const [excludeReason, setExcludeReason] = useState<
    StagedPaymentExclusionReason | ""
  >(row.exclusionReason ?? "");
  useEffect(() => {
    setExcludeReason(row.exclusionReason ?? "");
  }, [row.id, row.exclusionReason]);
  const exclude = useExcludeStagedPayment({
    mutation: {
      onSuccess: () => {
        onChanged();
        toast({
          title: "Excluded",
          description: "Filed under a non-gift category. Re-include if wrong.",
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Exclude failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const [showDetails, setShowDetails] = useState(false);

  const busy =
    reInclude.isPending ||
    exclude.isPending ||
    confirmMatch.isPending ||
    unmatch.isPending ||
    revert.isPending;

  const matchState = matchStateOf(row);
  const donorLabel = donorNameFromRow(row);

  const wasReconciled = row.matchedGiftId != null;
  const wasAutoMinted = row.createdGiftId != null && row.autoApplied;
  const canRevert = wasReconciled || wasAutoMinted;

  const selectable = queue === "needs_review";

  return (
    <Card
      data-testid={`staged-payment-${row.id}`}
      className={selected ? "ring-2 ring-primary" : undefined}
    >
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <button
            type="button"
            className="text-left min-w-0"
            onClick={selectable ? onSelect : undefined}
            data-testid={`staged-select-${row.id}`}
            disabled={!selectable}
          >
            <CardTitle className="text-lg">
              {row.payerName ?? "Unknown payer"}
              <span className="ml-2 text-base font-normal text-muted-foreground">
                {formatAmount(row.amount)}
              </span>
            </CardTitle>
            <CardDescription>
              {entityTypeLabel} · {row.dateReceived ?? "no date"}
              {row.payerEmail ? ` · ${row.payerEmail}` : ""}
              {referenceText ? ` · ${referenceText}` : ""}
            </CardDescription>
          </button>
          <div className="flex flex-wrap items-center gap-1.5">
            {selectable ? (
              <Badge
                variant={selected ? "default" : "outline"}
                className="cursor-pointer"
                onClick={onSelect}
                data-testid={`staged-select-badge-${row.id}`}
              >
                {selected ? "Selected" : "Select"}
              </Badge>
            ) : null}
            {row.autoApplied &&
            (queue === "auto_matched" || queue === "done") ? (
              <Badge variant="outline" data-testid={`staged-auto-${row.id}`}>
                Auto-applied
              </Badge>
            ) : null}
            {typeof row.matchScore === "number" ? (
              <Badge
                variant="secondary"
                data-testid={`staged-score-${row.id}`}
                title={
                  row.matchMethod
                    ? (MATCH_METHOD_LABELS[row.matchMethod] ?? row.matchMethod)
                    : undefined
                }
              >
                {row.matchScore}% match
              </Badge>
            ) : null}
            {isExcluded && row.exclusionReason ? (
              <Badge variant="secondary">
                {EXCLUSION_REASON_LABELS[row.exclusionReason] ??
                  row.exclusionReason}
              </Badge>
            ) : !isExcluded && queue !== "rejected" ? (
              <>
                <Badge
                  variant={
                    matchState === "confirmed"
                      ? "default"
                      : matchState === "suggested"
                        ? "outline"
                        : "secondary"
                  }
                  data-testid={`staged-match-state-${row.id}`}
                >
                  {MATCH_STATE_LABEL[matchState]}
                </Badge>
                {editable && matchState !== "unmatched" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => unmatch.mutate({ id: row.id })}
                    disabled={busy}
                    data-testid={`staged-unmatch-${row.id}`}
                    title="Switch this back to unmatched (clears the matched donor)."
                  >
                    {unmatch.isPending ? "Unmatching…" : "Unmatch"}
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {editable ? (
          <>
            <div className="space-y-1 text-sm text-muted-foreground">
              <div>
                <span className="font-medium text-foreground">Donor:</span>{" "}
                {donorLabel ?? "Not matched yet"}
                {row.intermediaryName ? ` · via ${row.intermediaryName}` : ""}
              </div>
              <div>
                <span className="font-medium text-foreground">Gift:</span>{" "}
                {row.resolvedGiftName ? (
                  <>
                    {row.resolvedGiftName}
                    {row.resolvedGiftAmount
                      ? ` · ${formatAmount(row.resolvedGiftAmount)}`
                      : ""}
                    {row.resolvedGiftDate ? ` · ${row.resolvedGiftDate}` : ""}
                  </>
                ) : (
                  "Not linked to a gift yet"
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={excludeReason}
                onValueChange={(v) =>
                  setExcludeReason(v as StagedPaymentExclusionReason)
                }
                disabled={busy}
              >
                <SelectTrigger
                  className="h-9 w-[200px]"
                  data-testid={`staged-exclude-reason-${row.id}`}
                >
                  <SelectValue placeholder="Exclude as…" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EXCLUSION_REASON_LABELS).map(
                    ([value, label]) => (
                      <SelectItem
                        key={value}
                        value={value}
                        data-testid={`staged-exclude-reason-${row.id}-${value}`}
                      >
                        {label}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !excludeReason}
                onClick={() =>
                  excludeReason &&
                  exclude.mutate({
                    id: row.id,
                    data: { exclusionReason: excludeReason },
                  })
                }
                data-testid={`staged-exclude-${row.id}`}
              >
                {exclude.isPending ? "Excluding…" : "Exclude"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Select this payment, then pick a gift on the right and press Match —
              or use “Create new gift”. If it isn’t a gift, exclude it.
            </p>
          </>
        ) : isExcluded ? (
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              Excluded as a non-gift
              {row.exclusionReason
                ? ` (${EXCLUSION_REASON_LABELS[row.exclusionReason] ?? row.exclusionReason})`
                : ""}
              {row.classificationSource === "manual"
                ? " — set by hand"
                : " — auto-classified"}
              . Not deleted — re-include it, or change its category below.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => reInclude.mutate({ id: row.id })}
                disabled={busy}
                data-testid={`staged-re-include-${row.id}`}
              >
                {reInclude.isPending ? "Re-including…" : "Re-include → review"}
              </Button>
              <Select
                value={excludeReason}
                onValueChange={(v) =>
                  setExcludeReason(v as StagedPaymentExclusionReason)
                }
                disabled={busy}
              >
                <SelectTrigger
                  className="h-9 w-[200px]"
                  data-testid={`staged-reclassify-reason-${row.id}`}
                >
                  <SelectValue placeholder="Change category…" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EXCLUSION_REASON_LABELS).map(
                    ([value, label]) => (
                      <SelectItem
                        key={value}
                        value={value}
                        data-testid={`staged-reclassify-reason-${row.id}-${value}`}
                      >
                        {label}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  busy || !excludeReason || excludeReason === row.exclusionReason
                }
                onClick={() =>
                  excludeReason &&
                  exclude.mutate({
                    id: row.id,
                    data: { exclusionReason: excludeReason },
                  })
                }
                data-testid={`staged-reclassify-${row.id}`}
              >
                {exclude.isPending ? "Updating…" : "Update category"}
              </Button>
            </div>
          </div>
        ) : queue === "rejected" ? (
          <div className="text-sm text-muted-foreground">
            Rejected
            {row.rejectedAt ? ` · ${formatDateTime(row.rejectedAt)}` : ""}.
            Retained so a future sync won’t re-stage it.
          </div>
        ) : (
          <ResolvedSummary
            row={row}
            queue={queue}
            donorLabel={donorLabel}
            busy={busy}
            canRevert={canRevert}
            confirming={confirmMatch.isPending}
            reverting={revert.isPending}
            onConfirm={() => confirmMatch.mutate({ id: row.id })}
            onRevert={() => revert.mutate({ id: row.id })}
          />
        )}
        <StagedPaymentDetails
          row={row}
          donorLabel={donorLabel}
          show={showDetails}
          onToggle={() => setShowDetails((v) => !v)}
        />
      </CardContent>
    </Card>
  );
}

// Summary of an applied (approved) row for the Auto-matched / Done queues.
function ResolvedSummary({
  row,
  queue,
  donorLabel,
  busy,
  canRevert,
  confirming,
  reverting,
  onConfirm,
  onRevert,
}: {
  row: StagedPayment;
  queue: StagedPaymentQueue;
  donorLabel: string | null;
  busy: boolean;
  canRevert: boolean;
  confirming: boolean;
  reverting: boolean;
  onConfirm: () => void;
  onRevert: () => void;
}) {
  const reconciled = row.matchedGiftId != null;
  return (
    <div className="space-y-3">
      <div className="text-sm text-muted-foreground">
        Donor: {donorLabel ?? "—"}
        {row.intermediaryName ? ` · via ${row.intermediaryName}` : ""}
      </div>
      <div className="text-sm">
        {reconciled
          ? "Reconciled to an existing gift"
          : "New gift created from this payment"}
        {row.resolvedGiftName ? (
          <span className="text-muted-foreground">
            {" — "}
            {row.resolvedGiftName}
            {row.resolvedGiftAmount
              ? ` · ${formatAmount(row.resolvedGiftAmount)}`
              : ""}
            {row.resolvedGiftDate ? ` · ${row.resolvedGiftDate}` : ""}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {queue === "auto_matched" ? (
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            data-testid={`staged-confirm-auto-${row.id}`}
            title="Confirm this auto-applied match as reviewed; moves it to Done."
          >
            {confirming ? "Confirming…" : "Looks right → confirm"}
          </Button>
        ) : null}
        {canRevert ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onRevert}
            disabled={busy}
            data-testid={`staged-revert-${row.id}`}
            title={
              reconciled
                ? "Undo the link and return to review. The existing gift is untouched."
                : "Delete the auto-created gift and return to review."
            }
          >
            {reverting ? "Reverting…" : "Revert"}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground self-center">
            Manually created gift — revert from the gift record.
          </span>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * RIGHT: CRM gifts panel.
 * ──────────────────────────────────────────────────────────────────────── */

function GiftsPanel({
  search,
  setSearch,
  dateAfter,
  setDateAfter,
  dateBefore,
  setDateBefore,
  linkedFilter,
  setLinkedFilter,
  page,
  setPage,
  pageSize,
  selectedGiftId,
  onSelectGift,
  stagedAmount,
  onUnmatch,
  unmatching,
}: {
  search: string;
  setSearch: (v: string) => void;
  dateAfter: string;
  setDateAfter: (v: string) => void;
  dateBefore: string;
  setDateBefore: (v: string) => void;
  linkedFilter: LinkedFilter;
  setLinkedFilter: (v: LinkedFilter) => void;
  page: number;
  setPage: (v: number) => void;
  pageSize: number;
  selectedGiftId: string | null;
  onSelectGift: (id: string | null, label: string | null) => void;
  stagedAmount: string | null | undefined;
  onUnmatch: (stagedPaymentId: string) => void;
  unmatching: boolean;
}) {
  // Debounce the free-text search so we don't fire a request per keystroke.
  const [debounced, setDebounced] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const params = useMemo(() => {
    const p: {
      limit: number;
      page: number;
      search?: string;
      dateAfter?: string;
      dateBefore?: string;
      linkedToQuickbooks?: "linked" | "unlinked";
    } = { limit: pageSize, page };
    if (debounced.trim()) p.search = debounced.trim();
    if (dateAfter) p.dateAfter = dateAfter;
    if (dateBefore) p.dateBefore = dateBefore;
    if (linkedFilter !== "all") p.linkedToQuickbooks = linkedFilter;
    return p;
  }, [debounced, dateAfter, dateBefore, linkedFilter, page, pageSize]);

  const giftsQ = useListGiftsAndPayments(params, {
    query: { queryKey: getListGiftsAndPaymentsQueryKey(params) },
  });

  const gifts = giftsQ.data?.data ?? [];
  const total = giftsQ.data?.pagination?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search gifts — name, donor, or intermediary…"
          data-testid="gift-search"
        />
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">From</Label>
            <Input
              type="date"
              value={dateAfter}
              onChange={(e) => setDateAfter(e.target.value)}
              className="h-9 w-[150px]"
              data-testid="gift-date-after"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">To</Label>
            <Input
              type="date"
              value={dateBefore}
              onChange={(e) => setDateBefore(e.target.value)}
              className="h-9 w-[150px]"
              data-testid="gift-date-before"
            />
          </div>
          <Select
            value={linkedFilter}
            onValueChange={(v) => setLinkedFilter(v as LinkedFilter)}
          >
            <SelectTrigger
              className="h-9 w-[160px]"
              data-testid="gift-linked-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All gifts</SelectItem>
              <SelectItem value="unlinked">Not linked to QB</SelectItem>
              <SelectItem value="linked">Linked to QB</SelectItem>
            </SelectContent>
          </Select>
          {dateAfter || dateBefore || search || linkedFilter !== "all" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                setDateAfter("");
                setDateBefore("");
                setLinkedFilter("all");
              }}
              data-testid="gift-clear-filters"
            >
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      {giftsQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading gifts…</p>
      ) : giftsQ.isError ? (
        <p className="text-sm text-red-700">Failed to load gifts.</p>
      ) : gifts.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No matching gifts. Adjust the search or create a new gift.
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2" data-testid="gift-list">
          {gifts.map((g) => (
            <GiftRow
              key={g.id}
              gift={g}
              selected={selectedGiftId === g.id}
              onSelect={() =>
                onSelectGift(
                  selectedGiftId === g.id ? null : g.id,
                  selectedGiftId === g.id ? null : giftRowLabel(g),
                )
              }
              stagedAmount={stagedAmount}
              onUnmatch={onUnmatch}
              unmatching={unmatching}
            />
          ))}
        </ul>
      )}

      {total > pageSize || page > 1 ? (
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages} · {total} total
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || giftsQ.isFetching}
              onClick={() => setPage(Math.max(1, page - 1))}
              data-testid="gift-page-prev"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || giftsQ.isFetching}
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              data-testid="gift-page-next"
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GiftRow({
  gift,
  selected,
  onSelect,
  stagedAmount,
  onUnmatch,
  unmatching,
}: {
  gift: GiftOrPayment;
  selected: boolean;
  onSelect: () => void;
  stagedAmount: string | null | undefined;
  onUnmatch: (stagedPaymentId: string) => void;
  unmatching: boolean;
}) {
  const donorName = giftDonorName(gift);
  const linkedStagedId = gift.quickbooksStagedPaymentId ?? null;
  // A gift already linked to a QuickBooks payment can't be matched again; the
  // only action is Unmatch, so selecting it for Match is disabled.
  const selectable = linkedStagedId == null;
  return (
    <li
      className={`rounded border px-3 py-2 ${
        selected ? "ring-2 ring-primary" : ""
      }`}
      data-testid={`gift-row-${gift.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          className={`min-w-0 text-left ${selectable ? "" : "cursor-default"}`}
          onClick={selectable ? onSelect : undefined}
          data-testid={`gift-select-${gift.id}`}
        >
          <div className="truncate text-sm font-medium">
            {gift.name ?? "Untitled gift"}
            <span className="ml-2 font-normal text-muted-foreground">
              {formatAmount(gift.amount)}
            </span>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {donorName ? `${donorName} · ` : ""}
            {gift.dateReceived ?? "no date"}
            {gift.type ? ` · ${gift.type}` : ""}
            {gift.paymentIntermediaryName
              ? ` · via ${gift.paymentIntermediaryName}`
              : ""}
            {feeDeltaLabel(stagedAmount, gift.amount)}
          </div>
        </button>
        <div className="flex items-center gap-1.5">
          {linkedStagedId ? (
            <>
              <Badge variant="secondary" data-testid={`gift-linked-${gift.id}`}>
                Linked
              </Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onUnmatch(linkedStagedId)}
                disabled={unmatching}
                data-testid={`gift-unmatch-${gift.id}`}
                title="Undo the QuickBooks link. The gift itself is kept unless it was auto-created."
              >
                {unmatching ? "Unmatching…" : "Unmatch"}
              </Button>
            </>
          ) : (
            <Badge
              variant={selected ? "default" : "outline"}
              className="cursor-pointer"
              onClick={onSelect}
              data-testid={`gift-select-badge-${gift.id}`}
            >
              {selected ? "Selected" : "Select"}
            </Badge>
          )}
        </div>
      </div>
    </li>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Create-new-gift dialog.
 * ──────────────────────────────────────────────────────────────────────── */

function CreateGiftDialog({
  open,
  onOpenChange,
  fromStaged,
  onCreateOrganization,
  onCreatePerson,
  onCreateHousehold,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  fromStaged: StagedPayment | null;
  onCreateOrganization: (name: string) => Promise<string | null>;
  onCreatePerson: (name: string) => Promise<string | null>;
  onCreateHousehold: (name: string) => Promise<string | null>;
  onCreated: (giftId: string) => void;
}) {
  const { toast } = useToast();
  const [donorType, setDonorType] = useState<DonorType>("organization");
  const [donorId, setDonorId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [dateReceived, setDateReceived] = useState("");

  // Seed the form from the selected payment each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const t = fromStaged ? donorTypeFromRow(fromStaged) : "organization";
    setDonorType(t);
    setDonorId(fromStaged ? donorIdFromRow(fromStaged, t) : null);
    setName(fromStaged?.payerName ?? "");
    setAmount(fromStaged?.amount ?? "");
    setDateReceived(fromStaged?.dateReceived ?? "");
  }, [open, fromStaged]);

  const createGift = useCreateGiftOrPayment({
    mutation: {
      onSuccess: (created) => {
        onOpenChange(false);
        if (created?.id) onCreated(created.id);
      },
      onError: (e: unknown) =>
        toast({
          title: "Create gift failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const canSave = donorId != null && !createGift.isPending;

  const save = () => {
    if (!donorId) return;
    const donor = donorBodyFor(donorType, donorId);
    createGift.mutate({
      data: {
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(amount.trim() ? { amount: amount.trim() } : {}),
        ...(dateReceived ? { dateReceived } : {}),
        organizationId: donor.organizationId ?? undefined,
        individualGiverPersonId: donor.individualGiverPersonId ?? undefined,
        householdId: donor.householdId ?? undefined,
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="create-gift-dialog">
        <DialogHeader>
          <DialogTitle>Create new gift</DialogTitle>
          <DialogDescription>
            {fromStaged
              ? "Record a new gift and tie the selected QuickBooks payment to it."
              : "Record a new gift in the CRM."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-sm font-medium">Donor</Label>
            <div className="mt-1">
              <DonorFieldPicker
                type={donorType}
                id={donorId}
                onChange={(t, id) => {
                  setDonorType(t);
                  setDonorId(id);
                }}
                testIdBase="create-gift-donor"
                disabled={createGift.isPending}
                onCreateOrganization={onCreateOrganization}
                onCreatePerson={onCreatePerson}
                onCreateHousehold={onCreateHousehold}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label className="text-xs text-muted-foreground">Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Gift name / description"
                data-testid="create-gift-name"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Amount</Label>
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                data-testid="create-gift-amount"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">
                Date received
              </Label>
              <Input
                type="date"
                value={dateReceived}
                onChange={(e) => setDateReceived(e.target.value)}
                data-testid="create-gift-date"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createGift.isPending}
            data-testid="create-gift-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={!canSave}
            data-testid="create-gift-save"
          >
            {createGift.isPending ? "Saving…" : "Create gift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Read-only details dump for a staged row.
 * ──────────────────────────────────────────────────────────────────────── */

function StagedPaymentDetails({
  row,
  donorLabel,
  show,
  onToggle,
}: {
  row: StagedPayment;
  donorLabel: string | null;
  show: boolean;
  onToggle: () => void;
}) {
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: "QuickBooks type",
      value: QB_ENTITY_TYPE_LABELS[row.qbEntityType] ?? row.qbEntityType,
    },
    { label: "QuickBooks entity ID", value: row.qbEntityId },
    { label: "QuickBooks line ID", value: row.qbLineId },
    { label: "Realm ID", value: row.realmId },
    { label: "Amount", value: formatAmount(row.amount) },
    { label: "Date received", value: row.dateReceived },
    { label: "Payer name", value: row.payerName },
    { label: "Payer email", value: row.payerEmail },
    { label: "Reference / memo", value: row.rawReference },
    { label: "Line description", value: row.lineDescription },
    { label: "Status", value: row.status },
    { label: "Match status", value: row.matchStatus },
    {
      label: "Match method",
      value: row.matchMethod
        ? (MATCH_METHOD_LABELS[row.matchMethod] ?? row.matchMethod)
        : null,
    },
    {
      label: "Match score",
      value: typeof row.matchScore === "number" ? `${row.matchScore}%` : null,
    },
    { label: "Classification", value: row.classificationSource },
    {
      label: "Exclusion reason",
      value: row.exclusionReason
        ? (EXCLUSION_REASON_LABELS[row.exclusionReason] ?? row.exclusionReason)
        : null,
    },
    { label: "Donor", value: donorLabel },
    { label: "Intermediary", value: row.intermediaryName },
    { label: "Reconciled gift ID", value: row.matchedGiftId },
    { label: "Created gift ID", value: row.createdGiftId },
    { label: "Auto-applied", value: row.autoApplied ? "Yes" : "No" },
    { label: "Confirmed at", value: formatDateTime(row.matchConfirmedAt) },
    { label: "Approved at", value: formatDateTime(row.approvedAt) },
    { label: "Rejected at", value: formatDateTime(row.rejectedAt) },
    { label: "First seen", value: formatDateTime(row.createdAt) },
    { label: "Last updated", value: formatDateTime(row.updatedAt) },
  ];

  const lineGroups: { label: string; values: string[] | null | undefined }[] = [
    { label: "Line items", values: row.lineItemNames },
    { label: "Line accounts", values: row.lineAccountNames },
    { label: "Line classes", values: row.lineClasses },
  ];

  return (
    <div className="border-t pt-3">
      <Button
        variant="ghost"
        size="sm"
        className="px-0 text-xs text-muted-foreground hover:bg-transparent"
        onClick={onToggle}
        data-testid={`staged-details-toggle-${row.id}`}
      >
        {show ? "Hide details" : "Show details"}
      </Button>
      {show ? (
        <div className="mt-2 space-y-3" data-testid={`staged-details-${row.id}`}>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {rows.map((d) => (
              <div key={d.label} className="flex gap-2 text-sm">
                <dt className="min-w-[7.5rem] shrink-0 text-muted-foreground">
                  {d.label}
                </dt>
                <dd className="min-w-0 break-words">
                  {d.value === null || d.value === undefined || d.value === ""
                    ? "—"
                    : d.value}
                </dd>
              </div>
            ))}
          </dl>
          {lineGroups.map((g) => (
            <div key={g.label} className="text-sm">
              <div className="text-muted-foreground">{g.label}</div>
              {g.values && g.values.length > 0 ? (
                <ul className="ml-4 list-disc">
                  {g.values.map((v, i) => (
                    <li key={`${g.label}-${i}`} className="break-words">
                      {v}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="ml-1">—</div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
