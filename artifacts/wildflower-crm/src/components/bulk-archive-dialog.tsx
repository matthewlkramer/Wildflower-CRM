import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import type { BulkResult } from "@/components/bulk-edit-dialog";

export interface BulkArchiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Singular noun used in titles + copy. */
  entityNoun: string;
  /** Selected ids — the dialog stays presentation-only. */
  selectedIds: ReadonlyArray<string>;
  /**
   * Caller-supplied submit. Should reject on transport errors so the
   * dialog can show a toast and stay open.
   */
  onConfirm: () => Promise<BulkResult>;
  /**
   * React Query keys to invalidate after a successful (or partially
   * successful) archive so the list re-fetches.
   */
  invalidateKeys?: ReadonlyArray<readonly unknown[]>;
  /** Called after submit settles (success or partial). */
  onDone: (result: BulkResult) => void;
}

/**
 * Confirmation dialog for the bulk-archive action. Archiving is reversible
 * (admins can unarchive), so the copy is non-destructive, but a confirm is
 * still required and a results panel lists any per-row failures so the user
 * can see which rows couldn't be archived and why.
 */
export function BulkArchiveDialog({
  open,
  onOpenChange,
  entityNoun,
  selectedIds,
  onConfirm,
  invalidateKeys = [],
  onDone,
}: BulkArchiveDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [resultPanel, setResultPanel] = useState<BulkResult | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const count = selectedIds.length;
  const noun = `${entityNoun}${count === 1 ? "" : "s"}`;

  async function performArchive() {
    setSubmitting(true);
    try {
      const result = await onConfirm();
      for (const k of invalidateKeys) {
        await queryClient.invalidateQueries({ queryKey: [...k] });
      }
      const successCount = result.succeededIds.length;
      const failCount = result.failed.length;
      toast({
        title:
          failCount === 0
            ? `Archived ${successCount.toLocaleString()} of ${result.requested.toLocaleString()} ${entityNoun}${result.requested === 1 ? "" : "s"}`
            : `Archived ${successCount.toLocaleString()} of ${result.requested.toLocaleString()} (${failCount.toLocaleString()} failed — see details)`,
        variant: failCount > 0 && successCount === 0 ? "destructive" : undefined,
      });
      onDone(result);
      onOpenChange(false);
      if (failCount > 0) {
        setResultPanel(result);
      }
    } catch (e) {
      toast({
        title: "Bulk archive failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!submitting) onOpenChange(o);
        }}
      >
        <AlertDialogContent data-testid="bulk-archive-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Archive {count.toLocaleString()} {noun}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The selected {noun} will be hidden from the list. An admin can
              restore them later from "Show archived". This does not change any
              status fields.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting || count === 0}
              onClick={(e) => {
                // Keep the dialog mounted while the request is in flight;
                // performArchive closes it on settle.
                e.preventDefault();
                void performArchive();
              }}
              data-testid="button-bulk-archive-confirm"
            >
              {submitting ? "Archiving…" : `Archive ${count.toLocaleString()} ${noun}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Post-submit results panel — only shown when there were per-row
          failures. Lists every failed id + reason. */}
      <AlertDialog
        open={!!resultPanel}
        onOpenChange={(o) => {
          if (!o) setResultPanel(null);
        }}
      >
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Bulk archive results</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {resultPanel && (
                  <p>
                    Archived{" "}
                    <strong>{resultPanel.succeededIds.length.toLocaleString()}</strong>{" "}
                    of {resultPanel.requested.toLocaleString()} {entityNoun}
                    {resultPanel.requested === 1 ? "" : "s"}.{" "}
                    <strong>{resultPanel.failed.length.toLocaleString()}</strong> failed.
                  </p>
                )}
                {resultPanel && resultPanel.failed.length > 0 && (
                  <div className="rounded-md border bg-muted/40 p-2 text-sm">
                    <details>
                      <summary className="cursor-pointer font-medium">
                        Show failure details ({resultPanel.failed.length})
                      </summary>
                      <ScrollArea className="mt-2 max-h-56 pr-2">
                        <ul className="space-y-1 font-mono text-xs">
                          {resultPanel.failed.map((f) => (
                            <li key={f.id} className="break-words">
                              <span className="text-muted-foreground">{f.id}</span>
                              {" — "}
                              {f.message}
                            </li>
                          ))}
                        </ul>
                      </ScrollArea>
                    </details>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              onClick={() => setResultPanel(null)}
              data-testid="button-bulk-archive-results-close"
            >
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
