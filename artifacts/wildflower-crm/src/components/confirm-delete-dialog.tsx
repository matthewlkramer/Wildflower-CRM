import { useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

type Props = {
  title: string;
  description?: string;
  confirmLabel?: string;
  triggerLabel?: string;
  triggerTestId?: string;
  confirmTestId?: string;
  onConfirm: () => Promise<unknown> | unknown;
  disabled?: boolean;
  /** Custom trigger element. When provided, replaces the default Delete button. */
  trigger?: ReactNode;
};

export function ConfirmDeleteDialog({
  title,
  description = "This action cannot be undone.",
  confirmLabel = "Delete",
  triggerLabel = "Delete",
  triggerTestId,
  confirmTestId,
  onConfirm,
  disabled,
  trigger,
}: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } catch {
      // Caller's onError (toast) has already handled user-facing reporting.
      // Swallow here to avoid unhandled-rejection noise; leave dialog open
      // so the user can retry or cancel.
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!busy) setOpen(v); }}>
      <AlertDialogTrigger asChild>
        {trigger ?? (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={disabled}
            data-testid={triggerTestId}
          >
            {triggerLabel}
          </Button>
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleConfirm();
            }}
            disabled={busy}
            data-testid={confirmTestId}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? "Deleting…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
