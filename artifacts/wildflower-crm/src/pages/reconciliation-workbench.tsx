import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListReconciliationCards,
  getListReconciliationCardsQueryKey,
  useGetReconciliationLineage,
  getGetReconciliationLineageQueryKey,
  useListStripePayoutReconciliations,
  useConfirmStripePayoutExclude,
  useConfirmStripePayoutKeep,
  useRevertStripePayoutReconciliation,
  useCreateGiftFromStripeStagedCharge,
  useConfirmStripeRefundPropagation,
  useConfirmBundleCrossProcessorTies,
  useResolveStagedPayment,
  useCreateGiftFromStagedPayment,
  useExcludeStagedPayment,
  useReIncludeStagedPayment,
  useSetStagedPaymentNeedsResearch,
  useSetStagedPaymentSyncGap,
  useGroupStagedPayments,
  getGetReconciliationGraphQueryOptions,
  approveReconciliationCard,
  rejectStagedPayment,
  searchReconciliationNode,
  splitStagedPayment,
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  getGetGiftOrPaymentQueryOptions,
  type ReconciliationCard,
  type ReconciliationCandidate,
  type ApproveCompleteMatchBody,
  type SplitStagedPaymentBody,
  type StagedPaymentExclusionReason,
  type GiftOrPayment,
  type GiftOrPaymentDetail,
  type StripePayoutReconciliation,
} from "@workspace/api-client-react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  GitMerge,
  Layers,
  Loader2,
  Plus,
  Scissors,
  Search,
  Sparkles,
  Split,
  Trash2,
  Undo2,
  Wallet,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  laneBadges,
  deriveCardStatus,
  extractGateIssues,
  deriveApproveBodyFromProposal,
  EXCLUSION_REASON_LABELS,
  MANUAL_EXCLUSION_FAMILIES,
} from "@/lib/reconciliation";
import { ReconciliationNodeTypeahead } from "@/components/reconciliation-node-typeahead";
import { StrayGiftsWorklist } from "@/components/reconciliation-stray-gifts";
import {
  MergeGiftsDialog,
  MergeIntoPledgeDialog,
  SplitGiftIntoPledgeDialog,
} from "@/components/gift-merge-dialogs";
import { DonorFieldPicker, type DonorType } from "@/components/entity-picker";
import FinancialCorrectionsPage from "@/pages/financial-corrections";

// ─── Shell config (mockup structure, corrected to our money model) ──────────

type QueueId =
  | "review"
  | "qbo"
  | "crm"
  | "split"
  | "bundle"
  | "sync"
  | "research"
  | "confirmed"
  | "excluded";

type AxisId = "all" | "qg" | "qs" | "qd" | "ds";

const QUEUES: { id: QueueId; name: string; dot: string; live: boolean }[] = [
  { id: "review", name: "Needs review", dot: "#9a6b00", live: true },
  { id: "qbo", name: "QBO-only", dot: "#b23b2e", live: true },
  { id: "crm", name: "CRM-only", dot: "#b23b2e", live: true },
  { id: "split", name: "Splits & pledges", dot: "#6c4ea3", live: true },
  { id: "bundle", name: "Stripe/Donorbox bundles", dot: "#1a7a8c", live: true },
  { id: "sync", name: "Sync gaps", dot: "#b8601c", live: true },
  { id: "research", name: "Research", dot: "#857b73", live: true },
  { id: "confirmed", name: "Confirmed", dot: "#2f7d57", live: false },
  { id: "excluded", name: "Excluded", dot: "#6c4ea3", live: true },
];

const AXES: { id: AxisId; label: string }[] = [
  { id: "all", label: "All sources" },
  { id: "qg", label: "QuickBooks ⇄ Gift" },
  { id: "qs", label: "QuickBooks ⇄ Stripe" },
  { id: "qd", label: "QuickBooks ⇄ Donorbox" },
  { id: "ds", label: "Donorbox ⇄ Stripe" },
];

// ─── Money helpers ──────────────────────────────────────────────────────────

