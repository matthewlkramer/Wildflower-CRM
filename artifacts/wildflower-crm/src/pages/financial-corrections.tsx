import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFinancialCorrections,
  getListFinancialCorrectionsQueryKey,
  useDismissFinancialCorrection,
  useApplyFinancialCorrection,
  useMergeGiftsAndPayments,
  type FinancialCorrection,
  type FinancialCorrectionGift,
  type FinancialCorrectionEvidence,
} from "@workspace/api-client-react";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

// Query-key prefixes for invalidation. The generated keys are prefixed with
// "/api" (see orval baseUrl), so invalidation must include it to match.
const FC_KEY_PREFIX = "/api/financial-corrections";
const GIFTS_KEY_PREFIX = "/api/gifts-and-payments";

const KIND_LABEL: Record<string, string> = {
  merge_gifts: "Duplicate / mis-split gifts",
  link_evidence: "Bulk deposit",
};

const EVIDENCE_SOURCE_LABEL: Record<string, string> = {
  qb_staged: "QuickBooks",
  stripe_charge: "Stripe",
};

const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : "Something went wrong.";

function GiftLine({
  gift,
  isPrimary,
}: {
  gift: FinancialCorrectionGift;
  isPrimary?: boolean;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-sm"
      data-testid={`correction-gift-${gift.id}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Link
          href={`/gifts/${gift.id}`}
          className="truncate font-medium text-primary underline-offset-2 hover:underline"
          data-testid={`link-correction-gift-${gift.id}`}
        >
          {gift.donorName || "Unknown donor"}
        </Link>
        {isPrimary ? <Badge variant="secondary">Survivor</Badge> : null}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {formatCurrency(gift.amount)}
        </span>
        <span>{formatDateShort(gift.date ?? null)}</span>
        <span>
          {gift.allocationCount}{" "}
          {gift.allocationCount === 1 ? "allocation" : "allocations"}
        </span>
      </div>
    </div>
  );
}

function EvidenceCard({ evidence }: { evidence: FinancialCorrectionEvidence }) {
  return (
    <div
      className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm"
      data-testid={`correction-evidence-${evidence.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline">
            {EVIDENCE_SOURCE_LABEL[evidence.kind] ?? evidence.kind}
          </Badge>
          <span className="font-medium text-foreground">
            {evidence.payerName || "—"}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {formatCurrency(evidence.amount)}
          </span>
          <span>{formatDateShort(evidence.date ?? null)}</span>
          {evidence.entityName ? <span>{evidence.entityName}</span> : null}
        </div>
      </div>
    </div>
  );
}

export default function FinancialCorrectionsPage() {
  const isAdmin = useIsAdmin();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const params = { limit: 100 } as const;
  const { data, isLoading, isError } = useListFinancialCorrections(params, {
    query: {
      enabled: isAdmin,
      queryKey: getListFinancialCorrectionsQueryKey(params),
    },
  });

  const dismissMut = useDismissFinancialCorrection();
  const applyMut = useApplyFinancialCorrection();
  const mergeMut = useMergeGiftsAndPayments();

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pendingMerge, setPendingMerge] = useState<FinancialCorrection | null>(
    null,
  );

  const corrections = useMemo<FinancialCorrection[]>(
    () => data?.corrections ?? [],
    [data],
  );

  const invalidate = (alsoGifts: boolean) => {
    void queryClient.invalidateQueries({ queryKey: [FC_KEY_PREFIX] });
    if (alsoGifts)
      void queryClient.invalidateQueries({ queryKey: [GIFTS_KEY_PREFIX] });
  };

  const anyBusy = busyKey !== null;

  const handleDismiss = async (c: FinancialCorrection) => {
    setBusyKey(c.key);
    try {
      await dismissMut.mutateAsync({
        data: { kind: c.kind, proposalKey: c.key },
      });
      invalidate(false);
      toast({
        title: "Dismissed",
        description: "This correction won't be flagged again.",
      });
    } catch (err) {
      toast({
        title: "Couldn't dismiss",
        description: errMsg(err),
        variant: "destructive",
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleLink = async (c: FinancialCorrection) => {
    if (!c.evidence) return;
    setBusyKey(c.key);
    try {
      await applyMut.mutateAsync({
        data: {
          evidenceKind: c.evidence.kind,
          evidenceId: c.evidence.id,
          giftIds: c.gifts.map((g) => g.id),
        },
      });
      invalidate(true);
      toast({
        title: "Evidence linked",
        description: `Corroborated ${c.gifts.length} gifts with one ${
          EVIDENCE_SOURCE_LABEL[c.evidence.kind] ?? "evidence"
        } record.`,
      });
    } catch (err) {
      toast({
        title: "Couldn't link evidence",
        description: errMsg(err),
        variant: "destructive",
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleMerge = async (c: FinancialCorrection) => {
    if (!c.mergeSuggestion) return;
    setBusyKey(c.key);
    try {
      await mergeMut.mutateAsync({
        data: {
          primaryId: c.mergeSuggestion.primaryId,
          mergeIds: c.mergeSuggestion.mergeIds,
        },
      });
      invalidate(true);
      toast({
        title: "Gifts merged",
        description: "The duplicate gifts were merged into one.",
      });
    } catch (err) {
      toast({
        title: "Couldn't merge gifts",
        description: errMsg(err),
        variant: "destructive",
      });
    } finally {
      setBusyKey(null);
      setPendingMerge(null);
    }
  };

  if (!isAdmin) {
    return (
      <div className="max-w-3xl">
        <h1 className="font-serif text-3xl font-bold text-foreground">
          Financial Corrections
        </h1>
        <p className="mt-4 text-sm text-muted-foreground">
          The financial corrections queue is only available to administrators.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="font-serif text-3xl font-bold text-foreground">
          Financial Corrections
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Proposed fixes that make the CRM money records match how the money
          actually arrived — without ever changing the QuickBooks or Stripe
          source. <span className="font-medium text-foreground">Merge</span>{" "}
          collapses near-duplicate gifts into one gift with several allocations;{" "}
          <span className="font-medium text-foreground">Link evidence</span>{" "}
          records that one bulk deposit corroborates several separate gifts.
          Review each one, then apply or dismiss it.
        </p>
      </div>

      {!isLoading && !isError ? (
        <div className="text-sm text-muted-foreground">
          {corrections.length.toLocaleString()}{" "}
          {corrections.length === 1 ? "proposal" : "proposals"}
        </div>
      ) : null}

      {isLoading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Scanning for corrections…
        </p>
      ) : isError ? (
        <p className="py-8 text-center text-sm text-destructive">
          Failed to scan for corrections.
        </p>
      ) : corrections.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No financial corrections found.
        </p>
      ) : (
        <div className="space-y-4">
          {corrections.map((c) => {
            const isMerge = c.kind === "merge_gifts";
            const busy = busyKey === c.key;
            return (
              <div
                key={c.key}
                className="space-y-3 rounded-lg border p-4"
                data-testid={`correction-${c.key}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={isMerge ? "default" : "secondary"}>
                    {KIND_LABEL[c.kind] ?? c.kind}
                  </Badge>
                  {c.safeApply ? (
                    <Badge variant="outline">Safe to apply</Badge>
                  ) : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    score {c.score.toFixed(2)}
                  </span>
                </div>

                <p className="text-sm text-foreground">{c.reason}</p>

                {c.evidence ? <EvidenceCard evidence={c.evidence} /> : null}

                <div className="space-y-2">
                  {c.gifts.map((g) => (
                    <GiftLine
                      key={g.id}
                      gift={g}
                      isPrimary={
                        isMerge && c.mergeSuggestion?.primaryId === g.id
                      }
                    />
                  ))}
                </div>

                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={anyBusy}
                    onClick={() => handleDismiss(c)}
                    data-testid={`button-dismiss-${c.key}`}
                  >
                    Dismiss
                  </Button>
                  {isMerge ? (
                    <Button
                      size="sm"
                      disabled={anyBusy || !c.mergeSuggestion}
                      onClick={() => setPendingMerge(c)}
                      data-testid={`button-merge-${c.key}`}
                    >
                      {busy ? "Merging…" : "Merge gifts"}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={anyBusy || !c.evidence}
                      onClick={() => handleLink(c)}
                      data-testid={`button-link-${c.key}`}
                    >
                      {busy ? "Linking…" : `Link ${c.gifts.length} gifts`}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog
        open={pendingMerge !== null}
        onOpenChange={(o) => {
          if (!o && busyKey === null) setPendingMerge(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge these gifts?</AlertDialogTitle>
            <AlertDialogDescription>
              The other gifts will be folded into the survivor as additional
              allocations and then archived. Their payments, allocations, and
              evidence links move to the survivor. This does not change any
              QuickBooks or Stripe record. You can undo a merge by restoring the
              archived gifts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyKey !== null}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busyKey !== null}
              onClick={(e) => {
                e.preventDefault();
                if (pendingMerge) void handleMerge(pendingMerge);
              }}
              data-testid="button-confirm-merge"
            >
              {busyKey !== null ? "Merging…" : "Merge gifts"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
