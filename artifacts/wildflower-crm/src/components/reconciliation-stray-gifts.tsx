import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListGiftsMissingQb,
  useListEntities,
  getListEntitiesQueryKey,
  useSearchReconciliationQbStaged,
  getSearchReconciliationQbStagedQueryKey,
  useReconcileStagedPayment,
  useUpdateGiftAllocation,
  useRevertGiftToOpportunity,
  GiftPaymentMethod,
  type GiftMissingQb,
  type ListGiftsMissingQbParams,
  type SearchReconciliationQbStagedParams,
  type UpdateGiftAllocationBody,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { FlagForResearchDialog } from "@/components/flag-for-research-dialog";
import { useDebounce } from "@/hooks/use-debounce";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDateShort, formatEnum } from "@/lib/format";
import { Loader2, MoreHorizontal } from "lucide-react";

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
 *   • Link allocation → payment   (reconcile the gift to a QuickBooks payment)
 *   • Link gift → payment         (reconcile the gift to a QuickBooks payment)
 *   • Edit row                    (PATCH this gift_allocation inline)
 *   • Revert gift → opportunity   (mint an open opportunity, archive the gift)
 *   • Revert gift → pledge        (mint a written pledge, archive the gift)
 *   • Flag for research           (add the gift to the Cleanup Queue)
 *
 * NB: the data model has no allocation-level payment link — reconciliation is
 * gift-level — so BOTH "link" actions reconcile the whole gift; they differ in
 * framing only.
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

export function StrayGiftsWorklist() {
  const [search, setSearch] = useState("");
  const [entityId, setEntityId] = useState<string>(ANY);
  const [paymentMethod, setPaymentMethod] = useState<string>(ANY);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);

  const debouncedSearch = useDebounce(search.trim());

  const entitiesQ = useListEntities({
    query: { queryKey: getListEntitiesQueryKey(), staleTime: 5 * 60_000 },
  });
  const entities = entitiesQ.data ?? [];

  // Reset paging whenever any filter changes.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, entityId, paymentMethod, dateFrom, dateTo]);

  const params = useMemo<ListGiftsMissingQbParams>(() => {
    const p: ListGiftsMissingQbParams = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (debouncedSearch) p.q = debouncedSearch;
    if (entityId !== ANY) p.entityId = entityId;
    if (paymentMethod !== ANY)
      p.paymentMethod = paymentMethod as GiftPaymentMethod;
    if (dateFrom) p.dateFrom = dateFrom;
    if (dateTo) p.dateTo = dateTo;
    return p;
  }, [debouncedSearch, entityId, paymentMethod, dateFrom, dateTo, page]);

  const { data, isLoading, isError } = useListGiftsMissingQb(params);

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const showingFrom = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const showingTo = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search donor name…"
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
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No gift allocations missing a QuickBooks record for these filters.
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Record</TableHead>
                <TableHead>Donor</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Recorded method</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Usage</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((g) => (
                <StrayGiftRow key={g.rowKey} g={g} entities={entities} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

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
  | "flag";

function StrayGiftRow({
  g,
  entities,
}: {
  g: GiftMissingQb;
  entities: EntityOption[];
}) {
  const [dialog, setDialog] = useState<RowDialog>(null);
  const close = () => setDialog(null);

  const recordLabel = g.giftName?.trim()
    ? g.giftName
    : `Gift ${g.id.slice(0, 8)}`;

  return (
    <TableRow data-testid={`stray-gift-${g.rowKey}`}>
      <TableCell>
        <Link
          href={`/gifts/${g.id}`}
          className="font-medium underline-offset-2 hover:underline"
        >
          {recordLabel}
        </Link>
        <div className="text-xs text-muted-foreground">
          {g.allocationId ? `Allocation ${g.allocationId.slice(0, 8)}` : "No allocation"}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {g.donorName ?? "—"}
      </TableCell>
      <TableCell className="tabular-nums">
        {g.allocationAmount != null ? (
          formatCurrency(g.allocationAmount)
        ) : g.displayAmount != null ? (
          <span title="Gift header amount (allocation sub-amount not set)">
            {formatCurrency(g.displayAmount)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            No amount recorded
          </span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {g.displayDate != null ? (
          formatDateShort(g.displayDate)
        ) : (
          <span className="text-xs">No date recorded</span>
        )}
      </TableCell>
      <TableCell>
        {g.paymentMethod ? formatEnum(g.paymentMethod) : "—"}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {g.entityName ?? "—"}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {g.displayUsage ??
          (g.intendedUsage ? formatEnum(g.intendedUsage) : "—")}
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              data-testid={`stray-gift-actions-${g.rowKey}`}
            >
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">Row actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setDialog("link-allocation")}>
              Link allocation → payment
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialog("link-gift")}>
              Link gift → payment
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!g.allocationId}
              onSelect={() => g.allocationId && setDialog("edit")}
            >
              Edit row
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setDialog("revert-opportunity")}>
              Revert gift → opportunity
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialog("revert-pledge")}>
              Revert gift → pledge
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setDialog("flag")}>
              Flag for research
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {(dialog === "link-allocation" || dialog === "link-gift") && (
          <PaymentLinkDialog
            g={g}
            scope={dialog === "link-allocation" ? "allocation" : "gift"}
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
      </TableCell>
    </TableRow>
  );
}

/* ── Link to payment ──────────────────────────────────────────────────────
 * Search QuickBooks staged payments and reconcile the GIFT to the picked one.
 * Reconciliation is gift-level in the data model, so both the allocation- and
 * gift-scoped menu entries land here; the scope changes the copy only.
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
    const p: SearchReconciliationQbStagedParams = { limit: 25 };
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

  const link = (stagedPaymentId: string) => {
    reconcile.mutate(
      { id: stagedPaymentId, data: { giftId: g.id } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: [MISSING_QB_KEY_PREFIX],
          });
          toast({
            title: "Linked to payment",
            description: "The gift is now reconciled to the QuickBooks payment.",
          });
          onClose();
        },
        onError: (err) =>
          toast({
            title: "Couldn't link",
            description:
              err instanceof Error ? err.message : "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(v) => (!v && !reconcile.isPending ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {scope === "allocation"
              ? "Link allocation to a payment"
              : "Link gift to a payment"}
          </DialogTitle>
          <DialogDescription>
            Find the QuickBooks payment for{" "}
            <span className="font-medium">{g.donorName ?? "this donor"}</span>{" "}
            and link it. Reconciliation is recorded against the whole gift.
          </DialogDescription>
        </DialogHeader>
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
                No matching QuickBooks payments.
              </p>
            ) : (
              <ul className="divide-y">
                {candidates.map((c) => {
                  const blocked = c.alreadyLinkedStagedPaymentId != null;
                  return (
                    <li
                      key={c.id}
                      className="flex items-center justify-between gap-3 p-3"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {c.label}
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
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={blocked || reconcile.isPending}
                        onClick={() => link(c.id)}
                        data-testid={`payment-link-pick-${c.id}`}
                      >
                        {blocked ? (
                          "Already linked"
                        ) : reconcile.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          "Link"
                        )}
                      </Button>
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
            disabled={reconcile.isPending}
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
