import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListOpportunitiesAndPledgesQueryKey,
  getListWorkbenchClustersQueryKey,
  getListWorkbenchRecentChangesQueryKey,
  useConfirmSettlementLink,
  useConfirmStripeRefundPropagation,
  useCreateGiftFromStagedPayment,
  useCreateGiftFromStripeStagedCharge,
  useDismissStripeRefundPropagation,
  useExcludeStagedPayment,
  useExcludeStripeStagedCharge,
  useGetCurrentUser,
  useLinkStripeChargeToGift,
  useRejectChargeQbTie,
  useRejectSettlementProposal,
  useRevertStripePayoutReconciliation,
  useListWorkbenchClusters,
  useListWorkbenchRecentChanges,
  useReIncludeStagedPayment,
  useReIncludeStripeStagedCharge,
  useReconcileStagedPayment,
  useResolveStagedPayment,
  useResolveStripeStagedCharge,
  useRevertStagedPayment,
  useRevertStripeStagedCharge,
  useUpdateOpportunityOrPledge,
  type GiftOrPayment,
  type StagedPaymentExclusionReason,
  type WorkbenchClusterQbRecord,
  type WorkbenchLens,
  type WorkbenchRecentChange,
} from "@workspace/api-client-react";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useToast } from "@/hooks/use-toast";
import { GiftSearchDialog } from "@/components/gift-search-dialog";
import { FlagForResearchDialog } from "@/components/flag-for-research-dialog";
import {
  ResolveTieDialog,
  type PickOptions,
} from "@/components/reconciliation-bundles/ResolveTieDialog";
import {
  apiErrorMessage,
  is409,
  isPermanentSettlementError,
} from "@/components/reconciliation-bundles/settlement-actions";
import { extractStripeSourceConflict, type StripeSourceConflict } from "@/lib/reconciliation";
import type { DonorType } from "@/components/entity-picker";
import {
  DonorResolveDialog,
  ExcludeReasonDialog,
  QbRecordDetailDialog,
  UnlinkChooserDialog,
  type EvidencePreview,
  type UnlinkOption,
} from "@/components/reconciliation-clusters/dialogs";
import {
  ClusterRow,
  GridHeader,
  type AnchorRef,
  type ClusterActions,
} from "@/components/reconciliation-clusters/rows";
import { AlertCircle, ChevronLeft, ChevronRight, Search } from "lucide-react";

// ─── Reconciliation cluster workbench ────────────────────────────────────────
// One unified list: every piece of money work is ONE row (cluster) carrying all
// three facets — CRM gifts, transaction evidence, bank & accounting records —
// with the money math in between. Donor-slot actions, per-card menus, and the
// prefilled create-gift dialog are wired to the same endpoints as the queue
// workbench; split lenses and the recent-changes rail are later phases.

const PAGE_SIZE = 25;

const LENSES: { id: WorkbenchLens; label: string }[] = [
  { id: "all_open", label: "All unresolved" },
  { id: "needs_donor_or_gift", label: "Missing donor" },
  { id: "needs_accounting", label: "Missing accounting record" },
  { id: "settlement_gaps", label: "Settlement gaps" },
  { id: "conflicts", label: "Conflicts" },
  { id: "refunds", label: "Refunds" },
  { id: "excluded_qb_says_donation", label: "Excluded · QB says donation" },
  { id: "excluded", label: "Excluded" },
  { id: "completed", label: "Completed" },
  { id: "link_complete", label: "Linkage complete" },
  { id: "attention_required", label: "Attention required" },
  { id: "crm_only", label: "CRM only" },
];

function errMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const msg = (data as { message?: unknown }).message;
      if (typeof msg === "string" && msg) return msg;
    }
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg) return msg;
  }
  return "Something went wrong.";
}

// Compact timestamp for the recent-changes rail ("Jul 16, 2:05 PM").
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** All 3 donor FKs, null-others — keeps the Donor XOR merged-state check happy. */
function donorBody(type: DonorType, id: string) {
  return {
    organizationId: type === "organization" ? id : null,
    individualGiverPersonId: type === "individual" ? id : null,
    householdId: type === "household" ? id : null,
  };
}

