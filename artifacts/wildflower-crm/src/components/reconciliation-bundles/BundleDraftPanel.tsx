import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Link2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  useAssembleReconciliationBundle,
  useDeriveReconciliationBundle,
  useConfirmReconciliationBundle,
  type BundleAnchorType,
  type BundleRowOverride,
  type ReconciliationBundleConfirmResult,
  type ReconciliationBundleProposal,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/format";
import { extractGateIssues } from "@/lib/reconciliation";
import { BundleRowEditor } from "./BundleRowEditor";
import { shortId, warningSeverityClass } from "./bundle-ui";

function errMessage(err: unknown): string {
  const issues = extractGateIssues(err);
  if (issues.length > 0) return issues.join(" · ");
  return err instanceof Error ? err.message : "Something went wrong.";
}

function is409(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 409
  );
}

/**
 * The detail pane: assembles (or loads) the persisted draft for one settlement
 * anchor, renders the reactive tie + per-charge rows, and commits the whole
 * bundle atomically. Every edit goes through /derive; the fresh proposal
 * replaces local state. Confirm is gated on the server-computed readiness.
 */
export function BundleDraftPanel({
  anchorId,
  anchorType = "stripe_payout",
  onConfirmed,
}: {
  anchorId: string;
  anchorType?: BundleAnchorType;
  onConfirmed?: () => void;
}) {
  const { toast } = useToast();
  const assembleM = useAssembleReconciliationBundle();
  const deriveM = useDeriveReconciliationBundle();
  const confirmM = useConfirmReconciliationBundle();

  const [proposal, setProposal] = useState<ReconciliationBundleProposal | null>(
    null,
  );
  const [confirmResult, setConfirmResult] =
    useState<ReconciliationBundleConfirmResult | null>(null);
  const [allowWarnings, setAllowWarnings] = useState(false);

  const assemble = assembleM.mutateAsync;
  const derive = deriveM.mutateAsync;
  const confirm = confirmM.mutateAsync;

  // Load the draft whenever the selected anchor changes.
  useEffect(() => {
    let cancelled = false;
    setProposal(null);
    setConfirmResult(null);
    setAllowWarnings(false);
    assemble({ data: { anchorType, anchorId } })
      .then((p) => {
        if (!cancelled) setProposal(p);
      })
      .catch((err) => {
        if (!cancelled)
          toast({
            title: "Couldn't load the bundle",
            description: errMessage(err),
          });
      });
    return () => {
      cancelled = true;
    };
    // assemble/toast are stable; re-run only when the anchor changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorId, anchorType]);

  const busy = assembleM.isPending || deriveM.isPending || confirmM.isPending;

  const applyOverride = useCallback(
    async (override: BundleRowOverride) => {
      if (!proposal) return;
      try {
        const next = await derive({
          draftId: proposal.draftId,
          data: { rows: [override] },
        });
        setProposal(next);
      } catch (err) {
        toast({ title: "Couldn't update row", description: errMessage(err) });
      }
    },
    [proposal, derive, toast],
  );

  const toggleTie = useCallback(async () => {
    if (!proposal?.tie) return;
    const nextAction =
      proposal.tie.action === "confirm_tie" ? "none" : "confirm_tie";
    try {
      const next = await derive({
        draftId: proposal.draftId,
        data: { tie: { action: nextAction } },
      });
      setProposal(next);
    } catch (err) {
      toast({ title: "Couldn't update tie", description: errMessage(err) });
    }
  }, [proposal, derive, toast]);

  const refresh = useCallback(async () => {
    if (!proposal) return;
    try {
      const next = await assemble({
        data: { anchorType, anchorId, refresh: true },
      });
      setProposal(next);
    } catch (err) {
      toast({ title: "Couldn't refresh", description: errMessage(err) });
    }
  }, [proposal, assemble, anchorType, anchorId, toast]);

  const handleConfirm = useCallback(async () => {
    if (!proposal) return;
    try {
      const res = await confirm({
        draftId: proposal.draftId,
        data: { expectedRevision: proposal.revision, allowWarnings },
      });
      setConfirmResult(res);
      onConfirmed?.();
      toast({
        title: res.alreadyConfirmed
          ? "Bundle was already confirmed."
          : "Bundle confirmed.",
      });
    } catch (err) {
      if (is409(err)) {
        try {
          const fresh = await assemble({
            data: { anchorType, anchorId, refresh: true },
          });
          setProposal(fresh);
        } catch {
          /* keep the stale proposal; the toast explains what to do */
        }
        toast({
          title: "The bundle changed — reloaded.",
          description: "Review the rows and confirm again.",
        });
      } else {
        toast({ title: "Couldn't confirm", description: errMessage(err) });
      }
    }
  }, [proposal, confirm, allowWarnings, onConfirmed, assemble, anchorType, anchorId, toast]);

  if (!proposal) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed py-20 text-muted-foreground">
        {assembleM.isPending ? (
          <>
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Assembling bundle…
          </>
        ) : (
          <span className="text-sm">Couldn't load this bundle.</span>
        )}
      </div>
    );
  }

  if (confirmResult) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/50 py-16 text-center">
        <CheckCircle2 className="h-10 w-10 text-emerald-500" />
        <p className="font-medium">Bundle confirmed</p>
        <p className="text-sm text-muted-foreground">
          {confirmResult.giftsCreated} created · {confirmResult.giftsMatched}{" "}
          matched · {confirmResult.donorsCreated} new donor
          {confirmResult.donorsCreated === 1 ? "" : "s"}
          {confirmResult.tieConfirmed ? " · tie stamped" : ""}
        </p>
      </div>
    );
  }

  const s = proposal.summary;
  const tie = proposal.tie;
  const confirmable =
    s.ready && (s.warningCount === 0 || allowWarnings) && !busy;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          <span className="font-semibold">{shortId(proposal.anchorId)}</span>
          <span className="text-xs text-muted-foreground">
            rev {proposal.revision}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Badge variant="outline">{s.rowCount} rows</Badge>
          <Badge variant="outline">{s.matchCount} match</Badge>
          <Badge variant="outline">{s.mintCount} mint</Badge>
          {s.newDonorCount > 0 && (
            <Badge variant="outline">{s.newDonorCount} new donor</Badge>
          )}
          {s.researchCount > 0 && (
            <Badge variant="outline">{s.researchCount} research</Badge>
          )}
          {s.excludeCount > 0 && (
            <Badge variant="outline">{s.excludeCount} exclude</Badge>
          )}
          {s.blockerCount > 0 && (
            <Badge variant="outline" className="border-destructive/30 text-destructive">
              {s.blockerCount} blocker{s.blockerCount === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
      </div>

      {/* Stale banner */}
      {proposal.stale && (
        <div className="mt-3 flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span>The underlying source rows changed since this draft.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2"
            disabled={busy}
            onClick={refresh}
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </Button>
        </div>
      )}

      {/* Tie */}
      {tie && (
        <div className="mt-3 rounded-lg border bg-muted/30 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Payout ↔ deposit
              </span>
              {tie.payoutNetAmount != null && (
                <span className="text-xs">
                  net {formatCurrency(tie.payoutNetAmount)}
                </span>
              )}
              {tie.depositAmount != null && (
                <span className="text-xs text-muted-foreground">
                  deposit {formatCurrency(tie.depositAmount)}
                </span>
              )}
              {tie.chargeCount != null && (
                <span className="text-xs text-muted-foreground">
                  {tie.chargeCount} charges
                </span>
              )}
              <Badge variant="outline">{tie.action}</Badge>
            </div>
            {tie.action !== "conflict" && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={busy}
                onClick={toggleTie}
              >
                {tie.action === "confirm_tie" ? "Don't stamp tie" : "Stamp tie"}
              </Button>
            )}
          </div>
          {tie.warnings.map((w, i) => (
            <div
              key={`${w.code}-${i}`}
              className={`mt-2 flex items-start gap-2 rounded-md border px-2 py-1 text-xs ${warningSeverityClass(w.severity)}`}
            >
              <span className="font-medium uppercase">{w.severity}</span>
              <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Rows */}
      <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {proposal.rows.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            No charges in this bundle.
          </div>
        ) : (
          proposal.rows.map((row) => (
            <BundleRowEditor
              key={row.rowKey}
              row={row}
              disabled={busy}
              onOverride={applyOverride}
            />
          ))
        )}
      </div>

      {/* Footer / confirm */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        <div className="flex items-center gap-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          {s.warningCount > 0 && s.blockerCount === 0 && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={allowWarnings}
                disabled={busy}
                onCheckedChange={(v) => setAllowWarnings(v === true)}
                data-testid="checkbox-bundle-allow-warnings"
              />
              Proceed despite {s.warningCount} warning
              {s.warningCount === 1 ? "" : "s"}
            </label>
          )}
          {s.blockerCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> Resolve blockers to confirm
            </span>
          )}
        </div>
        <Button
          type="button"
          disabled={!confirmable}
          onClick={handleConfirm}
          data-testid="button-bundle-confirm"
        >
          {confirmM.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Confirming…
            </>
          ) : (
            "Confirm bundle"
          )}
        </Button>
      </div>
    </div>
  );
}
