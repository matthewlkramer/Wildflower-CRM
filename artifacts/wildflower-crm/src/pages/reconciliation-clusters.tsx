import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useListWorkbenchClusters,
  type WorkbenchCluster,
  type WorkbenchClusterCharge,
  type WorkbenchClusterGift,
  type WorkbenchClusterQbRecord,
  type WorkbenchClusterStatus,
  type WorkbenchLens,
  type WorkbenchRecordStatus,
} from "@workspace/api-client-react";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft,
  Banknote,
  ChevronLeft,
  ChevronRight,
  Gift as GiftIcon,
  Landmark,
  Search,
} from "lucide-react";

// ─── Read-only reconciliation cluster workbench (Phase 1) ────────────────────
// One unified list: every piece of money work is ONE row (cluster) carrying all
// three facets — CRM gifts, transaction evidence, bank & accounting records —
// plus the money math and a server-derived status. No actions are wired yet;
// this page exists alongside the queue-based workbench so the team can validate
// the cluster partition against real data before actions move over.

const PAGE_SIZE = 25;

const LENSES: { id: WorkbenchLens; label: string }[] = [
  { id: "all_open", label: "All open" },
  { id: "needs_donor_or_gift", label: "Needs donor / gift" },
  { id: "needs_accounting", label: "Needs accounting" },
  { id: "conflicts", label: "Conflicts" },
  { id: "refunds", label: "Refunds" },
  { id: "excluded", label: "Excluded" },
  { id: "completed", label: "Completed" },
];

const KIND_LABEL: Record<WorkbenchCluster["kind"], string> = {
  stripe_payout: "Stripe payout",
  qb_standalone: "QuickBooks",
  crm_only: "CRM only",
};

const STATUS_META: Record<
  WorkbenchClusterStatus,
  { label: string; className: string }
