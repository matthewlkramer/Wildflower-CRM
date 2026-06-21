import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListReconciliationCards,
  useApproveReconciliationCard,
  type ListReconciliationCardsParams,
  type ApproveCompleteMatchBody,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useDebounce } from "@/hooks/use-debounce";
import { ReconciliationCard } from "@/components/reconciliation-card";

/* ────────────────────────────────────────────────────────────────────────
 * Worklist 1 of 3 — "QuickBooks money → gifts".
 *
 * The main, QuickBooks-anchored queue: ONE card per QuickBooks money event,
 * tied across donor → gift → (optional) pledge/opportunity, with Stripe
 * per-charge detail attached as evidence when present. Needs-review / Ready /
 * Reconciled are sub-filters WITHIN this worklist.
 * ──────────────────────────────────────────────────────────────────────── */

const PAGE_SIZE = 50;

type SubFilter = "todo" | "ready" | "reconciled";

const SUB_FILTERS: { key: SubFilter; label: string }[] = [
  { key: "todo", label: "Needs review" },
  { key: "ready", label: "Ready" },
  { key: "reconciled", label: "Reconciled" },
];

export function QbMoneyWorklist() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [sub, setSub] = useState<SubFilter>("todo");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Track in-flight approvals per card so concurrent actions each disable only
  // their own card.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const debouncedSearch = useDebounce(search.trim());

  // Reset paging whenever the sub-filter or the search changes.
  useEffect(() => {
    setPage(0);
    setExpandedId(null);
  }, [sub, debouncedSearch]);

  const params = useMemo<ListReconciliationCardsParams>(() => {
    const base: ListReconciliationCardsParams = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (debouncedSearch) base.q = debouncedSearch;
    if (sub === "ready") base.ready = true;
    else if (sub === "reconciled") base.queue = "reconciled";
    return base;
  }, [sub, debouncedSearch, page]);

  const { data, isLoading, isError } = useListReconciliationCards(params);

  function refresh() {
    // Covers both the card list (["/api/reconciliation/cards", params]) AND every
    // already-expanded card's graph (["/api/reconciliation/cards/{id}/graph"]),
    // whose distinct per-id key the plain list prefix would miss — so newly
    // proposed Stripe evidence shows on an open card without a manual reload.
    void queryClient.invalidateQueries({
      predicate: (query) =>
        typeof query.queryKey[0] === "string" &&
        query.queryKey[0].startsWith("/api/reconciliation/cards"),
    });
    // Approving mints/links a gift and reconciles staged evidence.
    void queryClient.invalidateQueries({ queryKey: ["/api/gifts-and-payments"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/staged-payments"] });
  }

  const approve = useApproveReconciliationCard({
    mutation: {
      onSuccess: () => {
        toast({ title: "Card reconciled." });
        refresh();
      },
      onError: (err: unknown) => {
        toast({
          variant: "destructive",
          title: "Couldn't approve this card",
          description:
            err instanceof Error
              ? err.message
              : "It may already have changed state — refresh and try again.",
        });
      },
    },
  });

  async function handleApprove(
    stagedPaymentId: string,
    body: ApproveCompleteMatchBody,
  ) {
    setPendingIds((prev) => new Set(prev).add(stagedPaymentId));
    try {
      await approve.mutateAsync({ stagedPaymentId, data: body });
      setExpandedId((cur) => (cur === stagedPaymentId ? null : cur));
    } catch {
      // The mutation's onError already surfaces a toast; swallow here so the
      // fire-and-forget caller in the card doesn't trigger an unhandled rejection.
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(stagedPaymentId);
        return next;
      });
    }
  }

  const cards = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const showingFrom = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const showingTo = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {SUB_FILTERS.map((t) => (
            <Button
              key={t.key}
              variant={sub === t.key ? "default" : "outline"}
              size="sm"
              onClick={() => setSub(t.key)}
              data-testid={`tab-${t.key}`}
            >
              {t.label}
            </Button>
          ))}
        </div>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search payer, reference, memo…"
          className="h-9 w-full sm:w-72"
          data-testid="reconciliation-search"
        />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading cards…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          Couldn't load reconciliation cards.
        </p>
      ) : cards.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {sub === "reconciled"
              ? "No reconciled cards yet."
              : "Nothing to reconcile here."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {cards.map((card) => (
            <ReconciliationCard
              key={card.stagedPaymentId}
              card={card}
              expanded={expandedId === card.stagedPaymentId}
              onToggle={() =>
                setExpandedId((cur) =>
                  cur === card.stagedPaymentId ? null : card.stagedPaymentId,
                )
              }
              busy={pendingIds.has(card.stagedPaymentId)}
              onApprove={(body) => handleApprove(card.stagedPaymentId, body)}
            />
          ))}
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
              data-testid="prev-page"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={showingTo >= total}
              onClick={() => setPage((p) => p + 1)}
              data-testid="next-page"
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
