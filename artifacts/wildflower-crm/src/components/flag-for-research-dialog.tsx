import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useFlagForResearch,
  type FlagForResearchBodyTargetType,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

const CLEANUP_KEY_PREFIX = "/api/cleanup-queue";

// Map a flag target type to the API key prefix of the record's detail query, so
// flagging refreshes the passive "Needs research" badge on that detail page.
// `staged_payment` has no such badge, so it is intentionally omitted.
const DETAIL_KEY_PREFIX: Partial<Record<FlagForResearchBodyTargetType, string>> = {
  organization: "/api/organizations",
  person: "/api/people",
  opportunity: "/api/opportunities-and-pledges",
  pledge: "/api/opportunities-and-pledges",
  gift: "/api/gifts-and-payments",
};

/**
 * "Flag for research" action — adds the current record to the Cleanup Queue
 * with reason_code='needs_research'. Shared across opportunity/pledge,
 * organization, person and gift detail pages.
 *
 * The server is idempotent against the (target_type, target_id, reason_code)
 * unique key, so re-flagging an already-flagged record surfaces the existing
 * item instead of creating a duplicate.
 */
export function FlagForResearchDialog({
  targetType,
  targetId,
  recordLabel = "this record",
  triggerTestId = "button-flag-research",
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  hideTrigger = false,
}: {
  targetType: FlagForResearchBodyTargetType;
  targetId: string;
  /** Human label shown in the dialog (e.g. the record's name). */
  recordLabel?: string;
  triggerTestId?: string;
  /** Controlled open state (omit to let the dialog manage its own). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Hide the built-in trigger button (use when driven from a menu). */
  hideTrigger?: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = (v: boolean) => {
    if (isControlled) controlledOnOpenChange?.(v);
    else setUncontrolledOpen(v);
  };
  const [note, setNote] = useState("");
  const flagMut = useFlagForResearch();

  const submit = () => {
    const trimmed = note.trim();
    if (trimmed.length === 0) return;
    flagMut.mutate(
      { data: { targetType, targetId, note: trimmed } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: [CLEANUP_KEY_PREFIX],
          });
          const detailPrefix = DETAIL_KEY_PREFIX[targetType];
          if (detailPrefix) {
            void queryClient.invalidateQueries({ queryKey: [detailPrefix] });
          }
          setOpen(false);
          setNote("");
          toast({
            title: "Flagged for research",
            description: "Added to the Cleanup Queue for follow-up.",
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't flag",
            description:
              err instanceof Error ? err.message : "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!flagMut.isPending) setOpen(v);
      }}
    >
      {!hideTrigger && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          data-testid={triggerTestId}
        >
          Flag for research
        </Button>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Flag for research</DialogTitle>
          <DialogDescription>
            Add {recordLabel} to the Cleanup Queue so the team can research and
            follow up on it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="flag-research-note">What needs research?</Label>
          <Textarea
            id="flag-research-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Describe what to look into or follow up on…"
            rows={4}
            data-testid="input-flag-research-note"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={flagMut.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={flagMut.isPending || note.trim().length === 0}
            data-testid="button-confirm-flag-research"
          >
            {flagMut.isPending ? "Flagging…" : "Flag for research"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Bulk variant of {@link FlagForResearchDialog}: flags many records for research
 * at once with a single shared note. Loops the same idempotent /cleanup-queue
 * endpoint over each target (deduped by target), tolerating partial failures,
 * then reports how many landed. `onDone` fires after a run so the caller can
 * clear its selection.
 */
export function BulkFlagForResearchDialog({
  targets,
  open,
  onOpenChange,
  onDone,
}: {
  targets: { targetType: FlagForResearchBodyTargetType; targetId: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const flagMut = useFlagForResearch();

  const uniqueTargets = useMemo(() => {
    const seen = new Set<string>();
    const out: { targetType: FlagForResearchBodyTargetType; targetId: string }[] =
      [];
    for (const t of targets) {
      const key = `${t.targetType}:${t.targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }, [targets]);

  const submit = async () => {
    const trimmed = note.trim();
    if (trimmed.length === 0 || uniqueTargets.length === 0) return;
    setBusy(true);
    let ok = 0;
    let failed = 0;
    for (const t of uniqueTargets) {
      try {
        await flagMut.mutateAsync({
          data: {
            targetType: t.targetType,
            targetId: t.targetId,
            note: trimmed,
          },
        });
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    void queryClient.invalidateQueries({ queryKey: [CLEANUP_KEY_PREFIX] });
    onOpenChange(false);
    setNote("");
    onDone?.();
    toast({
      title: `Flagged ${ok} ${ok === 1 ? "record" : "records"} for research`,
      description:
        failed > 0
          ? `${failed} couldn't be flagged.`
          : "Added to the Cleanup Queue for follow-up.",
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Flag {uniqueTargets.length}{" "}
            {uniqueTargets.length === 1 ? "record" : "records"} for research
          </DialogTitle>
          <DialogDescription>
            Add the selected{" "}
            {uniqueTargets.length === 1 ? "record" : "records"} to the Cleanup
            Queue so the team can research and follow up.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="bulk-flag-research-note">What needs research?</Label>
          <Textarea
            id="bulk-flag-research-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Describe what to look into or follow up on…"
            rows={4}
            data-testid="input-bulk-flag-research-note"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={busy || note.trim().length === 0 || uniqueTargets.length === 0}
            data-testid="button-confirm-bulk-flag-research"
          >
            {busy
              ? "Flagging…"
              : `Flag ${uniqueTargets.length} for research`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