> = {
  complete: {
    label: "Complete",
    className:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  partial: {
    label: "Partial",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  },
  unresolved: {
    label: "Unresolved",
    className:
      "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  },
  conflict: {
    label: "Conflict",
    className: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  },
  refund: {
    label: "Refund",
    className: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  },
  excluded: {
    label: "Excluded",
    className:
      "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  },
  unlinked: {
    label: "Unlinked",
    className:
      "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  },
};

const RECORD_STATUS_LABEL: Record<WorkbenchRecordStatus, string> = {
  pending: "Pending",
  match_proposed: "Proposed",
  match_confirmed: "Confirmed",
  excluded: "Excluded",
};

const QB_ROLE_LABEL: Record<WorkbenchClusterQbRecord["role"], string> = {
  anchor: "QB record",
  deposit: "Deposit",
  fee: "Processor fee",
  charge_tie: "Charge tie",
  group_member: "Group member",
};

function donorHref(gift: WorkbenchClusterGift): string | null {
  if (!gift.donorId || !gift.donorKind) return null;
  switch (gift.donorKind) {
    case "organization":
      return `/organizations/${gift.donorId}`;
    case "person":
      return `/individuals/${gift.donorId}`;
    case "household":
      return `/households/${gift.donorId}`;
    default:
      return null;
  }
}

function recordStatusBadge(status: WorkbenchRecordStatus) {
  return (
    <Badge
      variant={status === "match_confirmed" ? "default" : "outline"}
      className="shrink-0 text-[10px] px-1.5 py-0"
    >
      {RECORD_STATUS_LABEL[status]}
    </Badge>
  );
}

function GiftFacet({ gifts }: { gifts: WorkbenchClusterGift[] }) {
  if (gifts.length === 0) {
    return <p className="text-xs text-muted-foreground italic">No CRM gift yet</p>;
  }
  return (
    <ul className="space-y-1.5">
      {gifts.map((g) => {
        const donor = donorHref(g);
        return (
          <li key={g.giftId} className="text-xs leading-snug">
            <div className="flex flex-wrap items-center gap-1.5">
              <Link
                href={`/gifts/${g.giftId}`}
                className="font-medium text-primary underline-offset-2 hover:underline break-words"
                data-testid={`link-cluster-gift-${g.giftId}`}
              >
                {g.name ?? "(unnamed gift)"}
              </Link>
              {g.donorbox ? (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  Donorbox
                </Badge>
              ) : null}
              {g.quickbooksTie && g.quickbooksTie !== "exempt" ? (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  QB {g.quickbooksTie.replace(/_/g, " ")}
                </Badge>
              ) : null}
            </div>
            <div className="text-muted-foreground">
              {donor ? (
                <Link
                  href={donor}
                  className="underline-offset-2 hover:underline"
                >
                  {g.donorName ?? "(no donor)"}
                </Link>
              ) : (
                (g.donorName ?? "(no donor)")
              )}
              {" · "}
              {g.amount != null ? formatCurrency(g.amount) : "—"}
              {g.dateReceived ? ` · ${formatDateShort(g.dateReceived)}` : ""}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ChargeFacet({
  charges,
  chargeCount,
}: {
  charges: WorkbenchClusterCharge[];
  chargeCount: number | null | undefined;
}) {
  if (charges.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        No processor transactions
      </p>
    );
  }
  const hiddenCount = (chargeCount ?? charges.length) - charges.length;
  return (
    <ul className="space-y-1.5">
      {charges.map((c) => (
        <li key={c.chargeId} className="text-xs leading-snug">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium break-words">
              {c.payerName ?? c.chargeId}
            </span>
            {recordStatusBadge(c.status)}
            {c.refundProposed ? (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 border-red-300 text-red-700 dark:text-red-300"
              >
                {c.refundKind === "chargeback" ? "Chargeback" : "Refund"} proposed
              </Badge>
            ) : null}
          </div>
          <div className="text-muted-foreground">
            {c.amount != null ? formatCurrency(c.amount) : "—"}
            {c.feeAmount != null ? ` − ${formatCurrency(c.feeAmount)} fee` : ""}
            {c.netAmount != null ? ` = ${formatCurrency(c.netAmount)}` : ""}
            {c.chargeDate ? ` · ${formatDateShort(c.chargeDate)}` : ""}
          </div>
        </li>
      ))}
      {hiddenCount > 0 ? (
        <li className="text-xs text-muted-foreground italic">
          … and {hiddenCount.toLocaleString()} more charge
          {hiddenCount === 1 ? "" : "s"}
        </li>
      ) : null}
    </ul>
  );
}

function QbFacet({ records }: { records: WorkbenchClusterQbRecord[] }) {
  if (records.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        No bank / accounting record
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {records.map((r) => (
        <li key={`${r.role}-${r.stagedPaymentId}`} className="text-xs leading-snug">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {QB_ROLE_LABEL[r.role]}
            </Badge>
            <span className="font-medium break-words">
              {r.reference ?? r.lineDescription ?? r.memo ?? r.stagedPaymentId}
            </span>
            {recordStatusBadge(r.status)}
          </div>
          <div className="text-muted-foreground">
            {r.amount != null ? formatCurrency(r.amount) : "—"}
            {r.dateReceived ? ` · ${formatDateShort(r.dateReceived)}` : ""}
          </div>
        </li>
      ))}
    </ul>
  );
}

function MoneyLine({ cluster }: { cluster: WorkbenchCluster }) {
  const parts: string[] = [];
  if (cluster.grossTotal != null && cluster.feeTotal != null) {
    parts.push(
      `${formatCurrency(cluster.grossTotal)} − ${formatCurrency(cluster.feeTotal)} fees`,
    );
  }
  if (cluster.netTotal != null) {
    parts.push(
      `${parts.length > 0 ? "= " : ""}${formatCurrency(cluster.netTotal)} net`,
    );
  }
  if (cluster.bankAmount != null) {
    parts.push(`${formatCurrency(cluster.bankAmount)} at bank`);
  }
  if (parts.length === 0) return null;
  const gap = cluster.gapAmount != null ? Number(cluster.gapAmount) : null;
  return (
    <p className="text-xs text-muted-foreground">
      {parts.join(" · ")}
      {gap != null && gap !== 0 ? (
        <span className="ml-1.5 font-medium text-amber-700 dark:text-amber-400">
          gap {formatCurrency(cluster.gapAmount!)}
        </span>
      ) : null}
    </p>
  );
}

function ClusterRow({ cluster }: { cluster: WorkbenchCluster }) {
  const status = STATUS_META[cluster.status];
  return (
    <div
      className="rounded-lg border p-4 space-y-3"
      data-testid={`cluster-row-${cluster.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="shrink-0">
              {KIND_LABEL[cluster.kind]}
            </Badge>
            <span className="font-medium break-words">
              {cluster.title ?? cluster.anchorId}
            </span>
            {cluster.group ? (
              <Badge variant="outline" className="shrink-0">
                Group of {cluster.group.memberCount}
                {cluster.group.totalAmount != null
                  ? ` · ${formatCurrency(cluster.group.totalAmount)}`
                  : ""}
              </Badge>
            ) : null}
            {cluster.settlement ? (
              <Badge variant="outline" className="shrink-0">
                Deposit {cluster.settlement.lifecycle}
              </Badge>
            ) : null}
            <span className="text-xs text-muted-foreground shrink-0">
              {cluster.date ? formatDateShort(cluster.date) : ""}
            </span>
          </div>
          <MoneyLine cluster={cluster} />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge className={`${status.className} border-transparent`}>
            {status.label}
          </Badge>
          {cluster.statusDetail ? (
            <span className="text-xs text-muted-foreground text-right">
              {cluster.statusDetail}
            </span>
          ) : cluster.resolvedCount != null && cluster.totalCount != null ? (
            <span className="text-xs text-muted-foreground">
              {cluster.resolvedCount} of {cluster.totalCount} linked
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 border-t pt-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <GiftIcon className="h-3 w-3" /> CRM gifts
          </p>
          <GiftFacet gifts={cluster.gifts} />
        </div>
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Banknote className="h-3 w-3" /> Transactions
          </p>
          <ChargeFacet charges={cluster.charges} chargeCount={cluster.chargeCount} />
        </div>
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Landmark className="h-3 w-3" /> Bank &amp; accounting
          </p>
          <QbFacet records={cluster.qbRecords} />
        </div>
      </div>
    </div>
  );
}

export default function ReconciliationClustersPage() {
  const [lens, setLens] = useState<WorkbenchLens>("all_open");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  // Debounce free-text search so we don't refetch per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const params = useMemo(
    () => ({
      lens,
      ...(q ? { q } : {}),
      limit: PAGE_SIZE,
      page,
    }),
    [lens, q, page],
  );

  const { data, isLoading, isError } = useListWorkbenchClusters(params);

  const clusters = data?.data ?? [];
  const counts = data?.lensCounts;
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            Reconciliation Clusters
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Every piece of money work as one row — the CRM gift, the processor
            transactions, and the bank &amp; accounting records it reconciles
            against, with the money math in between. Read-only preview: to act
            on anything, use the{" "}
            <Link
              href="/reconciliation-workbench"
              className="text-primary underline-offset-2 hover:underline"
            >
              Reconciliation Workbench
            </Link>
            .
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/reconciliation-workbench" data-testid="link-back-to-workbench">
            <ArrowLeft className="mr-1 h-4 w-4" /> Workbench
          </Link>
        </Button>
      </div>

      {/* Lens rail */}
      <div className="flex flex-wrap gap-1.5" data-testid="cluster-lens-rail">
        {LENSES.map((l) => {
          const active = l.id === lens;
          const count = counts?.[l.id];
          return (
            <Button
              key={l.id}
              variant={active ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setLens(l.id);
                setPage(1);
              }}
              data-testid={`button-lens-${l.id}`}
            >
              {l.label}
              {count != null ? (
                <span
                  className={`ml-1.5 rounded-full px-1.5 text-xs tabular-nums ${
                    active
                      ? "bg-primary-foreground/20"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {count.toLocaleString()}
                </span>
              ) : null}
            </Button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search payer, donor, gift, memo, reference…"
            className="pl-8"
            data-testid="input-cluster-search"
          />
        </div>
        {!isLoading && !isError ? (
          <span className="ml-auto text-sm text-muted-foreground" data-testid="text-cluster-total">
            {total.toLocaleString()} {total === 1 ? "cluster" : "clusters"}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Loading clusters…
        </p>
      ) : isError ? (
        <p className="text-sm text-destructive py-8 text-center">
          Failed to load the cluster list.
        </p>
      ) : clusters.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          {q
            ? "No clusters match this search."
            : "Nothing in this lens right now."}
        </p>
      ) : (
        <div className="space-y-3">
          {clusters.map((c) => (
            <ClusterRow key={c.id} cluster={c} />
          ))}
        </div>
      )}

      {totalPages > 1 ? (
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            data-testid="button-cluster-prev-page"
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </Button>
          <span className="text-sm text-muted-foreground tabular-nums">
            Page {page} of {totalPages.toLocaleString()}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            data-testid="button-cluster-next-page"
          >
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
