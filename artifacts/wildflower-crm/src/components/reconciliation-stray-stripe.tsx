import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListStripePayoutReconciliations,
  useProposeHistoricalStripeReconciliation,
  useSearchReconciliationQbStaged,
  getSearchReconciliationQbStagedQueryKey,
  type StripePayoutReconciliation,
  type SearchReconciliationQbStagedParams,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useDebounce } from "@/hooks/use-debounce";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { formatCurrency, formatDate } from "@/lib/format";

/* ────────────────────────────────────────────────────────────────────────
 * Worklist 2 of 3 — "Stripe with no QuickBooks record".
 *
 * Stripe payouts that never matched a QuickBooks deposit. QuickBooks stays
 * REQUIRED to book a gift, so this list is surface-and-investigate ONLY: it
 * shows the orphaned payouts and gives a QuickBooks search box up top to hunt
 * the deposit they belong to. Admins can also re-run the automated
 * Stripe → QuickBooks matching pass (proposals only).
 * ──────────────────────────────────────────────────────────────────────── */

function parseAmount(raw: string): string | undefined {
  const n = Number.parseFloat(raw.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? String(n) : undefined;
}

export function StrayStripeWorklist() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isAdmin = useIsAdmin();

  const { data, isLoading, isError } = useListStripePayoutReconciliations({
    queue: "unmatched",
    limit: 100,
  });

  function refresh() {
    void queryClient.invalidateQueries({
      queryKey: ["/api/stripe-payouts/reconciliation"],
    });
  }

  // One-time admin "stitch": match every Stripe payout to its QuickBooks
  // deposit. Proposals only — nothing is minted or archived; the human confirms
  // each card afterward in the "QuickBooks money → gifts" worklist.
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
          description: err instanceof Error ? err.message : "Please try again.",
        });
      },
    },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination?.total ?? rows.length;

  return (
    <div className="space-y-4">
      <QbSearchBox />

      {isAdmin ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            Re-run the automated pass to match every Stripe payout to its
            QuickBooks deposit. Proposals only — confirm each in the “QuickBooks
            money → gifts” worklist.
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

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Unmatched Stripe payouts</h3>
        <span className="text-xs text-muted-foreground">
          {total} payout{total === 1 ? "" : "s"}
        </span>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading payouts…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">Couldn't load Stripe payouts.</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No unmatched Stripe payouts — every payout maps to a QuickBooks
            deposit.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <UnmatchedPayoutCard key={r.id} recon={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-sm tabular-nums">{value}</div>
    </div>
  );
}

function UnmatchedPayoutCard({ recon }: { recon: StripePayoutReconciliation }) {
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-mono text-sm">{recon.id}</div>
            <div className="text-xs text-muted-foreground">
              Arrived {formatDate(recon.arrivalDate)} · {recon.chargeCount ?? 0}{" "}
              charge{recon.chargeCount === 1 ? "" : "s"}
            </div>
          </div>
          <Badge variant="outline">No QuickBooks deposit</Badge>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Payout amount" value={formatCurrency(recon.amount)} />
          <Stat label="Gross charges" value={formatCurrency(recon.grossTotal)} />
          <Stat label="Processor fees" value={formatCurrency(recon.feeTotal)} />
          <Stat label="Net settled" value={formatCurrency(recon.netTotal)} />
        </div>
        <div>
          <Link
            href="/reconciliation-workbench?queue=bundle"
            className="text-xs font-medium underline-offset-2 hover:underline"
          >
            View the charges behind this payout →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

/* QuickBooks staged-payment search — investigate-only. Lets the fundraiser hunt
 * the QuickBooks deposit a stray Stripe payout belongs to. Searches by free text
 * and/or amount within a ± day window; results are read-only (booking a gift
 * still happens in the "QuickBooks money → gifts" worklist). */
function QbSearchBox() {
  const [q, setQ] = useState("");
  const [amount, setAmount] = useState("");

  const debouncedQ = useDebounce(q.trim());
  const debouncedAmount = useDebounce(amount.trim());

  const parsedAmount = parseAmount(debouncedAmount);
  const enabled = debouncedQ.length >= 2 || parsedAmount !== undefined;

  const params = useMemo<SearchReconciliationQbStagedParams>(() => {
    const p: SearchReconciliationQbStagedParams = { limit: 25 };
    if (debouncedQ.length >= 2) p.q = debouncedQ;
    if (parsedAmount !== undefined) {
      p.amount = parsedAmount;
      p.days = 30;
    }
    return p;
  }, [debouncedQ, parsedAmount]);

  const { data, isLoading, isError } = useSearchReconciliationQbStaged(params, {
    query: {
      enabled,
      queryKey: getSearchReconciliationQbStagedQueryKey(params),
    },
  });

  const results = data?.data ?? [];

  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex flex-col gap-1">
        <h3 className="text-sm font-medium">Find the QuickBooks deposit</h3>
        <p className="text-xs text-muted-foreground">
          Search QuickBooks money events by payer/reference or amount to confirm
          whether a stray Stripe payout has a matching deposit. Read-only — book
          the gift from the “QuickBooks money → gifts” worklist.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Payer, reference, memo…"
          className="h-9 w-full sm:w-64"
          data-testid="qb-search-q"
        />
        <Input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount (e.g. 250.00)"
          inputMode="decimal"
          className="h-9 w-full sm:w-44"
          data-testid="qb-search-amount"
        />
      </div>

      {!enabled ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Enter at least 2 characters or an amount to search.
        </p>
      ) : isLoading ? (
        <p className="mt-3 text-xs text-muted-foreground">Searching…</p>
      ) : isError ? (
        <p className="mt-3 text-xs text-destructive">
          Couldn't search QuickBooks records.
        </p>
      ) : results.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No matching QuickBooks money events.
        </p>
      ) : (
        <ul className="mt-3 divide-y rounded-md border">
          {results.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm"
              data-testid={`qb-search-result-${c.id}`}
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{c.label}</div>
                {c.sublabel ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {c.sublabel}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-3 tabular-nums">
                <span>{formatCurrency(c.amount)}</span>
                <span className="text-xs text-muted-foreground">
                  {formatDate(c.date)}
                </span>
                {c.alreadyLinkedStagedPaymentId ? (
                  <Badge variant="secondary" className="text-xs">
                    Already linked
                  </Badge>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
