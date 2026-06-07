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
import { buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import type { BulkResult } from "@/components/bulk-edit-dialog";

export interface BulkDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Singular noun used in titles + confirmation copy. */
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
   * successful) delete so the list re-fetches.
   */
  invalidateKeys?: ReadonlyArray<readonly unknown[]>;
  /** Called after submit settles (success or partial). */
  onDone: (result: BulkResult) => void;
}

/**
 * Confirmation dialog for the destructive bulk-delete action. Always
 * requires an explicit confirm (deletes are irreversible) and surfaces a
 * results panel listing per-row failures so the user can see (and copy)
 * which rows couldn't be deleted and why.
 */
export function BulkDeleteDialog({
  open,
  onOpenChange,
  entityNoun,
  selectedIds,
  onConfirm,
  invalidateKeys = [],
  onDone,
}: BulkDeleteDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [resultPanel, setResultPanel] = useState<BulkResult | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const count = selectedIds.length;
  const noun = `${entityNoun}${count === 1 ? "" : "s"}`;

  async function performDelete() {
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
            ? `Deleted ${successCount.toLocaleString()} of ${result.requested.toLocaleString()} ${entityNoun}${result.requested === 1 ? "" : "s"}`
            : `Deleted ${successCount.toLocaleString()} of ${result.requested.toLocaleString()} (${failCount.toLocaleString()} failed — see details)`,
        variant: failCount > 0 && successCount === 0 ? "destructive" : undefined,
      });
      onDone(result);
      onOpenChange(false);
      if (failCount > 0) {
        setResultPanel(result);
      }
    } catch (e) {
      toast({
        title: "Bulk delete failed",
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
        <AlertDialogContent data-testid="bulk-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {count.toLocaleString()} {noun}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the selected {noun} and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(buttonVariants({ variant: "destructive" }))}
              disabled={submitting || count === 0}
              onClick={(e) => {
                // Keep the dialog mounted while the request is in flight;
                // performDelete closes it on settle.
                e.preventDefault();
                void performDelete();
              }}
              data-testid="button-bulk-delete-confirm"
            >
              {submitting ? "Deleting…" : `Delete ${count.toLocaleString()} ${noun}`}
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
            <AlertDialogTitle>Bulk delete results</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {resultPanel && (
                  <p>
                    Deleted{" "}
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
              data-testid="button-bulk-delete-results-close"
            >
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