function num(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(v: string | null | undefined): string {
  const n = num(v);
  if (n == null) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type Confidence = "high" | "med" | "weak";

/**
 * Card confidence for the chip + bulk-approve gate. `ready` (auto-proposal
 * satisfies the consistency gate) is the only thing the server promises is
 * one-click approvable — that and only that is "high" and bulk-approvable.
 */
function confidenceOf(card: ReconciliationCard): Confidence {
  if (card.ready) return "high";
  if (card.proposedGiftId && card.giftState === "determined") return "med";
  return "weak";
}

const CONFIDENCE_META: Record<
  Confidence,
  { label: string; className: string }
> = {
  high: {
    label: "High confidence",
    className: "bg-emerald-100 text-emerald-800 border-emerald-200",
  },
  med: {
    label: "Medium",
    className: "bg-amber-100 text-amber-800 border-amber-200",
  },
  weak: {
    label: "Weak",
    className: "bg-rose-100 text-rose-800 border-rose-200",
  },
};

/**
 * Which source-axis a needs-review card belongs to. The working slice is
 * QuickBooks⇄Gift; cards backed by Stripe evidence are the QuickBooks⇄Stripe
 * axis. Donorbox axes have no needs-review surface yet (next task), so those
 * filters intentionally show empty.
 */
function axisOf(card: ReconciliationCard): AxisId {
  return card.hasStripeEvidence ? "qs" : "qg";
}

// Supplemental chips for the badge row. The amount-delta and donor chips were
// removed — the amount now lives on each side of the card and the donor name is
// shown in the CRM-gift lane + the Status line — so only the Stripe-payout
// provenance chip remains here.
function evidenceBullets(card: ReconciliationCard): string[] {
  const out: string[] = [];
  if (card.hasStripeEvidence && card.stripePayoutId) {
    out.push(
      `Stripe payout ${card.stripePayoutId}${card.stripeChargeCount ? ` · ${card.stripeChargeCount} charges` : ""}`,
    );
  }
  return out;
}

// ─── Pending tray model ─────────────────────────────────────────────────────

type StagedKind = "confirm" | "retarget" | "reject" | "split";

interface StagedChange {
  key: string;
  kind: StagedKind;
  stagedPaymentId: string;
  label: string;
  detail: string;
  /** Approve body for confirm / retarget; null for reject / split. */
  body: ApproveCompleteMatchBody | null;
  /** Split body for kind === "split"; null otherwise. */
  splitBody?: SplitStagedPaymentBody | null;
  /** Set after a failed Apply so the row stays staged with a reason. */
  failure?: string | null;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ReconciliationWorkbench() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Old reconciliation routes redirect here with `?queue=<id>` so the matching
  // queue is preselected. Read once on mount; the rail drives state thereafter.
  const urlSearch = useSearch();
  const [queue, setQueue] = useState<QueueId>(() => {
    const requested = new URLSearchParams(urlSearch).get("queue");
    return QUEUES.some((q) => q.id === requested)
      ? (requested as QueueId)
      : "review";
  });
  const [axis, setAxis] = useState<AxisId>("all");
  const [search, setSearch] = useState("");
  const [staged, setStaged] = useState<StagedChange[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  // The card whose Approve is applying right now (one-click apply, no tray hop).
  const [applyingCardId, setApplyingCardId] = useState<string | null>(null);
  const [retargetCard, setRetargetCard] = useState<ReconciliationCard | null>(
    null,
  );
  const [donorCard, setDonorCard] = useState<ReconciliationCard | null>(null);
  const [splitCard, setSplitCard] = useState<ReconciliationCard | null>(null);
  const [excludeCard, setExcludeCard] = useState<ReconciliationCard | null>(
    null,
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Needs-review queue = the active work queue (omit `queue` param). Loaded
  // once and split client-side into Sync gaps / Research / Needs review /
  // QBO-only buckets (see `buckets` below).
  const cardsQuery = useListReconciliationCards({ limit: 200, offset: 0 });
  // Excluded queue — fetched on its own, only while that tab is open.
  const excludedParams = { queue: "excluded", limit: 200, offset: 0 } as const;
  const excludedQuery = useListReconciliationCards(excludedParams, {
    query: {
      enabled: queue === "excluded",
      queryKey: getListReconciliationCardsQueryKey(excludedParams),
    },
  });

  const allCards = useMemo(
    () => cardsQuery.data?.data ?? [],
    [cardsQuery.data],
  );

  const matchSearch = useCallback(
    (c: ReconciliationCard) => {
      const q = search.trim().toLowerCase();
      if (axis !== "all" && axisOf(c) !== axis) return false;
      if (!q) return true;
      const hay = [
        c.payerName,
        c.proposedGiftName,
        c.resolvedGiftName,
        c.proposedDonorName,
        c.qbDocNumber,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    },
    [axis, search],
  );

  const filtered = useMemo(
    () => allCards.filter(matchSearch),
    [allCards, matchSearch],
  );

  // Bucket the loaded needs_review cards by precedence:
  // Sync gaps > Research > Needs review (has a candidate) > QBO-only.
  const buckets = useMemo(() => {
    const sync: ReconciliationCard[] = [];
    const research: ReconciliationCard[] = [];
    const review: ReconciliationCard[] = [];
    const qbo: ReconciliationCard[] = [];
    for (const c of filtered) {
      // Cards whose gift link is already settled ("Link to gift confirmed")
      // drop out of the review surface — they belong in the Confirmed queue, not
      // Needs review. Partial/multiple (amounts still diverge) stay visible.
      if (deriveCardStatus(c).key === "confirmed") continue;
      if (c.syncGap) sync.push(c);
      else if (c.needsResearch) research.push(c);
      else if (c.proposedGiftId || c.proposedDonorId || c.resolvedGiftId)
        review.push(c);
      else qbo.push(c);
    }
    return { sync, research, review, qbo };
  }, [filtered]);

  const excludedCards = useMemo(
    () => (excludedQuery.data?.data ?? []).filter(matchSearch),
    [excludedQuery.data, matchSearch],
  );

  const readyCount = useMemo(
    () => buckets.review.filter((c) => c.ready).length,
    [buckets.review],
  );

  const stagedIds = useMemo(
    () => new Set(staged.map((s) => s.stagedPaymentId)),
    [staged],
  );

  const stage = useCallback((change: StagedChange) => {
    setStaged((prev) => {
      const rest = prev.filter(
        (s) => s.stagedPaymentId !== change.stagedPaymentId,
      );
      return [...rest, change];
    });
  }, []);

  const unstage = useCallback((stagedPaymentId: string) => {
    setStaged((prev) =>
      prev.filter((s) => s.stagedPaymentId !== stagedPaymentId),
    );
  }, []);

  /** Stage a split-across-gifts (+ optional remainder) change into the tray. */
  const stageSplit = useCallback(
    (card: ReconciliationCard, splitBody: SplitStagedPaymentBody, detail: string) => {
      stage({
        key: `split:${card.stagedPaymentId}`,
        kind: "split",
        stagedPaymentId: card.stagedPaymentId,
        label: card.payerName ?? "Staged payment",
        detail,
        body: null,
        splitBody,
      });
      setSplitCard(null);
      toast({
        title: "Split staged",
        description: "Review the tray, then Apply to CRM.",
      });
    },
    [stage, toast],
  );

  /** Fetch the card's graph and derive the auto-proposal approve body. */
  const deriveConfirmBody = useCallback(
    async (
      card: ReconciliationCard,
      giftOverride?: ReconciliationCandidate | null,
    ): Promise<{ body: ApproveCompleteMatchBody; summary: string } | string> => {
      try {
        const graph = await queryClient.fetchQuery(
          getGetReconciliationGraphQueryOptions(card.stagedPaymentId),
        );
        const derived = deriveApproveBodyFromProposal(graph, giftOverride);
        if (!derived.ok) return derived.reason;
        return { body: derived.body, summary: derived.summary };
      } catch {
        return "Couldn't load the match graph. Refresh and try again.";
      }
    },
    [queryClient],
  );

  const stageConfirm = useCallback(
    async (card: ReconciliationCard) => {
      setBusy(true);
      const res = await deriveConfirmBody(card);
      setBusy(false);
      if (typeof res === "string") {
        toast({ title: "Can't confirm yet", description: res });
        return;
      }
      stage({
        key: card.stagedPaymentId,
        kind: "confirm",
        stagedPaymentId: card.stagedPaymentId,
        label: card.payerName ?? "QuickBooks payment",
        detail: res.summary,
        body: res.body,
      });
    },
    [deriveConfirmBody, stage, toast],
  );

  const stageReject = useCallback(
    (card: ReconciliationCard) => {
      stage({
        key: card.stagedPaymentId,
        kind: "reject",
        stagedPaymentId: card.stagedPaymentId,
        label: card.payerName ?? "QuickBooks payment",
        detail: "Reject — remove from review queue",
        body: null,
      });
    },
    [stage],
  );

  const stageRetarget = useCallback(
    async (card: ReconciliationCard, gift: ReconciliationCandidate) => {
      setBusy(true);
      const res = await deriveConfirmBody(card, gift);
      setBusy(false);
      if (typeof res === "string") {
        toast({ title: "Can't re-target", description: res });
        return;
      }
      stage({
        key: card.stagedPaymentId,
        kind: "retarget",
        stagedPaymentId: card.stagedPaymentId,
        label: card.payerName ?? "QuickBooks payment",
        detail: `Re-target → ${gift.label}`,
        body: res.body,
      });
      setRetargetCard(null);
    },
    [deriveConfirmBody, stage, toast],
  );

  const approveAllHighConfidence = useCallback(async () => {
    const ready = buckets.review.filter(
      (c) => c.ready && !stagedIds.has(c.stagedPaymentId),
    );
    if (ready.length === 0) {
      toast({ title: "Nothing to approve", description: "No high-confidence cards." });
      return;
    }
    setBusy(true);
    let stagedOk = 0;
    let skipped = 0;
    for (const card of ready) {
      const res = await deriveConfirmBody(card);
      if (typeof res === "string") {
        skipped += 1;
        continue;
      }
      stage({
        key: card.stagedPaymentId,
        kind: "confirm",
        stagedPaymentId: card.stagedPaymentId,
        label: card.payerName ?? "QuickBooks payment",
        detail: res.summary,
        body: res.body,
      });
      stagedOk += 1;
    }
    setBusy(false);
    toast({
      title: `Staged ${stagedOk} high-confidence ${stagedOk === 1 ? "match" : "matches"}`,
      description:
        skipped > 0
          ? `${skipped} couldn't be staged (changed state) and were skipped.`
          : "Review the tray, then Apply to CRM.",
    });
  }, [buckets.review, stagedIds, deriveConfirmBody, stage, toast]);

  /** Apply each staged action individually through its existing guarded endpoint. */
  const applyToCrm = useCallback(async () => {
    if (staged.length === 0) return;
    setApplying(true);
    const remaining: StagedChange[] = [];
    let applied = 0;
    for (const change of staged) {
      try {
        if (change.kind === "reject") {
          await rejectStagedPayment(change.stagedPaymentId);
        } else if (change.kind === "split") {
          if (!change.splitBody) {
            remaining.push({ ...change, failure: "Missing split body." });
            continue;
          }
          await splitStagedPayment(change.stagedPaymentId, change.splitBody);
        } else if (change.body) {
          await approveReconciliationCard(change.stagedPaymentId, change.body);
        } else {
          remaining.push({ ...change, failure: "Missing action body." });
          continue;
        }
        applied += 1;
      } catch (err) {
        const issues = extractGateIssues(err);
        const reason =
          issues.length > 0
            ? issues.join(" · ")
            : err instanceof Error
              ? err.message
              : "Couldn't apply this change.";
        remaining.push({ ...change, failure: reason });
      }
    }
    setStaged(remaining);
    setApplying(false);
    void queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey?.[0];
        return (
          typeof key === "string" && key.startsWith("/api/reconciliation/cards")
        );
      },
    });
    void queryClient.invalidateQueries({
      queryKey: ["/api/staged-payments"],
    });
    void queryClient.invalidateQueries({
      queryKey: ["/api/gifts-and-payments"],
    });
    if (remaining.length === 0) {
      toast({ title: `Applied ${applied} ${applied === 1 ? "change" : "changes"} to the CRM.` });
    } else {
      toast({
        title: `Applied ${applied}; ${remaining.length} need attention`,
        description: "The failed changes stay in the tray with the reason.",
      });
    }
  }, [staged, queryClient, toast]);

  // ─── QBO-only / Research / Sync-gap / Excluded direct actions ─────────────
  // These buckets apply immediately through their existing guarded endpoints
  // (not the confirm/reject pending tray, which is review-bucket specific).

  const invalidateAll = useCallback(() => {
    void queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey?.[0];
        return (
          typeof key === "string" && key.startsWith("/api/reconciliation/cards")
        );
      },
    });
    void queryClient.invalidateQueries({ queryKey: ["/api/staged-payments"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/gifts-and-payments"] });
  }, [queryClient]);

  const errMessage = useCallback((err: unknown): string => {
    const issues = extractGateIssues(err);
    if (issues.length > 0) return issues.join(" · ");
    return err instanceof Error ? err.message : "Something went wrong.";
  }, []);

  const resolveM = useResolveStagedPayment();
  const createGiftM = useCreateGiftFromStagedPayment();
  const excludeM = useExcludeStagedPayment();
  const reIncludeM = useReIncludeStagedPayment();
  const syncGapM = useSetStagedPaymentSyncGap();
  const researchM = useSetStagedPaymentNeedsResearch();
  const groupM = useGroupStagedPayments();

  const actionBusy =
    resolveM.isPending ||
    createGiftM.isPending ||
    excludeM.isPending ||
    reIncludeM.isPending ||
    syncGapM.isPending ||
    researchM.isPending ||
    groupM.isPending;

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleCreateGift = useCallback(
    async (card: ReconciliationCard) => {
      try {
        await createGiftM.mutateAsync({ id: card.stagedPaymentId });
        invalidateAll();
        toast({ title: "Gift created from QuickBooks payment." });
      } catch (err) {
        toast({ title: "Couldn't create gift", description: errMessage(err) });
      }
    },
    [createGiftM, invalidateAll, toast, errMessage],
  );

  // One-click Approve: derive the auto-proposal (or re-targeted gift) body and
  // apply it to the CRM immediately, no staging-tray hop. Mirrors handleCreateGift
  // (invalidate + toast on success, gate issues surfaced via errMessage). The
  // bulk "Approve All High Confidence" path still stages into the tray.
  const confirmAndApply = useCallback(
    async (
      card: ReconciliationCard,
      giftOverride?: ReconciliationCandidate | null,
    ) => {
      setApplyingCardId(card.stagedPaymentId);
      try {
        const res = await deriveConfirmBody(card, giftOverride);
        if (typeof res === "string") {
          toast({ title: "Can't confirm yet", description: res });
          return;
        }
        await approveReconciliationCard(card.stagedPaymentId, res.body);
        invalidateAll();
        setRetargetCard(null);
        toast({
          title: "Approved",
          description: "Applied to the CRM.",
        });
      } catch (err) {
        toast({ title: "Couldn't approve", description: errMessage(err) });
      } finally {
        setApplyingCardId(null);
      }
    },
    [deriveConfirmBody, invalidateAll, toast, errMessage],
  );

  const handleResolveDonor = useCallback(
    async (card: ReconciliationCard, donor: ReconciliationCandidate) => {
      const body = {
        organizationId:
          donor.donorKind === "organization" ? donor.id : null,
        individualGiverPersonId:
          donor.donorKind === "person" ? donor.id : null,
        householdId: donor.donorKind === "household" ? donor.id : null,
      };
      try {
        await resolveM.mutateAsync({ id: card.stagedPaymentId, data: body });
        invalidateAll();
        setDonorCard(null);
        toast({ title: `Donor set to ${donor.label}.` });
      } catch (err) {
        toast({ title: "Couldn't set donor", description: errMessage(err) });
      }
    },
    [resolveM, invalidateAll, toast, errMessage],
  );

  const handleExclude = useCallback(
    async (card: ReconciliationCard, reason: StagedPaymentExclusionReason) => {
      try {
        await excludeM.mutateAsync({
          id: card.stagedPaymentId,
          data: { exclusionReason: reason },
        });
        invalidateAll();
        setExcludeCard(null);
        toast({ title: "Payment excluded (not a gift)." });
      } catch (err) {
        toast({ title: "Couldn't exclude", description: errMessage(err) });
      }
    },
    [excludeM, invalidateAll, toast, errMessage],
  );

  const handleReInclude = useCallback(
    async (card: ReconciliationCard) => {
      try {
        await reIncludeM.mutateAsync({ id: card.stagedPaymentId });
        invalidateAll();
        toast({ title: "Re-included → back in the review queue." });
      } catch (err) {
        toast({ title: "Couldn't re-include", description: errMessage(err) });
      }
    },
    [reIncludeM, invalidateAll, toast, errMessage],
  );

  const handleToggleSyncGap = useCallback(
    async (card: ReconciliationCard) => {
      try {
        await syncGapM.mutateAsync({
          id: card.stagedPaymentId,
          data: { syncGap: !card.syncGap },
        });
        invalidateAll();
      } catch (err) {
        toast({ title: "Couldn't update sync-gap flag", description: errMessage(err) });
      }
    },
    [syncGapM, invalidateAll, toast, errMessage],
  );

  const handleToggleResearch = useCallback(
    async (card: ReconciliationCard) => {
      try {
        await researchM.mutateAsync({
          id: card.stagedPaymentId,
          data: { needsResearch: !card.needsResearch },
        });
        invalidateAll();
      } catch (err) {
        toast({ title: "Couldn't update research flag", description: errMessage(err) });
      }
    },
    [researchM, invalidateAll, toast, errMessage],
  );

  const handleGroupSelected = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length < 2) return;
    const run = (confirmDonorConflict: boolean) =>
      groupM.mutateAsync({
        data: { stagedPaymentIds: ids, confirmDonorConflict },
      });
    try {
      await run(false);
    } catch (err) {
      const code =
        err && typeof err === "object" && "data" in err
          ? (err as { data?: { error?: string } }).data?.error
          : undefined;
      if (
        code === "donor_conflict" &&
        window.confirm(
          "These payments resolve to more than one donor. Group them into one gift anyway?",
        )
      ) {
        try {
          await run(true);
        } catch (retryErr) {
          toast({ title: "Couldn't group", description: errMessage(retryErr) });
          return;
        }
      } else {
        toast({ title: "Couldn't group", description: errMessage(err) });
        return;
      }
    }
    setSelectedIds(new Set());
    invalidateAll();
    toast({
      title: `Grouped ${ids.length} payments`,
      description: "Reconcile the group from its card in Needs review.",
    });
  }, [selectedIds, groupM, invalidateAll, toast, errMessage]);

  const activeQueue = QUEUES.find((q) => q.id === queue)!;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      {/* Queue nav (horizontal) */}
      <nav className="flex flex-wrap items-center gap-1 border-b pb-2">
        {QUEUES.map((q) => {
          const active = q.id === queue;
          return (
            <button
              key={q.id}
              type="button"
              onClick={() => setQueue(q.id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                active
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: q.dot }}
              />
              {q.name}
              {q.id === "review" && (
                <Badge variant="secondary">
                  {cardsQuery.isLoading ? "…" : buckets.review.length}
                </Badge>
              )}
              {q.id === "qbo" && buckets.qbo.length > 0 && (
                <Badge variant="secondary">{buckets.qbo.length}</Badge>
              )}
              {q.id === "sync" && buckets.sync.length > 0 && (
                <Badge variant="secondary">{buckets.sync.length}</Badge>
              )}
              {q.id === "research" && buckets.research.length > 0 && (
                <Badge variant="secondary">{buckets.research.length}</Badge>
              )}
              {q.id === "excluded" && excludedQuery.data && (
                <Badge variant="secondary">{excludedCards.length}</Badge>
              )}
              {!q.live && (
                <span className="text-[10px] uppercase text-muted-foreground/70">
                  soon
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Main column */}
      <main className="flex min-h-0 flex-1 flex-col">
        <header className="mb-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold">Reconciliation Workbench</h1>
              <p className="text-sm text-muted-foreground">
                {activeQueue.name} — one place to reconcile pulled money to CRM
                gifts. Pull-only: nothing is written to QuickBooks, Stripe, or
                Donorbox.
              </p>
            </div>
            {queue === "review" && (
              <Button
                onClick={approveAllHighConfidence}
                disabled={busy || readyCount === 0}
                className="shrink-0"
              >
                {busy ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-1 h-4 w-4" />
                )}
                Approve all high-confidence ({readyCount})
              </Button>
            )}
          </div>

          {/* Axis selector */}
          <div className="flex flex-wrap items-center gap-2">
            {AXES.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setAxis(a.id)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  axis === a.id
                    ? "border-foreground bg-foreground text-background"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {a.label}
              </button>
            ))}
            <div className="relative ml-auto">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search payer, gift, donor…"
                className="h-8 w-64 pl-7 text-sm"
              />
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-28 pr-1">
          {queue === "crm" ? (
            <StrayGiftsWorklist />
          ) : queue === "split" ? (
            <SplitsPledgesQueue
              cards={[...buckets.review, ...buckets.qbo]}
              loading={cardsQuery.isLoading}
              onSplit={(c) => setSplitCard(c)}
            />
          ) : queue === "bundle" ? (
            <BundlesQueue axis={axis} search={search} />
          ) : queue === "confirmed" ? (
            <ComingSoon name={activeQueue.name} />
          ) : queue === "excluded" ? (
            excludedQuery.isLoading ? (
              <LoadingRow />
            ) : excludedQuery.isError ? (
              <ErrorRow label="excluded queue" />
            ) : excludedCards.length === 0 ? (
              <EmptyExcluded />
            ) : (
              excludedCards.map((card) => (
                <ExcludedCard
                  key={card.stagedPaymentId}
                  card={card}
                  busy={actionBusy}
                  onReInclude={() => handleReInclude(card)}
                />
              ))
            )
          ) : cardsQuery.isLoading ? (
            <LoadingRow />
          ) : cardsQuery.isError ? (
            <ErrorRow label="review queue" />
          ) : (
            // Needs review + QBO-only + Research + Sync gaps share one card.
            (() => {
              const bucket =
                queue === "review"
                  ? buckets.review
                  : queue === "qbo"
                    ? buckets.qbo
                    : queue === "research"
                      ? buckets.research
                      : buckets.sync;
              if (bucket.length === 0)
                return queue === "review" ? (
                  <EmptyState />
                ) : (
                  <EmptyBucket queue={queue} />
                );
              return bucket.map((card) => (
                <ReconCard
                  key={card.stagedPaymentId}
                  card={card}
                  staged={staged.find(
                    (s) => s.stagedPaymentId === card.stagedPaymentId,
                  )}
                  expanded={expanded === card.stagedPaymentId}
                  busy={
                    busy ||
                    actionBusy ||
                    applyingCardId === card.stagedPaymentId
                  }
                  selected={selectedIds.has(card.stagedPaymentId)}
                  onToggleSelect={() => toggleSelect(card.stagedPaymentId)}
                  onToggle={() =>
                    setExpanded((e) =>
                      e === card.stagedPaymentId ? null : card.stagedPaymentId,
                    )
                  }
                  onConfirm={() => confirmAndApply(card)}
                  onReject={() => stageReject(card)}
                  onRetarget={() => setRetargetCard(card)}
                  onCreateGift={() => handleCreateGift(card)}
                  onChangeDonor={() => setDonorCard(card)}
                  onExclude={() => setExcludeCard(card)}
                  onSplit={() => setSplitCard(card)}
                  onGroup={() => {
                    toggleSelect(card.stagedPaymentId);
                    toast({
                      title: "Selected for grouping",
                      description:
                        "Pick another payment, then Group into one gift.",
                    });
                  }}
                  onToggleSyncGap={() => handleToggleSyncGap(card)}
                  onToggleResearch={() => handleToggleResearch(card)}
                  onUnstage={() => unstage(card.stagedPaymentId)}
                />
              ));
            })()
          )}
        </div>
      </main>

      {/* Pending changes tray */}
      {staged.length > 0 && (
        <PendingTray
          staged={staged}
          applying={applying}
          onApply={applyToCrm}
          onRemove={unstage}
          onClear={() => setStaged([])}
        />
      )}

      {/* Re-target dialog */}
      {retargetCard && (
        <RetargetDialog
          card={retargetCard}
          busy={busy}
          onClose={() => setRetargetCard(null)}
          onPick={(gift) => stageRetarget(retargetCard, gift)}
        />
      )}

      {/* Split-across-gifts editor */}
      {splitCard && (
        <SplitEditorDialog
          card={splitCard}
          onClose={() => setSplitCard(null)}
          onStage={stageSplit}
        />
      )}

      {/* Group selected → one gift (Review / QBO-only / Research / Sync buckets) */}
      {(queue === "review" ||
        queue === "qbo" ||
        queue === "research" ||
        queue === "sync") &&
        selectedIds.size > 0 && (
          <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border bg-card px-4 py-2 shadow-xl">
            <span className="text-sm font-medium">
              {selectedIds.size} selected
            </span>
            <Button
              size="sm"
              onClick={handleGroupSelected}
              disabled={actionBusy || selectedIds.size < 2}
            >
              {groupM.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Layers className="mr-1 h-4 w-4" />
              )}
              Group into one gift
            </Button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
        )}

      {/* Change donor dialog */}
      {donorCard && (
        <ChangeDonorDialog
          card={donorCard}
          busy={resolveM.isPending}
          onClose={() => setDonorCard(null)}
          onPick={(donor) => handleResolveDonor(donorCard, donor)}
        />
      )}

      {/* Exclude dialog */}
      {excludeCard && (
        <ExcludeDialog
          card={excludeCard}
          busy={excludeM.isPending}
          onClose={() => setExcludeCard(null)}
          onConfirm={(reason) => handleExclude(excludeCard, reason)}
        />
      )}
    </div>
  );
}