export default function ReconciliationClustersPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: me } = useGetCurrentUser();

  const [lens, setLens] = useState<WorkbenchLens>("all_open");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Action dialog state — at most one flow open at a time.
  const [linkGiftFor, setLinkGiftFor] = useState<AnchorRef | null>(null);
  const [chargeConflict, setChargeConflict] = useState<{
    chargeId: string;
    giftId: string;
    label: string;
    conflict: StripeSourceConflict;
  } | null>(null);
  const [createFor, setCreateFor] = useState<{
    anchor: AnchorRef;
    preview: EvidencePreview;
  } | null>(null);
  const [identifyFor, setIdentifyFor] = useState<{
    anchor: AnchorRef;
    preview: EvidencePreview | null;
  } | null>(null);
  const [excludeFor, setExcludeFor] = useState<AnchorRef | null>(null);
  const [revertFor, setRevertFor] = useState<{
    anchor: AnchorRef;
    description: string;
  } | null>(null);
  const [refundFor, setRefundFor] = useState<{
    chargeId: string;
    kind: "refund" | "chargeback";
    label: string;
  } | null>(null);
  const [dismissFor, setDismissFor] = useState<{
    chargeId: string;
    label: string;
  } | null>(null);
  const [flagFor, setFlagFor] = useState<{
    stagedPaymentId: string;
    label: string;
  } | null>(null);
  const [flagGiftFor, setFlagGiftFor] = useState<{
    giftId: string;
    label: string;
  } | null>(null);
  const [markLossFor, setMarkLossFor] = useState<{
    opportunityId: string;
    kind: "lost" | "dormant";
    label: string;
  } | null>(null);
  const [settlementSearchFor, setSettlementSearchFor] = useState<{
    payoutId: string;
    amount: string | null;
    date: string | null;
  } | null>(null);
  const [qbDetailFor, setQbDetailFor] = useState<WorkbenchClusterQbRecord | null>(null);
  const [revertSettlementFor, setRevertSettlementFor] = useState<{
    payoutId: string;
    label: string;
    /** When set, this is a "Replace settlement relationship": after a successful revert, re-open the deposit search seeded with these values. */
    replaceSearch?: { amount: string | null; date: string | null };
  } | null>(null);
  const [unlinkChooserFor, setUnlinkChooserFor] = useState<{
    giftLabel: string;
    options: UnlinkOption[];
  } | null>(null);

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
  const { data: recentData, isLoading: recentLoading } =
    useListWorkbenchRecentChanges();

  const clusters = data?.data ?? [];
  const counts = data?.lensCounts;
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── Mutations (charge + staged flavors of each verb) ──────────────────────
  const linkChargeM = useLinkStripeChargeToGift();
  const resolveChargeM = useResolveStripeStagedCharge();
  const createChargeGiftM = useCreateGiftFromStripeStagedCharge();
  const excludeChargeM = useExcludeStripeStagedCharge();
  const reIncludeChargeM = useReIncludeStripeStagedCharge();
  const revertChargeM = useRevertStripeStagedCharge();
  const confirmRefundM = useConfirmStripeRefundPropagation();
  const dismissRefundM = useDismissStripeRefundPropagation();

  const reconcileM = useReconcileStagedPayment();
  const resolveStagedM = useResolveStagedPayment();
  const createStagedGiftM = useCreateGiftFromStagedPayment();
  const excludeStagedM = useExcludeStagedPayment();
  const reIncludeStagedM = useReIncludeStagedPayment();
  const revertStagedM = useRevertStagedPayment();
  const updateOppM = useUpdateOpportunityOrPledge();
  const confirmSettlementM = useConfirmSettlementLink();
  const rejectChargeQbTieM = useRejectChargeQbTie();
  const rejectSettlementProposalM = useRejectSettlementProposal();
  const revertStripePayoutReconciliationM = useRevertStripePayoutReconciliation();

  const busy =
    linkChargeM.isPending ||
    resolveChargeM.isPending ||
    createChargeGiftM.isPending ||
    excludeChargeM.isPending ||
    reIncludeChargeM.isPending ||
    revertChargeM.isPending ||
    confirmRefundM.isPending ||
    dismissRefundM.isPending ||
    reconcileM.isPending ||
    resolveStagedM.isPending ||
    createStagedGiftM.isPending ||
    excludeStagedM.isPending ||
    reIncludeStagedM.isPending ||
    revertStagedM.isPending ||
    updateOppM.isPending ||
    confirmSettlementM.isPending ||
    rejectChargeQbTieM.isPending ||
    rejectSettlementProposalM.isPending ||
    revertStripePayoutReconciliationM.isPending;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: getListWorkbenchClustersQueryKey(),
    });
    void queryClient.invalidateQueries({ queryKey: ["/api/gifts-and-payments"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/staged-payments"] });
    void queryClient.invalidateQueries({
      queryKey: ["/api/stripe-staged-charges"],
    });
    void queryClient.invalidateQueries({
      queryKey: getListWorkbenchRecentChangesQueryKey(),
    });
  }, [queryClient]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handlePickGift = async (gift: GiftOrPayment) => {
    if (!linkGiftFor) return;
    const anchor = linkGiftFor;
    try {
      if (anchor.kind === "charge") {
        await linkChargeM.mutateAsync({
          id: anchor.id,
          data: { giftId: gift.id },
        });
      } else {
        await reconcileM.mutateAsync({
          id: anchor.id,
          data: { giftId: gift.id },
        });
      }
      setLinkGiftFor(null);
      invalidate();
      toast({ title: "Linked", description: `${anchor.label} is now linked to the gift.` });
    } catch (err) {
      if (anchor.kind === "charge") {
        const conflict = extractStripeSourceConflict(err);
        if (conflict) {
          setLinkGiftFor(null);
          setChargeConflict({
            chargeId: anchor.id,
            giftId: gift.id,
            label: anchor.label,
            conflict,
          });
          return;
        }
      }
      toast({
        title: "Couldn't link",
        description: errMessage(err),
        variant: "destructive",
      });
    }
  };

  const handleConfirmSwitch = async () => {
    if (!chargeConflict) return;
    try {
      await linkChargeM.mutateAsync({
        id: chargeConflict.chargeId,
        data: { giftId: chargeConflict.giftId, switchStripeSource: true },
      });
      setChargeConflict(null);
      invalidate();
      toast({ title: "Linked", description: "The gift's Stripe source was switched." });
    } catch (err) {
      toast({
        title: "Couldn't switch",
        description: errMessage(err),
        variant: "destructive",
      });
    }
  };

  const handleCreateGift = async (donorType: DonorType, donorId: string) => {
    if (!createFor) return;
    const { anchor } = createFor;
    const body = donorBody(donorType, donorId);
    try {
      if (anchor.kind === "charge") {
        await resolveChargeM.mutateAsync({ id: anchor.id, data: body });
        await createChargeGiftM.mutateAsync({ id: anchor.id });
      } else {
        await resolveStagedM.mutateAsync({ id: anchor.id, data: body });
        await createStagedGiftM.mutateAsync({ id: anchor.id });
      }
      setCreateFor(null);
      invalidate();
      toast({
        title: "Gift created",
        description: `A donation record was minted from ${anchor.label} and linked.`,
      });
    } catch (err) {
      // The donor resolve may have succeeded even if the gift create failed —
      // refetch so the row reflects the server-side state.
      invalidate();
      toast({
        title: "Couldn't create the gift",
        description: errMessage(err),
        variant: "destructive",
      });
    }
  };

  const handleIdentify = async (donorType: DonorType, donorId: string) => {
    if (!identifyFor) return;
    const { anchor } = identifyFor;
    const body = donorBody(donorType, donorId);
    try {
      if (anchor.kind === "charge") {
        await resolveChargeM.mutateAsync({ id: anchor.id, data: body });
      } else {
        await resolveStagedM.mutateAsync({ id: anchor.id, data: body });
      }
      setIdentifyFor(null);
      invalidate();
      toast({
        title: "Donor set",
        description: `${anchor.label} now carries the donor — no gift was created yet.`,
      });
    } catch (err) {
      toast({
        title: "Couldn't set the donor",
        description: errMessage(err),
        variant: "destructive",
      });
    }
  };

  const handleExclude = async (reason: StagedPaymentExclusionReason) => {
    if (!excludeFor) return;
    const anchor = excludeFor;
    try {
      if (anchor.kind === "charge") {
        await excludeChargeM.mutateAsync({
          id: anchor.id,
          data: { exclusionReason: reason },
        });
      } else {
        await excludeStagedM.mutateAsync({
          id: anchor.id,
          data: { exclusionReason: reason },
        });
      }
      setExcludeFor(null);
      invalidate();
      toast({ title: "Excluded", description: `${anchor.label} was filed as not a donation.` });
    } catch (err) {
      toast({
        title: "Couldn't exclude",
        description: errMessage(err),
        variant: "destructive",
      });
    }
  };

  const handleReInclude = async (anchor: AnchorRef) => {
    try {
      if (anchor.kind === "charge") {
        await reIncludeChargeM.mutateAsync({ id: anchor.id });
      } else {
        await reIncludeStagedM.mutateAsync({ id: anchor.id });
      }
      invalidate();
      toast({ title: "Re-included", description: `${anchor.label} is back in the open queue.` });
    } catch (err) {
      toast({
        title: "Couldn't re-include",
        description: errMessage(err),
        variant: "destructive",
      });
    }
  };

  const handleRevert = async () => {
    if (!revertFor) return;
    const { anchor } = revertFor;
    try {
      if (anchor.kind === "charge") {
        await revertChargeM.mutateAsync({ id: anchor.id });
      } else {
        await revertStagedM.mutateAsync({ id: anchor.id });
      }
      setRevertFor(null);
      invalidate();
      toast({ title: "Unlinked", description: `${anchor.label} is pending again.` });
    } catch (err) {
      toast({
        title: "Couldn't unlink",
        description: errMessage(err),
        variant: "destructive",
      });
    }
  };

  // Undo dispatch: the rail entry names which EXISTING revert/re-include
  // endpoint reverses it and on which row. The server recorded the pointer at
  // action time; the target endpoint still enforces its own guards, so a stale
  // pointer (state moved on) comes back as a clean 409 toast.
  const handleUndo = async (change: WorkbenchRecentChange) => {
    const undo = change.undo;
    if (!undo) return;
    try {
      if (undo.kind === "revert_staged_payment") {
        await revertStagedM.mutateAsync({ id: undo.targetId });
      } else if (undo.kind === "reinclude_staged_payment") {
        await reIncludeStagedM.mutateAsync({ id: undo.targetId });
      } else if (undo.kind === "revert_stripe_charge") {
        await revertChargeM.mutateAsync({ id: undo.targetId });
      } else {
        await reIncludeChargeM.mutateAsync({ id: undo.targetId });
      }
      toast({
        title: "Undone",
        description: "The action was reversed; the row is back in its queue.",
      });
    } catch (err) {
      toast({
        title: "Couldn't undo",
        description: errMessage(err),
        variant: "destructive",
      });
    } finally {
      // Refresh even on a 409 so a stale Undo pointer self-heals off the rail.
      invalidate();
    }
  };

  const handleConfirmRefund = async () => {
    if (!refundFor) return;
    try {
      await confirmRefundM.mutateAsync({ id: refundFor.chargeId });
      setRefundFor(null);
      invalidate();
      toast({
        title: refundFor.kind === "chargeback" ? "Chargeback confirmed" : "Refund confirmed",
        description:
          "The transaction no longer counts as live payment evidence. The linked gift is unchanged.",
      });
    } catch (err) {
      toast({
        title: "Couldn't confirm",
        description: errMessage(err),
        variant: "destructive",
      });
    }
  };

  const handleDismissRefund = async () => {
    if (!dismissFor) return;
    try {
      await dismissRefundM.mutateAsync({ id: dismissFor.chargeId });
      setDismissFor(null);
      invalidate();
      toast({
        title: "Proposal dismissed",
        description: "The gift stays as booked.",
      });
    } catch (err) {
      toast({
        title: "Couldn't dismiss",
        description: errMessage(err),
        variant: "destructive",
      });
    }
  };

  // Mark the gift's opportunity lost/dormant: the user-set loss_type is the
  // ONE lifecycle input and it outranks the payment-driven cash_in status —
  // the confirm dialog spells that out before writing.
  const handleMarkLoss = async () => {
    if (!markLossFor) return;
    try {
      await updateOppM.mutateAsync({
        id: markLossFor.opportunityId,
        data: { lossType: markLossFor.kind },
      });
      setMarkLossFor(null);
      invalidate();
      void queryClient.invalidateQueries({
        queryKey: getListOpportunitiesAndPledgesQueryKey(),
      });
      toast({
        title: markLossFor.kind === "lost" ? "Marked lost" : "Marked dormant",
        description: `The opportunity behind ${markLossFor.label} now shows ${markLossFor.kind}.`,
      });
    } catch (err) {
      toast({
        title: "Couldn't update the opportunity",
        description: errMessage(err),
        variant: "destructive",
      });
    }
  };

  // Tie the picked QB deposit to the payout and approve — same endpoint and
  // 409 split as the Settlement report's resolve flow: permanent conflicts
  // are destructive toasts, transient state changes just ask to retry.
  const handleSettlementPick = async (
    counterpartId: string,
    opts?: PickOptions,
  ) => {
    if (!settlementSearchFor) return;
    try {
      await confirmSettlementM.mutateAsync({
        payoutId: settlementSearchFor.payoutId,
        data: {
          depositStagedPaymentId: counterpartId,
          ...(opts?.overrideExclusion ? { overrideExclusion: true } : {}),
        },
      });
      setSettlementSearchFor(null);
      invalidate();
      toast({ title: "Settlement approved." });
    } catch (err) {
      if (is409(err)) {
        if (isPermanentSettlementError(err)) {
          toast({
            title: "Couldn't resolve this settlement",
            description: apiErrorMessage(err) ?? errMessage(err),
            variant: "destructive",
          });
        } else {
          toast({
            title: "The settlement changed — try resolving again.",
            description: apiErrorMessage(err) ?? undefined,
          });
          invalidate();
        }
      } else {
        toast({
          title: "Couldn't resolve",
          description: errMessage(err),
          variant: "destructive",
        });
      }
    }
  };

  const handleRejectChargeQbTie = async (chargeId: string) => {
    try {
      await rejectChargeQbTieM.mutateAsync({ chargeId });
      invalidate();
      toast({ title: "QB tie dismissed", description: "The proposed charge–QB link was cleared." });
    } catch (err) {
      toast({ title: "Couldn't dismiss QB tie", description: errMessage(err), variant: "destructive" });
    }
  };

  const handleRemoveSettlementProposal = async (payoutId: string) => {
    try {
      await rejectSettlementProposalM.mutateAsync({ payoutId });
      invalidate();
      toast({ title: "Proposal removed", description: "The settlement proposal was cleared; the payout is back to unlinked." });
    } catch (err) {
      toast({ title: "Couldn't remove proposal", description: errMessage(err), variant: "destructive" });
    }
  };

  const handleRevertSettlement = async () => {
    if (!revertSettlementFor) return;
    const { payoutId, replaceSearch } = revertSettlementFor;
    try {
      await revertStripePayoutReconciliationM.mutateAsync({ id: payoutId });
      setRevertSettlementFor(null);
      invalidate();
      if (replaceSearch) {
        // Replace flow: the wrong settlement is now unwound — go straight into
        // the deposit search so the right one can be picked and confirmed.
        setSettlementSearchFor({ payoutId, ...replaceSearch });
        toast({ title: "Settlement reverted", description: "Pick the correct QuickBooks deposit to complete the replacement." });
      } else {
        toast({ title: "Settlement reverted", description: "The confirmed settlement was reverted to proposed." });
      }
    } catch (err) {
      toast({ title: "Couldn't revert settlement", description: errMessage(err), variant: "destructive" });
    }
  };

  const actions: ClusterActions = {
    busy,
    openLinkGift: (anchor) => setLinkGiftFor(anchor),
    openCreateGift: (anchor, preview) => setCreateFor({ anchor, preview }),
    openIdentify: (anchor, preview) => setIdentifyFor({ anchor, preview }),
    openExclude: (anchor) => setExcludeFor(anchor),
    reInclude: (anchor) => void handleReInclude(anchor),
    openRevert: (anchor, description) => setRevertFor({ anchor, description }),
    openConfirmRefund: (chargeId, kind, label) =>
      setRefundFor({ chargeId, kind, label }),
    openDismissRefund: (chargeId, label) => setDismissFor({ chargeId, label }),
    openFlag: (stagedPaymentId, label) => setFlagFor({ stagedPaymentId, label }),
    openFlagGift: (giftId, label) => setFlagGiftFor({ giftId, label }),
    openMarkLoss: (opportunityId, kind, label) =>
      setMarkLossFor({ opportunityId, kind, label }),
    openSettlementSearch: (args) => setSettlementSearchFor(args),
    isFinanceOrAdmin: me?.role === "finance" || me?.role === "admin",
    openQbDetail: (record) => setQbDetailFor(record),
    removeSettlementProposal: (payoutId, _label) => void handleRemoveSettlementProposal(payoutId),
    revertSettlement: (payoutId, label) => setRevertSettlementFor({ payoutId, label }),
    replaceSettlement: (payoutId, label, search) =>
      setRevertSettlementFor({ payoutId, label, replaceSearch: search }),
    rejectChargeQbTie: (chargeId) => void handleRejectChargeQbTie(chargeId),
    openUnlinkChooser: (giftLabel, options) =>
      setUnlinkChooserFor({ giftLabel, options }),
  };

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            Reconciliation
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Every piece of money work as one row — the CRM gift, the processor
            transactions, and the bank &amp; accounting records it reconciles
            against, with the money math in between.
          </p>
        </div>
      </div>

      <div className="flex gap-4 items-start">
        <main className="flex-1 min-w-0 space-y-3">
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
              <span
                className="ml-auto text-sm text-muted-foreground"
                data-testid="text-cluster-total"
              >
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
            <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
              <GridHeader />
              {clusters.map((c) => (
                <ClusterRow
                  key={c.id}
                  cluster={c}
                  expanded={expanded.has(c.id)}
                  onToggle={() => toggleExpanded(c.id)}
                  actions={actions}
                />
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
        </main>

        {/* Right rail: lenses */}
        <aside className="w-60 shrink-0 space-y-3 sticky top-4 hidden lg:block">
          <div className="rounded-lg border bg-card p-3">
            <h2 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
              Lenses
            </h2>
            <nav className="space-y-0.5" data-testid="cluster-lens-rail">
              {LENSES.map((l) => {
                const active = l.id === lens;
                const count = counts?.[l.id];
                return (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => {
                      setLens(l.id);
                      setPage(1);
                    }}
                    className={`flex items-center justify-between w-full px-2.5 py-1.5 rounded-md text-xs font-medium ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                    data-testid={`button-lens-${l.id}`}
                  >
                    {l.label}
                    {count != null ? (
                      <span
                        className={`text-[11px] tabular-nums font-semibold ${
                          active ? "opacity-80" : "text-muted-foreground/70"
                        }`}
                      >
                        {count.toLocaleString()}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </nav>
          </div>
          <div
            className="rounded-lg border bg-card p-3"
            data-testid="recent-changes-rail"
          >
            <h2 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
              Recent changes
            </h2>
            {recentLoading ? (
              <p className="text-[11px] text-muted-foreground">Loading…</p>
            ) : !recentData?.items.length ? (
              <p className="text-[11px] text-muted-foreground">
                No reconciliation actions recorded yet.
              </p>
            ) : (
              <ul className="space-y-2 max-h-80 overflow-y-auto pr-0.5">
                {recentData.items.map((c) => (
                  <li
                    key={c.id}
                    className="text-[11px] leading-snug"
                    data-testid={`recent-change-${c.id}`}
                  >
                    <p className="text-foreground">{c.summary}</p>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <span className="text-muted-foreground truncate">
                        {c.actorName ?? "System"} · {formatWhen(c.at)}
                      </span>
                      {c.undo ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 px-1.5 text-[10px] shrink-0"
                          disabled={busy}
                          onClick={() => void handleUndo(c)}
                          data-testid={`button-undo-${c.id}`}
                        >
                          Undo
                        </Button>
                      ) : (
                        <span
                          className="text-[10px] text-muted-foreground/50 shrink-0 cursor-not-allowed"
                          title="No one-click undo — this kind of action can't be safely reversed in a single step."
                        >
                          No undo
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-lg border bg-card p-3 text-[11px] text-muted-foreground leading-relaxed">
            <AlertCircle className="w-3 h-3 inline mr-1" />
            Expand a Stripe payout row to see each charge paired with its gift.
            Cards carry their own ⋯ menus; the row-end ⋯ links back to the
            queue workbench for bulk work.
          </div>
        </aside>
      </div>

      {/* Small-screen lens strip (rail hides below lg) */}
      <div className="flex flex-wrap gap-1.5 lg:hidden">
        {LENSES.map((l) => (
          <Button
            key={l.id}
            variant={l.id === lens ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setLens(l.id);
              setPage(1);
            }}
          >
            {l.label}
            {counts?.[l.id] != null ? (
              <span className="ml-1.5 text-xs tabular-nums">
                {counts[l.id].toLocaleString()}
              </span>
            ) : null}
          </Button>
        ))}
      </div>

      {/* ── Action dialogs ── */}
      <GiftSearchDialog
        open={linkGiftFor != null}
        onOpenChange={(v) => (!v ? setLinkGiftFor(null) : null)}
        onPick={(gift) => void handlePickGift(gift)}
        busy={busy}
        title="Link to an existing gift"
        description={
          linkGiftFor
            ? `Pick the CRM donation record that ${linkGiftFor.label} pays.`
            : undefined
        }
      />

      <DonorResolveDialog
        open={createFor != null}
        onOpenChange={(v) => (!v ? setCreateFor(null) : null)}
        mode="create"
        recordLabel={createFor?.anchor.label ?? ""}
        preview={createFor?.preview ?? null}
        busy={busy}
        onSubmit={(t, id) => void handleCreateGift(t, id)}
      />

      <DonorResolveDialog
        open={identifyFor != null}
        onOpenChange={(v) => (!v ? setIdentifyFor(null) : null)}
        mode="identify"
        recordLabel={identifyFor?.anchor.label ?? ""}
        preview={identifyFor?.preview ?? null}
        busy={busy}
        onSubmit={(t, id) => void handleIdentify(t, id)}
      />

      <ExcludeReasonDialog
        open={excludeFor != null}
        onOpenChange={(v) => (!v ? setExcludeFor(null) : null)}
        recordLabel={excludeFor?.label ?? "this record"}
        busy={busy}
        onSubmit={(reason) => void handleExclude(reason)}
      />

      {/* Stripe-source conflict: the picked gift is already backed by another charge */}
      <AlertDialog
        open={chargeConflict != null}
        onOpenChange={(v) => (!v && !busy ? setChargeConflict(null) : null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Gift already has a Stripe source</AlertDialogTitle>
            <AlertDialogDescription>
              {chargeConflict?.conflict.currentCharge ? (
                <>
                  This gift is currently backed by Stripe charge{" "}
                  <span className="font-medium">
                    {chargeConflict.conflict.currentCharge.payerName ??
                      chargeConflict.conflict.currentCharge.id}
                  </span>
                  {chargeConflict.conflict.currentCharge.amount != null
                    ? ` (${formatCurrency(chargeConflict.conflict.currentCharge.amount)}`
                    : ""}
                  {chargeConflict.conflict.currentCharge.date
                    ? ` · ${formatDateShort(chargeConflict.conflict.currentCharge.date)})`
                    : chargeConflict.conflict.currentCharge.amount != null
                      ? ")"
                      : ""}
                  . Switching re-points it to {chargeConflict.label} and returns
                  the old charge to pending.
                </>
              ) : (
                <>
                  This gift is already backed by a different Stripe charge.
                  Switching re-points it to {chargeConflict?.label} and returns
                  the old charge to pending.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => void handleConfirmSwitch()}
              data-testid="button-confirm-switch-source"
            >
              Switch source
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Unlink / revert confirm */}
      <AlertDialog
        open={revertFor != null}
        onOpenChange={(v) => (!v && !busy ? setRevertFor(null) : null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink this match?</AlertDialogTitle>
            <AlertDialogDescription>{revertFor?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => void handleRevert()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-revert"
            >
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Unlink relationship chooser — a gift with MULTIPLE linked evidence
          records picks exactly one relationship, then falls through to the
          same revert confirm above. */}
      <UnlinkChooserDialog
        open={unlinkChooserFor != null}
        onOpenChange={(v) => (!v ? setUnlinkChooserFor(null) : null)}
        giftLabel={unlinkChooserFor?.giftLabel ?? ""}
        options={unlinkChooserFor?.options ?? []}
        busy={busy}
        onPick={(option) => {
          const giftLabel = unlinkChooserFor?.giftLabel ?? "this gift";
          setUnlinkChooserFor(null);
          setRevertFor({
            anchor: option.anchor,
            description: option.note
              ? `Unlink “${giftLabel}” from ${option.source}. ${option.note} If the gift was minted from this evidence it is deleted; a pre-existing gift is kept and just unlinked.`
              : `Unlink “${giftLabel}” from ${option.source}. Only this relationship is removed — other links stay. If the gift was minted from this evidence it is deleted; a pre-existing gift is kept and just unlinked.`,
          });
        }}
      />

      {/* Refund confirm */}
      <AlertDialog
        open={refundFor != null}
        onOpenChange={(v) => (!v && !busy ? setRefundFor(null) : null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Confirm {refundFor?.kind === "chargeback" ? "chargeback" : "refund"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This marks {refundFor?.label} as refunded: the transaction stops
              counting as live payment evidence. The linked gift and its
              allocations are not changed — link a replacement payment later,
              or mark the opportunity lost or dormant as a separate decision.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => void handleConfirmRefund()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-refund"
            >
              Mark refunded
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Refund dismiss */}
      <AlertDialog
        open={dismissFor != null}
        onOpenChange={(v) => (!v && !busy ? setDismissFor(null) : null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dismiss the reversal proposal?</AlertDialogTitle>
            <AlertDialogDescription>
              The proposal on {dismissFor?.label} is set aside and the gift
              stays as booked. It will not be re-proposed automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => void handleDismissRefund()}
              data-testid="button-dismiss-refund"
            >
              Dismiss proposal
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {flagFor ? (
        <FlagForResearchDialog
          targetType="staged_payment"
          targetId={flagFor.stagedPaymentId}
          recordLabel={flagFor.label}
          open
          onOpenChange={(v) => (!v ? setFlagFor(null) : null)}
          hideTrigger
        />
      ) : null}

      {flagGiftFor ? (
        <FlagForResearchDialog
          targetType="gift"
          targetId={flagGiftFor.giftId}
          recordLabel={flagGiftFor.label}
          open
          onOpenChange={(v) => (!v ? setFlagGiftFor(null) : null)}
          hideTrigger
        />
      ) : null}

      {/* Mark lost / dormant — writes loss_type on the gift's OPPORTUNITY */}
      <AlertDialog
        open={markLossFor != null}
        onOpenChange={(v) => (!v && !busy ? setMarkLossFor(null) : null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Mark this opportunity {markLossFor?.kind === "lost" ? "lost" : "dormant"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This sets the loss type on the whole opportunity behind{" "}
              {markLossFor?.label} — not just this gift. The loss type outranks
              every other status signal: even if payments were received, the
              opportunity will show{" "}
              {markLossFor?.kind === "lost" ? "lost" : "dormant"} instead of
              cash-in until the loss type is cleared on the opportunity page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                // Keep the dialog open while the save runs (Radix closes on
                // click by default) — handleMarkLoss closes it on success.
                e.preventDefault();
                void handleMarkLoss();
              }}
              className={
                markLossFor?.kind === "lost"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
              data-testid="button-confirm-mark-loss"
            >
              Mark {markLossFor?.kind === "lost" ? "lost" : "dormant"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* QB-deposit search → confirm settlement link (same flow as the
          Settlement report's resolve dialog) */}
      {settlementSearchFor ? (
        <ResolveTieDialog
          anchor={{
            anchorId: settlementSearchFor.payoutId,
            amount: settlementSearchFor.amount,
            date: settlementSearchFor.date,
          }}
          open
          onOpenChange={(v) => (!v ? setSettlementSearchFor(null) : null)}
          onPick={(id, opts) => void handleSettlementPick(id, opts)}
          busy={busy}
        />
      ) : null}

      {/* Revert confirmed settlement — confirm before acting (irreversible if charges are booked) */}
      <AlertDialog open={!!revertSettlementFor} onOpenChange={(v) => { if (!v) setRevertSettlementFor(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {revertSettlementFor?.replaceSearch
                ? "Replace settlement relationship?"
                : "Revert confirmed settlement?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will undo the confirmed payout reconciliation for{" "}
              <strong>{revertSettlementFor?.label ?? "this deposit"}</strong> and return it to a
              proposed state.
              {revertSettlementFor?.replaceSearch
                ? " The deposit search will then open so you can pick and confirm the correct QuickBooks deposit."
                : ""}{" "}
              The server will refuse if any of the payout’s Stripe charges have
              already been booked into a gift.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleRevertSettlement()}
              data-testid="button-confirm-revert-settlement"
            >
              {revertSettlementFor?.replaceSearch ? "Revert and re-search" : "Revert settlement"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <QbRecordDetailDialog
        open={!!qbDetailFor}
        onOpenChange={(v) => { if (!v) setQbDetailFor(null); }}
        record={qbDetailFor}
      />
    </div>
  );
}
