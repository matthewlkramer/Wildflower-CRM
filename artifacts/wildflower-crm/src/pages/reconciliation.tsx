import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListReconciliationCards,
  useApproveReconciliationCard,
  useProposeHistoricalStripeReconciliation,
  type ListReconciliationCardsParams,
  type ApproveCompleteMatchBody,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ReconciliationCard } from "@/components/reconciliation-card";
import { useIsAdmin } from "@/hooks/use-is-admin";

/* ────────────────────────────────────────────────────────────────────────
 * Unified "complete-match" reconciler.
 *
 * ONE card per money event, anchored on a QuickBooks staged-payment row (QB is
 * required for every complete match). Each card closes a graph across donor +
 * gift + opportunity, with Stripe per-charge detail attached as evidence when
 * present. The server auto-proposes where the evidence cross-validates; the
 * human resolves any ambiguity via the per-node typeaheads and approves. All
 * invariants are enforced server-side — the UI locks are never trusted.
 *
 * Built alongside the existing /staged-payments + /stripe-reconciliation pages;
 * those stay until this reaches parity.
 * ──────────────────────────────────────────────────────────────────────── */

const PAGE_SIZE = 50;

type TabKey = "todo" | "ready" | "reconciled";

const TABS: { key: TabKey; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "ready", label: "Ready" },
  { key: "reconciled", label: "Reconciled" },
];

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function Reconciliation() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isAdmin = useIsAdmin();

  const [tab, setTab] = useState<TabKey>("todo");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Track in-flight approvals per card so concurrent actions each disable only
  // their own card.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const debouncedSearch = useDebounced(search.trim());

  // Reset paging whenever the tab or the search changes.
  useEffect(() => {
    setPage(0);
    setExpandedId(null);
  }, [tab, debouncedSearch]);

  const params = useMemo<ListReconciliationCardsParams>(() => {
    const base: ListReconciliationCardsParams = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (debouncedSearch) base.q = debouncedSearch;
    if (tab === "ready") base.ready = true;
    else if (tab === "reconciled") base.queue = "reconciled";
    return base;
  }, [tab, debouncedSearch, page]);

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

  // One-time admin "stitch": match every Stripe payout to its QuickBooks deposit
  // so the Stripe evidence panel appears on each backed card. Proposals only —
  // nothing is minted or archived; the human confirms each card afterward.
  const proposeHistorical = useProposeHistoricalStripeReconciliation({
    mutation: {
      onSuccess: (res) => {
        toast({
          title: res.ran
            ? "Stripe → QuickBooks matching complete"
            : "Skipped — a sync is already running",
          description: res.ran
            ? `${res.proposalsCreated} proposed · ${res.conflictsFound} conflicts · ${res.unmatched} still unmatched · ${res.alreadyResolved} already done`
            : "A Stripe sync/rematch is holding the lock — try again in a moment.",
        });
        refresh();
      },
      onError: (err: unknown) => {
        toast({
          variant: "destructive",
          title: "Couldn't run the matching pass",
          description:
            err instanceof Error ? err.message : "Please try again.",
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
    <div className="space-y-4 p-4 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Reconciliation</CardTitle>
          <CardDescription>
            One card per QuickBooks money event. Match each to a donor and gift —
            attach an opportunity to mint a gift or latch a pledge. Stripe gross
            wins when a charge backs the money.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1">
              {TABS.map((t) => (
                <Button
                  key={t.key}
                  variant={tab === t.key ? "default" : "outline"}
                  size="sm"
                  onClick={() => setTab(t.key)}
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
          {isAdmin ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-2">
              <p className="text-xs text-muted-foreground">
                Stripe missing on a card? Run a one-time pass to match every Stripe
                payout to its QuickBooks deposit. Proposals only — you confirm each
                card afterward.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={proposeHistorical.isPending}
                onClick={() => proposeHistorical.mutate()}
                data-testid="propose-historical-stripe"
              >
                {proposeHistorical.isPending
                  ? "Matching…"
                  : "Match Stripe payouts to QuickBooks"}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading cards…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">Couldn't load reconciliation cards.</p>
      ) : cards.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {tab === "reconciled"
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