// ─── Two-sided card ───────────────────────────────────────────────────────────

/**
 * Unified contextual "Resolve" menu — the full staged-payment action set on
 * every card, grouped Matching / Classify / Restructure / Flag. Items are
 * shown contextually (link-existing vs create-new) and each is wired to the
 * same handler the page already uses; no new endpoints.
 */
function ResolveMenu({
  card,
  busy,
  onConfirm,
  onReject,
  onRetarget,
  onCreateGift,
  onChangeDonor,
  onExclude,
  onSplit,
  onGroup,
  onToggleSyncGap,
  onToggleResearch,
}: {
  card: ReconciliationCard;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
  onRetarget: () => void;
  onCreateGift: () => void;
  onChangeDonor: () => void;
  onExclude: () => void;
  onSplit: () => void;
  onGroup: () => void;
  onToggleSyncGap: () => void;
  onToggleResearch: () => void;
}) {
  const hasGift = Boolean(card.resolvedGiftId || card.proposedGiftId);
  const MI = (onClick: () => void, title: string, desc: string) => (
    <DropdownMenuItem onClick={onClick} className="flex-col items-start gap-0">
      <span className="font-medium">{title}</span>
      <span className="text-[11px] text-muted-foreground">{desc}</span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 gap-1" disabled={busy}>
          Resolve <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Matching
        </DropdownMenuLabel>
        {hasGift && MI(onConfirm, "Confirm match", "approve this link")}
        {hasGift && MI(onReject, "Reject match", "these are not the same")}
        {hasGift && MI(onRetarget, "Re-target match", "link to a different gift")}
        {!hasGift &&
          MI(onCreateGift, "Create gift", "build a new gift from this payment")}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Classify
        </DropdownMenuLabel>
        {MI(
          onChangeDonor,
          "Change donor / payer",
          "payer-vehicle → donor; DAF / employer",
        )}
        {MI(
          onExclude,
          "Exclude payment",
          "reason: vendor, reimbursement, loan…",
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Restructure
        </DropdownMenuLabel>
        {MI(onSplit, "Split payment across gifts", "one payment → many gifts")}
        {MI(
          onGroup,
          "Group payments → one gift",
          "select rows that fund one gift",
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Flag
        </DropdownMenuLabel>
        {MI(
          onToggleSyncGap,
          card.syncGap ? "Clear sync gap" : "Flag as sync gap",
          "exists in CRM, missing from export",
        )}
        {MI(
          onToggleResearch,
          card.needsResearch ? "Clear research" : "Send to research",
          "park with a note for later",
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The single card surface used by Needs review, QBO-only, Research and Sync
 * gaps. It distinguishes "link an existing gift" from "create a new gift",
 * shows the QB payment method in the header, a legible balance meter, and the
 * full contextual action set (inline primary + Reject + Resolve menu).
 */
function ReconCard({
  card,
  staged,
  expanded,
  busy,
  selected,
  onToggleSelect,
  onToggle,
  onConfirm,
  onReject,
  onRetarget,
  onCreateGift,
  onChangeDonor,
  onExclude,
  onSplit,
  onGroup,
  onToggleSyncGap,
  onToggleResearch,
  onUnstage,
}: {
  card: ReconciliationCard;
  staged: StagedChange | undefined;
  expanded: boolean;
  busy: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onToggle: () => void;
  onConfirm: () => void;
  onReject: () => void;
  onRetarget: () => void;
  onCreateGift: () => void;
  onChangeDonor: () => void;
  onExclude: () => void;
  onSplit: () => void;
  onGroup: () => void;
  onToggleSyncGap: () => void;
  onToggleResearch: () => void;
  onUnstage: () => void;
}) {
  const conf = confidenceOf(card);
  const meta = CONFIDENCE_META[conf];
  const bullets = evidenceBullets(card);
  const lanes = laneBadges(card.reconciliationLanes);
  const hasGift = Boolean(card.resolvedGiftId || card.proposedGiftId);
  const hasDonor = Boolean(card.proposedDonorId || card.proposedDonorName);
  const linkedGiftName = card.resolvedGiftName ?? card.proposedGiftName;
  const status = deriveCardStatus(card);
  // Header id: the human "No." (qbDocNumber) if present, else the stable QB id.
  const qbIdText = card.qbDocNumber ?? card.qbEntityId;
  // Real donor on the QB side: a Stripe charge's QB payer is literally "Stripe",
  // so prefer the charge's payer name when this money came through Stripe.
  const qbPayerName = card.stripeChargeDonorName ?? card.payerName;
  const crmRecordLane = lanes.find((b) => b.key === "crmRecord");

  return (
    <div
      className={cn(
        "rounded-lg border bg-card shadow-sm",
        (staged || selected) && "ring-2 ring-primary/40",
      )}
    >
      <div className="flex items-stretch gap-0">
        {/* Select for grouping */}
        <div className="flex items-start p-3 pr-0">
          <Checkbox
            checked={selected}
            onCheckedChange={onToggleSelect}
            className="mt-1"
            aria-label="Select for grouping"
          />
        </div>

        {/* Left: QuickBooks anchor (transaction type + id, payment method & Stripe in the header) */}
        <div className="flex-1 p-3">
          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span>
              {card.qbEntityType ?? "QuickBooks"}
              {qbIdText ? ` (#${qbIdText})` : ""}
            </span>
            {card.qbPaymentMethod && (
              <span className="rounded bg-muted px-1.5 py-0.5 normal-case">
                {card.qbPaymentMethod}
              </span>
            )}
            {card.hasStripeEvidence && (
              <span className="rounded bg-indigo-100 px-1.5 py-0.5 normal-case text-indigo-700">
                Stripe
              </span>
            )}
          </div>
          <div className="font-medium">{qbPayerName ?? "Unknown payer"}</div>
          {card.stripeGrossAmount != null ? (
            <div className="text-sm font-semibold tabular-nums">
              {money(card.stripeGrossAmount)} gross
              <span className="font-normal text-muted-foreground">
                {" = "}
                {money(card.stripeNetAmount)} net + {money(card.stripeFeeAmount)}{" "}
                fee
              </span>
            </div>
          ) : (
            <div className="text-lg font-semibold tabular-nums">
              {money(card.amount)}
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            {card.dateReceived ?? "—"}
          </div>
        </div>

        <div className="flex items-center px-1 text-muted-foreground">
          <ArrowRight className="h-4 w-4" />
        </div>

        {/* Right: CRM gift lane — link existing vs create new */}
        <div className="flex-1 p-3">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            CRM gift
          </div>
          {hasGift ? (
            <>
              <div className="font-medium">
                {card.proposedDonorName ?? card.proposedDonorKind ?? "Donor"}
              </div>
              {linkedGiftName && (
                <div className="text-xs text-muted-foreground">
                  {linkedGiftName}
                </div>
              )}
              {num(card.resolvedGiftAmount) != null && (
                <div className="text-lg font-semibold tabular-nums">
                  {money(card.resolvedGiftAmount)}
                </div>
              )}
              {card.resolvedGiftDate && (
                <div className="text-xs text-muted-foreground">
                  Close date: {card.resolvedGiftDate}
                </div>
              )}
            </>
          ) : hasDonor ? (
            <>
              <Badge className="mb-1 bg-emerald-100 text-emerald-800 text-[10px]">
                Create new gift
              </Badge>
              <div className="font-medium">
                {card.proposedDonorName ?? "New gift"}
              </div>
              <div className="text-xs text-muted-foreground">
                Mints a new gift from this payment for this donor.
              </div>
            </>
          ) : (
            <>
              <Badge variant="outline" className="mb-1 text-[10px]">
                No gift yet
              </Badge>
              <div className="text-sm text-muted-foreground">
                Set a donor to create a new gift — or link an existing one.
              </div>
            </>
          )}
        </div>

        {/* Confidence + expand */}
        <div className="flex w-40 shrink-0 flex-col items-end justify-between border-l p-3">
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[11px] font-medium",
              meta.className,
            )}
          >
            {meta.label}
          </span>
          <button
            type="button"
            onClick={onToggle}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Details
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                expanded && "rotate-180",
              )}
            />
          </button>
        </div>
      </div>

      {/* Status + CRM-record lane + evidence */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
        <Badge variant={status.variant} className="text-[10px]">
          Status: {status.label}
        </Badge>
        {crmRecordLane && (
          <Badge variant={crmRecordLane.variant} className="text-[10px]">
            {crmRecordLane.label}
          </Badge>
        )}
        {card.syncGap && (
          <Badge className="bg-orange-100 text-orange-800 text-[10px]">
            Sync gap
          </Badge>
        )}
        {card.needsResearch && (
          <Badge className="bg-stone-200 text-stone-800 text-[10px]">
            Research
          </Badge>
        )}
        {bullets.slice(0, 3).map((b, i) => (
          <span
            key={i}
            className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
          >
            {b}
          </span>
        ))}
      </div>

      {expanded && (
        <LineageStrip
          stagedPaymentId={card.stagedPaymentId}
          feeAmount={feeRemainder(num(card.amount), num(card.resolvedGiftAmount))}
        />
      )}

      {/* Actions: inline primary + Reject + full Resolve menu */}
      <div className="flex items-center gap-2 border-t px-3 py-2">
        {staged ? (
          <>
            <span className="flex items-center gap-1 text-xs font-medium text-primary">
              <Check className="h-3.5 w-3.5" /> Staged: {staged.detail}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={onUnstage}
            >
              Undo
            </Button>
          </>
        ) : (
          <>
            {hasGift ? (
              <Button
                size="sm"
                className="gap-1 bg-emerald-600 text-white hover:bg-emerald-700"
                onClick={onConfirm}
                disabled={busy || !card.proposedGiftId}
              >
                <Check className="h-3.5 w-3.5" /> Approve
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={onCreateGift}
                disabled={busy || !hasDonor}
              >
                <Check className="mr-1 h-3.5 w-3.5" /> Create gift
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="gap-1 border-red-200 text-red-700 hover:bg-red-50"
              onClick={onReject}
              disabled={busy}
            >
              <X className="h-3.5 w-3.5" /> Reject
            </Button>
            <div className="ml-auto">
              <ResolveMenu
                card={card}
                busy={busy}
                onConfirm={onConfirm}
                onReject={onReject}
                onRetarget={onRetarget}
                onCreateGift={onCreateGift}
                onChangeDonor={onChangeDonor}
                onExclude={onExclude}
                onSplit={onSplit}
                onGroup={onGroup}
                onToggleSyncGap={onToggleSyncGap}
                onToggleResearch={onToggleResearch}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Balance meter ────────────────────────────────────────────────────────────

function BalanceMeter({
  paymentTotal,
  applied,
}: {
  paymentTotal: number | null;
  applied: number | null;
}) {
  if (paymentTotal == null || applied == null) return null;

  const remainder = +(paymentTotal - applied).toFixed(2);
  const balanced = Math.abs(remainder) < 0.005;
  // When the applied amount exceeds the payment by an amount inside the processor
  // fee-band, that gap is the processor fee (gift is gross, deposit is net) —
  // not an over-application error.
  const fee = feeRemainder(paymentTotal, applied);
  const isFee = fee != null;
  // `applied` is larger than the payment and the gap isn't a processor fee.
  const over = remainder < -0.005 && !isFee;
  const overBy = +(-remainder).toFixed(2);

  const tone: "emerald" | "sky" | "red" | "amber" = over
    ? "red"
    : balanced
      ? "emerald"
      : isFee
        ? "sky"
        : "amber";
  const toneBox = {
    emerald: "border-emerald-200 bg-emerald-50/60",
    sky: "border-sky-200 bg-sky-50/60",
    red: "border-red-200 bg-red-50/60",
    amber: "border-amber-200 bg-amber-50/60",
  }[tone];
  const toneBar = {
    emerald: "bg-emerald-500",
    sky: "bg-sky-500",
    red: "bg-red-500",
    amber: "bg-amber-500",
  }[tone];
  const toneText = {
    emerald: "text-emerald-700",
    sky: "text-sky-700",
    red: "text-red-700",
    amber: "text-amber-700",
  }[tone];

  // Full bar when over-applied; otherwise the applied/payment ratio.
  const pct = over
    ? 100
    : paymentTotal > 0
      ? Math.max(0, Math.min(100, (applied / paymentTotal) * 100))
      : applied > 0
        ? 100
        : 0;
  return (
    <div className="px-3 pb-2">
      <div className={cn("rounded-lg border p-3 text-[12.5px]", toneBox)}>
        <div className="flex items-baseline justify-between tabular-nums">
          <span className="text-muted-foreground">Applied</span>
          <span className="font-semibold">{money(String(applied))}</span>
        </div>
        <div className="my-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-all", toneBar)}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex items-baseline justify-between tabular-nums">
          <span className="text-muted-foreground">Payment total</span>
          <span className="font-semibold">{money(String(paymentTotal))}</span>
        </div>
        <div
          className={cn(
            "mt-2 flex items-center gap-1.5 font-semibold",
            toneText,
          )}
        >
          {over ? (
            <>
              <AlertCircle className="h-3.5 w-3.5 shrink-0" /> Over-applied by{" "}
              {money(String(overBy))}
            </>
          ) : balanced ? (
            <>
              <Check className="h-3.5 w-3.5" /> Balances — applied equals payment
            </>
          ) : isFee ? (
            <>
              <Check className="h-3.5 w-3.5" /> {money(String(fee))} fee — gift is
              gross; deposit is net of the processor fee
            </>
          ) : (
            <>
              <AlertCircle className="h-3.5 w-3.5" /> {money(String(remainder))}{" "}
              unapplied — route the remainder
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Settlement lineage strip ─────────────────────────────────────────────────

function LineageStrip({
  stagedPaymentId,
  feeAmount,
}: {
  stagedPaymentId: string;
  feeAmount?: number | null;
}) {
  const { data, isLoading, isError } = useGetReconciliationLineage(stagedPaymentId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading settlement
        lineage…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        No settlement lineage available.
      </div>
    );
  }

  const steps: { label: string; sub: string; done: boolean }[] = [];
  steps.push({
    label: "QBO deposit",
    sub: `${money(data.deposit.amount)}${data.deposit.depositToAccountName ? ` · ${data.deposit.depositToAccountName}` : ""}`,
    done: true,
  });
  if (data.payout) {
    steps.push({
      label: "Stripe payout",
      sub: `${money(data.payout.netTotal ?? data.payout.amount)} net · ${data.payout.chargeCount ?? 0} charges`,
      done: data.payout.linkSource !== "pulled",
    });
  }
  for (const c of data.charges.slice(0, 4)) {
    steps.push({
      label: "Stripe charge",
      sub: `${money(c.grossAmount)}${c.payerName ? ` · ${c.payerName}` : ""}`,
      done: c.linkSource === "stripe_confirmed",
    });
  }
  for (const d of data.donations.slice(0, 4)) {
    steps.push({
      label: `Donorbox${d.donationType ? ` (${d.donationType})` : ""}`,
      sub: `${money(d.amount)}${d.donorName ? ` · ${d.donorName}` : ""}`,
      done: d.linkSource === "stripe_confirmed",
    });
  }

  return (
    <div className="border-t bg-muted/30 px-3 py-2">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Settlement lineage
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {steps.map((s, i) => (
          <div key={i} className="flex items-center gap-1">
            <div
              className={cn(
                "rounded border px-2 py-1 text-[11px]",
                s.done
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-border bg-background text-muted-foreground",
              )}
            >
              <div className="font-medium">{s.label}</div>
              <div className="tabular-nums">{s.sub}</div>
            </div>
            {i < steps.length - 1 && (
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
            )}
          </div>
        ))}
      </div>
      {feeAmount != null && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          Processor fee:{" "}
          <span className="font-medium tabular-nums">
            {money(String(feeAmount))}
          </span>{" "}
          — gift recorded gross; QB deposit is net.
        </div>
      )}
    </div>
  );
}

// ─── Stripe/Donorbox settlement bundles ───────────────────────────────────────

const PAYOUT_STATUS_META: Record<
  string,
  { label: string; className: string }
> = {
  proposed: {
    label: "Proposed",
    className: "bg-amber-100 text-amber-800 border-amber-200",
  },
  conflict_approved: {
    label: "Conflict — already a gift",
    className: "bg-rose-100 text-rose-800 border-rose-200",
  },
  confirmed_reconciled: {
    label: "Confirmed · reconciled",
    className: "bg-emerald-100 text-emerald-800 border-emerald-200",
  },
  confirmed_excluded: {
    label: "Confirmed · excluded",
    className: "bg-emerald-100 text-emerald-800 border-emerald-200",
  },
  confirmed_keep: {
    label: "Confirmed · kept",
    className: "bg-emerald-100 text-emerald-800 border-emerald-200",
  },
  confirmed_replace: {
    label: "Confirmed · replaced",
    className: "bg-emerald-100 text-emerald-800 border-emerald-200",
  },
  unmatched: {
    label: "Unmatched",
    className: "bg-muted text-muted-foreground border-border",
  },
};

/**
 * Settlement bundles are payout-anchored: their spine is the QuickBooks⇄Stripe
 * deposit-to-payout tie, with per-charge Stripe gifts and Donorbox enrichment
 * living inside each card's lineage. The pure QuickBooks⇄Gift and
 * QuickBooks⇄Donorbox axes have no payout-bundle surface, so they show empty.
 */
function BundlesQueue({ axis, search }: { axis: AxisId; search: string }) {
  const q = useListStripePayoutReconciliations({ queue: "all", limit: 200 });
  const rows = q.data?.data ?? [];
  const term = search.trim().toLowerCase();

  const filtered = useMemo(
    () =>
      rows.filter((b) => {
        if (!term) return true;
        return (
          b.id.toLowerCase().includes(term) ||
          (b.depositPayerName ?? "").toLowerCase().includes(term)
        );
      }),
    [rows, term],
  );

  const axisOk = axis === "all" || axis === "qs" || axis === "ds";
  if (!axisOk) return <EmptyBundlesAxis />;
  if (q.isLoading) return <LoadingRow />;
  if (q.isError) return <ErrorRow label="settlement bundles" />;
  if (filtered.length === 0) return <EmptyBundles />;

  return (
    <>
      {filtered.map((b) => (
        <BundleCard key={b.id} bundle={b} />
      ))}
    </>
  );
}

function EmptyBundles() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center text-muted-foreground">
      <Check className="mb-2 h-8 w-8 text-emerald-500" />
      <p className="font-medium">No settlement bundles</p>
      <p className="text-sm">
        No Stripe payouts are matched to a QuickBooks deposit yet.
      </p>
    </div>
  );
}

function EmptyBundlesAxis() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center text-muted-foreground">
      <Layers className="mb-2 h-8 w-8" />
      <p className="font-medium">No bundles on this axis</p>
      <p className="max-w-sm text-sm">
        Settlement bundles live on the QuickBooks ⇄ Stripe and Donorbox ⇄ Stripe
        axes. Switch to "All sources" to see every bundle.
      </p>
    </div>
  );
}

function BundleCard({ bundle }: { bundle: StripePayoutReconciliation }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const depositId = bundle.depositId ?? "";

  const lineageQ = useGetReconciliationLineage(depositId, {
    query: {
      enabled: depositId !== "",
      queryKey: getGetReconciliationLineageQueryKey(depositId),
    },
  });
  const charges = useMemo(
    () => lineageQ.data?.charges ?? [],
    [lineageQ.data],
  );

  const confirmExclude = useConfirmStripePayoutExclude();
  const confirmKeep = useConfirmStripePayoutKeep();
  const revert = useRevertStripePayoutReconciliation();
  const createGift = useCreateGiftFromStripeStagedCharge();
  const confirmRefund = useConfirmStripeRefundPropagation();
  const confirmTies = useConfirmBundleCrossProcessorTies();

  const busy =
    confirmExclude.isPending ||
    confirmKeep.isPending ||
    revert.isPending ||
    createGift.isPending ||
    confirmRefund.isPending ||
    confirmTies.isPending;

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({
      queryKey: ["/api/stripe-payouts/reconciliation"],
    });
    if (depositId) {
      void qc.invalidateQueries({
        queryKey: getGetReconciliationLineageQueryKey(depositId),
      });
    }
  }, [qc, depositId]);

  const status = bundle.qbReconciliationStatus;
  const statusMeta = PAYOUT_STATUS_META[status] ?? {
    label: status,
    className: "bg-muted text-muted-foreground border-border",
  };
  const isConfirmed = status.startsWith("confirmed_");

  const mintable = charges.filter((c) => c.donorResolved && !c.hasGift);
  const refundable = charges.filter((c) => c.refunded || c.disputed);

  const onConfirm = async () => {
    try {
      await confirmExclude.mutateAsync({ id: bundle.id });
      toast({ title: "Payout reconciled to the QuickBooks deposit." });
      invalidate();
    } catch {
      toast({
        title: "Couldn't confirm the reconciliation.",
        variant: "destructive",
      });
    }
  };

  const onKeep = async () => {
    try {
      await confirmKeep.mutateAsync({ id: bundle.id });
      toast({ title: "Kept — the existing gift stands, no double-count." });
      invalidate();
    } catch {
      toast({ title: "Couldn't keep the payout.", variant: "destructive" });
    }
  };

  const onRevert = async () => {
    try {
      await revert.mutateAsync({ id: bundle.id });
      toast({ title: "Reconciliation reverted." });
      invalidate();
    } catch {
      toast({ title: "Couldn't revert.", variant: "destructive" });
    }
  };

  const onExplode = async () => {
    if (mintable.length === 0) return;
    let made = 0;
    let failed = 0;
    for (const c of mintable) {
      try {
        await createGift.mutateAsync({ id: c.chargeId });
        made += 1;
      } catch {
        failed += 1;
      }
    }
    toast({
      title: `Exploded payout into ${made} gift${made === 1 ? "" : "s"}.`,
      description: failed > 0 ? `${failed} charge(s) couldn't be minted.` : undefined,
      variant: failed > 0 && made === 0 ? "destructive" : undefined,
    });
    invalidate();
  };

  const onConfirmRefund = async (chargeId: string) => {
    try {
      await confirmRefund.mutateAsync({ id: chargeId });
      toast({ title: "Refund propagated to the gift." });
      invalidate();
    } catch {
      toast({
        title: "Couldn't propagate the refund.",
        variant: "destructive",
      });
    }
  };

  const onConfirmTies = async () => {
    if (!depositId) return;
    try {
      const res = await confirmTies.mutateAsync({ stagedPaymentId: depositId });
      toast({
        title: "Cross-processor links saved.",
        description: `${res.chargesLinked} charge(s) · ${res.donationsLinked} Donorbox donation(s) tied.`,
      });
      invalidate();
    } catch {
      toast({
        title: "Couldn't save the cross-processor links.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Wallet className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {bundle.depositPayerName || "Stripe payout"}{" "}
            <span className="font-normal text-muted-foreground">
              {money(bundle.netTotal ?? bundle.amount)} net ·{" "}
              {bundle.chargeCount ?? 0} charges
            </span>
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {bundle.id}
            {bundle.arrivalDate ? ` · arrived ${bundle.arrivalDate}` : ""}
          </div>
        </div>
        <Badge
          variant="outline"
          className={cn("ml-auto text-[11px]", statusMeta.className)}
        >
          {statusMeta.label}
        </Badge>
      </div>

      {depositId ? (
        <LineageStrip stagedPaymentId={depositId} />
      ) : (
        <div className="border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          No QuickBooks deposit linked yet.
        </div>
      )}

      {/* ── Per-charge explode + refund propagation ─────────────────────── */}
      {charges.length > 0 && (
        <div className="border-t px-3 py-2">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Per-donor charges
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={busy || mintable.length === 0}
              onClick={onExplode}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Explode into {mintable.length} gift
              {mintable.length === 1 ? "" : "s"}
            </Button>
          </div>
          <div className="space-y-1">
            {charges.map((c) => (
              <div
                key={c.chargeId}
                className="flex flex-wrap items-center gap-2 rounded border bg-background px-2 py-1 text-[11px]"
              >
                <span className="font-medium tabular-nums">
                  {money(c.grossAmount)}
                </span>
                <span className="truncate text-muted-foreground">
                  {c.resolvedDonorName || c.payerName || c.payerEmail || "—"}
                </span>
                {(c.refunded || c.disputed) && (
                  <Badge
                    variant="outline"
                    className="border-rose-200 bg-rose-50 text-rose-700"
                  >
                    {c.disputed ? "Disputed" : "Refunded"}
                  </Badge>
                )}
                {c.hasGift ? (
                  <Badge
                    variant="outline"
                    className="ml-auto border-emerald-200 bg-emerald-50 text-emerald-700"
                  >
                    <Check className="mr-1 h-3 w-3" /> Gift created
                  </Badge>
                ) : c.donorResolved ? (
                  <Badge
                    variant="outline"
                    className="ml-auto border-amber-200 bg-amber-50 text-amber-700"
                  >
                    Ready to mint
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="ml-auto border-border text-muted-foreground"
                  >
                    Needs donor
                  </Badge>
                )}
                {(c.refunded || c.disputed) && c.hasGift && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2"
                    disabled={busy}
                    onClick={() => onConfirmRefund(c.chargeId)}
                  >
                    <Undo2 className="mr-1 h-3 w-3" /> Propagate refund
                  </Button>
                )}
              </div>
            ))}
          </div>
          {refundable.length > 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {refundable.length} charge(s) refunded or disputed — propagate to
              reduce the linked gift.
            </p>
          )}
        </div>
      )}

      {/* ── Stripe ⇄ QuickBooks + cross-processor tie actions ───────────── */}
      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
        {status === "proposed" && (
          <Button size="sm" className="h-8" disabled={busy} onClick={onConfirm}>
            <Check className="mr-1 h-4 w-4" /> Confirm reconciliation
          </Button>
        )}
        {status === "conflict_approved" && (
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={busy}
            onClick={onKeep}
          >
            Keep — no double-count
          </Button>
        )}
        {isConfirmed && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={busy || !depositId}
              onClick={onConfirmTies}
            >
              <GitMerge className="mr-1 h-4 w-4" /> Persist cross-processor links
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              disabled={busy}
              onClick={onRevert}
            >
              <Undo2 className="mr-1 h-4 w-4" /> Revert
            </Button>
          </>
        )}
        {busy && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>
    </div>
  );
}

// ─── Re-target dialog ─────────────────────────────────────────────────────────

function RetargetDialog({
  card,
  busy,
  onClose,
  onPick,
}: {
  card: ReconciliationCard;
  busy: boolean;
  onClose: () => void;
  onPick: (gift: ReconciliationCandidate) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ReconciliationCandidate[]>([]);
  const [searching, setSearching] = useState(false);

  const runSearch = useCallback(async () => {
    setSearching(true);
    try {
      const res = await searchReconciliationNode("gift", {
        stagedPaymentId: card.stagedPaymentId,
        q: q.trim() || undefined,
        limit: 20,
      });
      setResults(res.data ?? []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [card.stagedPaymentId, q]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Re-target match</DialogTitle>
          <DialogDescription>
            Link {card.payerName ?? "this payment"} ({money(card.amount)}) to a
            different existing gift.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
            placeholder="Search gifts by donor or amount…"
          />
          <Button onClick={runSearch} disabled={searching}>
            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
          </Button>
        </div>
        <Separator />
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {results.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {searching ? "Searching…" : "No gifts found yet — search above."}
            </p>
          ) : (
            results.map((g) => {
              const linked = g.alreadyLinkedStagedPaymentId != null;
              return (
                <button
                  key={g.id}
                  type="button"
                  disabled={linked || busy}
                  onClick={() => onPick(g)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors",
                    linked
                      ? "cursor-not-allowed opacity-50"
                      : "hover:bg-muted",
                  )}
                >
                  <span>
                    <span className="font-medium">{g.label}</span>
                    {g.sublabel && (
                      <span className="block text-xs text-muted-foreground">
                        {g.sublabel}
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {money(g.amount)}
                    {linked && (
                      <span className="ml-1 text-[10px]">(linked)</span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pending changes tray ─────────────────────────────────────────────────────

function PendingTray({
  staged,
  applying,
  onApply,
  onRemove,
  onClear,
}: {
  staged: StagedChange[];
  applying: boolean;
  onApply: () => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const failures = staged.filter((s) => s.failure).length;
  return (
    <div className="fixed bottom-4 right-4 z-40 w-96 rounded-lg border bg-card shadow-xl">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-semibold">
          Pending changes ({staged.length})
        </span>
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Clear all
        </button>
      </div>
      <div className="max-h-64 space-y-1 overflow-y-auto p-2">
        {staged.map((s) => (
          <div
            key={s.key}
            className={cn(
              "flex items-start justify-between gap-2 rounded-md border px-2 py-1.5 text-xs",
              s.failure && "border-destructive/40 bg-destructive/5",
            )}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1 font-medium">
                <Badge
                  variant={s.kind === "reject" ? "destructive" : "secondary"}
                  className="text-[10px]"
                >
                  {s.kind}
                </Badge>
                <span className="truncate">{s.label}</span>
              </div>
              <div className="truncate text-muted-foreground">{s.detail}</div>
              {s.failure && (
                <div className="mt-0.5 flex items-start gap-1 text-destructive">
                  <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{s.failure}</span>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => onRemove(s.stagedPaymentId)}
              className="shrink-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <div className="border-t p-2">
        {failures > 0 && (
          <p className="mb-1 text-[11px] text-destructive">
            {failures} change{failures === 1 ? "" : "s"} couldn't apply — see
            reasons above.
          </p>
        )}
        <Button className="w-full" onClick={onApply} disabled={applying}>
          {applying ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <CheckCheck className="mr-1 h-4 w-4" />
          )}
          Apply to CRM
        </Button>
      </div>
    </div>
  );
}

// ─── Empty / placeholder states ───────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center text-muted-foreground">
      <Check className="mb-2 h-8 w-8 text-emerald-500" />
      <p className="font-medium">Nothing to review</p>
      <p className="text-sm">No QuickBooks money is waiting on a gift match.</p>
    </div>
  );
}

function ComingSoon({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center text-muted-foreground">
      <X className="mb-2 h-8 w-8" />
      <p className="font-medium">{name} is coming soon</p>
      <p className="max-w-sm text-sm">
        This queue is part of the workbench foundation but isn't wired up yet.
        Use the existing reconciliation pages for now.
      </p>
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="flex items-center justify-center py-16 text-muted-foreground">
      <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading cards…
    </div>
  );
}

function ErrorRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      <AlertCircle className="h-4 w-4" /> Couldn't load the {label}.
    </div>
  );
}

function EmptyExcluded() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center text-muted-foreground">
      <Check className="mb-2 h-8 w-8 text-emerald-500" />
      <p className="font-medium">Nothing excluded</p>
      <p className="text-sm">
        No QuickBooks money has been filed as a non-gift.
      </p>
    </div>
  );
}

function EmptyBucket({ queue }: { queue: QueueId }) {
  const copy =
    queue === "qbo"
      ? "No QuickBooks money is waiting without a CRM candidate."
      : queue === "research"
        ? "Nothing is flagged for research."
        : "Nothing is flagged as a sync gap.";
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center text-muted-foreground">
      <Check className="mb-2 h-8 w-8 text-emerald-500" />
      <p className="font-medium">All clear</p>
      <p className="text-sm">{copy}</p>
    </div>
  );
}

// ─── Excluded card (read + re-include) ────────────────────────────────────────

function ExcludedCard({
  card,
  busy,
  onReInclude,
}: {
  card: ReconciliationCard;
  busy: boolean;
  onReInclude: () => void;
}) {
  const reasonLabel = card.exclusionReason
    ? (EXCLUSION_REASON_LABELS[card.exclusionReason] ?? card.exclusionReason)
    : "Excluded";
  return (
    <div className="rounded-lg border bg-card p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{card.payerName ?? "Unknown payer"}</div>
          <div className="text-lg font-semibold tabular-nums">
            {money(card.amount)}
          </div>
          <div className="text-xs text-muted-foreground">
            {card.dateReceived ?? "—"}
            {card.qbDocNumber ? ` · #${card.qbDocNumber}` : ""}
          </div>
          <Badge variant="secondary" className="mt-2 text-[11px]">
            {reasonLabel}
          </Badge>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onReInclude}
          disabled={busy}
          className="shrink-0"
        >
          <Undo2 className="mr-1 h-3.5 w-3.5" />
          Re-include → review
        </Button>
      </div>
    </div>
  );
}

// ─── Change-donor dialog ──────────────────────────────────────────────────────

function ChangeDonorDialog({
  card,
  busy,
  onClose,
  onPick,
}: {
  card: ReconciliationCard;
  busy: boolean;
  onClose: () => void;
  onPick: (donor: ReconciliationCandidate) => void;
}) {
  const [donor, setDonor] = useState<ReconciliationCandidate | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Set donor</DialogTitle>
          <DialogDescription>
            Attribute {card.payerName ?? "this payment"} ({money(card.amount)})
            to a CRM donor. For DAF / employer-matched gifts, pick the underlying
            individual or organization — the processor stays a payment
            intermediary, not the donor.
          </DialogDescription>
        </DialogHeader>
        <ReconciliationNodeTypeahead
          nodeType="donor"
          stagedPaymentId={card.stagedPaymentId}
          value={donor}
          onChange={setDonor}
          placeholder="Search organizations, people, households…"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => donor && onPick(donor)} disabled={busy || !donor}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Set donor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Exclude dialog ───────────────────────────────────────────────────────────

function ExcludeDialog({
  card,
  busy,
  onClose,
  onConfirm,
}: {
  card: ReconciliationCard;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: StagedPaymentExclusionReason) => void;
}) {
  const [reason, setReason] = useState<StagedPaymentExclusionReason | "">("");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Exclude payment</DialogTitle>
          <DialogDescription>
            File {card.payerName ?? "this payment"} ({money(card.amount)}) under a
            non-gift category. It stays in QuickBooks — this only tells the CRM it
            is not a gift. You can re-include it later.
          </DialogDescription>
        </DialogHeader>
        <Select
          value={reason}
          onValueChange={(v) => setReason(v as StagedPaymentExclusionReason)}
          disabled={busy}
        >
          <SelectTrigger>
            <SelectValue placeholder="Choose a reason…" />
          </SelectTrigger>
          <SelectContent>
            {MANUAL_EXCLUSION_FAMILIES.map((group) => (
              <SelectGroup key={group.family}>
                <SelectLabel>{group.family}</SelectLabel>
                {group.reasons.map((value) => (
                  <SelectItem key={value} value={value}>
                    {EXCLUSION_REASON_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => reason && onConfirm(reason)}
            disabled={busy || !reason}
          >
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Exclude
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Splits & pledges queue ───────────────────────────────────────────────────

const FEE_BAND_FLOOR = 0.9;
const FEE_BAND_CEIL = 1.1;

/** Does the applied total sit inside the processor fee-band the split endpoint accepts? */
function withinFeeBand(applied: number, total: number): boolean {
  if (total <= 0) return Math.abs(applied) < 0.005;
  return applied >= total * FEE_BAND_FLOOR - 1 && applied <= total * FEE_BAND_CEIL + 1;
}

/**
 * When the gift (gross) exceeds the QB deposit (net) by an amount that sits
 * inside the processor fee-band, that difference IS the processor fee, not an
 * over-application. Returns the fee, else null.
 */
function feeRemainder(
  paymentTotal: number | null,
  applied: number | null,
): number | null {
  if (paymentTotal == null || applied == null) return null;
  if (applied <= paymentTotal) return null;
  if (!withinFeeBand(applied, paymentTotal)) return null;
  return +(applied - paymentTotal).toFixed(2);
}

function SplitsPledgesQueue({
  cards,
  loading,
  onSplit,
}: {
  cards: ReconciliationCard[];
  loading: boolean;
  onSplit: (card: ReconciliationCard) => void;
}) {
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <Scissors className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Split a payment across gifts</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          One QuickBooks payment that covers several gifts. Open the editor to
          spread it across existing gifts and (optionally) route the remainder to
          a new gift — the balance meter must balance before you can stage it.
        </p>
        {loading ? (
          <LoadingRow />
        ) : cards.length === 0 ? (
          <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
            No staged payments waiting to be split.
          </div>
        ) : (
          <div className="space-y-1.5">
            {cards.map((card) => (
              <div
                key={card.stagedPaymentId}
                className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2 shadow-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {card.payerName ?? "Unknown payer"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {card.dateReceived ?? "—"}
                    {card.qbDocNumber ? ` · #${card.qbDocNumber}` : ""}
                  </div>
                </div>
                <div className="text-right text-lg font-semibold tabular-nums">
                  {money(card.amount)}
                </div>
                <Button size="sm" variant="outline" onClick={() => onSplit(card)}>
                  <Scissors className="mr-1 h-3.5 w-3.5" />
                  Split across gifts
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <Separator />

      <GiftRestructurePanel />

      <Separator />

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Detected gift corrections</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Likely duplicate or mis-split gifts the system has flagged. Apply or
          dismiss each correction at parity with the standalone corrections page.
        </p>
        <div className="rounded-lg border bg-card p-1">
          <FinancialCorrectionsPage />
        </div>
      </section>
    </div>
  );
}

// ─── Split-across-gifts editor (shared application-rows + balance meter) ───────

function SplitEditorDialog({
  card,
  onClose,
  onStage,
}: {
  card: ReconciliationCard;
  onClose: () => void;
  onStage: (
    card: ReconciliationCard,
    body: SplitStagedPaymentBody,
    detail: string,
  ) => void;
}) {
  const paymentTotal = num(card.amount);
  const [rows, setRows] = useState<ReconciliationCandidate[]>([]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ReconciliationCandidate[]>([]);
  const [searching, setSearching] = useState(false);

  const [remainderOn, setRemainderOn] = useState(false);
  const [remAmount, setRemAmount] = useState("");
  const [remDonorType, setRemDonorType] = useState<DonorType>("organization");
  const [remDonorId, setRemDonorId] = useState<string | null>(null);

  const runSearch = useCallback(async () => {
    setSearching(true);
    try {
      const res = await searchReconciliationNode("gift", {
        stagedPaymentId: card.stagedPaymentId,
        q: q.trim() || undefined,
        limit: 20,
      });
      setResults(res.data ?? []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [card.stagedPaymentId, q]);

  const addRow = useCallback((gift: ReconciliationCandidate) => {
    setRows((prev) =>
      prev.some((r) => r.id === gift.id) ? prev : [...prev, gift],
    );
  }, []);
  const removeRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const appliedExisting = rows.reduce((sum, r) => sum + (num(r.amount) ?? 0), 0);
  const remAmountNum = remainderOn ? (num(remAmount) ?? 0) : 0;
  const applied = appliedExisting + remAmountNum;
  const linkCount = rows.length + (remainderOn ? 1 : 0);

  const suggestRemainder = useCallback(() => {
    if (paymentTotal == null) return;
    const leftover = Math.max(0, paymentTotal - appliedExisting);
    setRemAmount(leftover.toFixed(2));
  }, [paymentTotal, appliedExisting]);

  const remainderValid =
    !remainderOn || (remAmountNum > 0 && remDonorId != null);
  const amountOk =
    paymentTotal != null && withinFeeBand(applied, paymentTotal);
  const canStage = linkCount >= 2 && remainderValid && amountOk;

  const handleStage = useCallback(() => {
    if (!canStage) return;
    const donorFields: {
      organizationId?: string | null;
      individualGiverPersonId?: string | null;
      householdId?: string | null;
    } =
      remDonorType === "organization"
        ? { organizationId: remDonorId }
        : remDonorType === "individual"
          ? { individualGiverPersonId: remDonorId }
          : { householdId: remDonorId };
    const body: SplitStagedPaymentBody = {
      giftIds: rows.map((r) => r.id),
      ...(remainderOn
        ? {
            remainderGift: {
              amount: remAmountNum.toFixed(2),
              ...donorFields,
            },
          }
        : {}),
    };
    const detail = `Split across ${linkCount} gifts${remainderOn ? " (incl. new remainder gift)" : ""}`;
    onStage(card, body, detail);
  }, [
    canStage,
    rows,
    remainderOn,
    remAmountNum,
    remDonorType,
    remDonorId,
    linkCount,
    onStage,
    card,
  ]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Split payment across gifts</DialogTitle>
          <DialogDescription>
            {card.payerName ?? "This payment"} ({money(card.amount)}) — link two
            or more existing gifts and/or a new remainder gift. Each existing
            gift is applied at its own booked amount.
          </DialogDescription>
        </DialogHeader>

        {/* Application rows — existing gifts */}
        <div className="space-y-1.5">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Applied to gifts
          </div>
          {rows.length === 0 ? (
            <p className="rounded-md border border-dashed py-4 text-center text-xs text-muted-foreground">
              No gifts added yet — search below and add at least two links.
            </p>
          ) : (
            rows.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{r.label}</div>
                  {r.sublabel && (
                    <div className="truncate text-xs text-muted-foreground">
                      {r.sublabel}
                    </div>
                  )}
                </div>
                <span className="tabular-nums">{money(r.amount)}</span>
                <button
                  type="button"
                  onClick={() => removeRow(r.id)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Gift search */}
        <div className="flex gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
            placeholder="Search gifts by donor or amount…"
          />
          <Button onClick={runSearch} disabled={searching} variant="outline">
            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
          </Button>
        </div>
        {results.length > 0 && (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-1">
            {results.map((g) => {
              const linked = g.alreadyLinkedStagedPaymentId != null;
              const added = rows.some((r) => r.id === g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  disabled={linked || added}
                  onClick={() => addRow(g)}
                  className={cn(
                    "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm",
                    linked || added
                      ? "cursor-not-allowed opacity-50"
                      : "hover:bg-muted",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{g.label}</span>
                    {g.sublabel && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {g.sublabel}
                      </span>
                    )}
                  </span>
                  <span className="ml-2 flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground">
                    {money(g.amount)}
                    {linked ? (
                      <span className="text-[10px]">(linked)</span>
                    ) : added ? (
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Remainder → new gift */}
        <div className="rounded-md border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={remainderOn}
              onCheckedChange={(v) => {
                const on = v === true;
                setRemainderOn(on);
                if (on) suggestRemainder();
              }}
            />
            Route remainder to a new gift
          </label>
          {remainderOn && (
            <div className="mt-3 space-y-3">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <div className="mb-1 text-xs text-muted-foreground">
                    Remainder amount
                  </div>
                  <Input
                    value={remAmount}
                    onChange={(e) => setRemAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="0.00"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={suggestRemainder}
                >
                  Use leftover
                </Button>
              </div>
              <div>
                <div className="mb-1 text-xs text-muted-foreground">
                  New gift donor
                </div>
                <DonorFieldPicker
                  type={remDonorType}
                  id={remDonorId}
                  onChange={(t, id) => {
                    setRemDonorType(t);
                    setRemDonorId(id);
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Balance meter */}
        <div className="rounded-md border">
          <BalanceMeter paymentTotal={paymentTotal} applied={applied} />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleStage} disabled={!canStage}>
            {canStage ? "Stage split" : "Balance to enable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Gift restructuring (merge / pledge) panel ────────────────────────────────

function GiftRestructurePanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadedGifts, setLoadedGifts] = useState<GiftOrPaymentDetail[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<"merge" | "pledge" | "split" | null>(
    null,
  );

  // Debounce the search box so we don't refetch on every keystroke.
  const onSearchChange = useCallback((v: string) => {
    setSearch(v);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const listParams = { search: debounced || undefined, limit: 20, offset: 0 };
  const giftsQuery = useListGiftsAndPayments(listParams, {
    query: {
      enabled: debounced.length > 0,
      queryKey: getListGiftsAndPaymentsQueryKey(listParams),
    },
  });
  const gifts: GiftOrPayment[] = giftsQuery.data?.data ?? [];

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openDialog = useCallback(
    async (which: "merge" | "pledge" | "split") => {
      const ids = [...selected];
      setLoading(true);
      setLoadError(false);
      try {
        const details = await Promise.all(
          ids.map((id) =>
            queryClient.fetchQuery(getGetGiftOrPaymentQueryOptions(id)),
          ),
        );
        setLoadedGifts(details);
      } catch {
        setLoadError(true);
        setLoadedGifts([]);
      } finally {
        setLoading(false);
        setDialog(which);
      }
    },
    [selected, queryClient],
  );

  const closeDialog = useCallback(() => {
    setDialog(null);
    setLoadedGifts([]);
    setLoadError(false);
  }, []);

  const onDone = useCallback(() => {
    closeDialog();
    setSelected(new Set());
    toast({ title: "Gift restructuring applied." });
  }, [closeDialog, toast]);

  const count = selected.size;

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <GitMerge className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Restructure existing gifts</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Find gifts already in the CRM and merge duplicates into one, roll several
        payments up into a pledge, or split one gift into a pledge with
        installments. Pledge stage and paid-amount re-derive on the server.
      </p>

      <div className="relative">
        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search gifts by donor, amount, reference…"
          className="pl-7"
        />
      </div>

      {debounced.length > 0 && (
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-1">
          {giftsQuery.isLoading ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              Searching…
            </p>
          ) : gifts.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No gifts found.
            </p>
          ) : (
            gifts.map((g) => {
              const donor =
                g.organizationName ??
                g.individualGiverPersonName ??
                g.householdName ??
                "—";
              return (
                <label
                  key={g.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <Checkbox
                    checked={selected.has(g.id)}
                    onCheckedChange={() => toggle(g.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {g.name || donor}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {donor} · {g.dateReceived ?? "—"}
                    </span>
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {money(g.amount)}
                  </span>
                </label>
              );
            })
          )}
        </div>
      )}

      {count > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
          <span className="text-sm font-medium">{count} selected</span>
          <Button
            size="sm"
            variant="outline"
            disabled={count < 2 || loading}
            onClick={() => openDialog("merge")}
          >
            <GitMerge className="mr-1 h-3.5 w-3.5" />
            Merge into one
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={count < 1 || loading}
            onClick={() => openDialog("pledge")}
          >
            <Wallet className="mr-1 h-3.5 w-3.5" />
            Merge into pledge
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={count !== 1 || loading}
            onClick={() => openDialog("split")}
          >
            <Split className="mr-1 h-3.5 w-3.5" />
            Split into pledge
          </Button>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        </div>
      )}

      {dialog === "merge" && (
        <MergeGiftsDialog
          open
          onOpenChange={(o) => !o && closeDialog()}
          gifts={loadedGifts}
          expectedCount={count}
          loadError={loadError}
          onDone={onDone}
        />
      )}
      {dialog === "pledge" && (
        <MergeIntoPledgeDialog
          open
          onOpenChange={(o) => !o && closeDialog()}
          gifts={loadedGifts}
          expectedCount={count}
          loadError={loadError}
          onDone={() => onDone()}
        />
      )}
      {dialog === "split" && loadedGifts[0] && (
        <SplitGiftIntoPledgeDialog
          open
          onOpenChange={(o) => !o && closeDialog()}
          gift={loadedGifts[0]}
          onDone={() => onDone()}
        />
      )}
    </section>
  );
}
