import { useEffect, useMemo, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

/** A scalar field the user can pick a winner for during a merge. */
export interface MergeField {
  /** Drizzle/JSON key on the record, e.g. "capacityRating". */
  key: string;
  label: string;
  /** Render a value as a human-readable string (default: String / "—"). */
  display?: (value: unknown) => string;
}

export type MergeRecord = Record<string, unknown> & { id: string };

export interface MergeResultLike {
  primaryId: string;
  mergedIds: string[];
}

function defaultDisplay(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

const norm = (v: unknown): unknown => (v === undefined ? null : v);

/**
 * Merge dialog: collapse N selected records into one chosen primary.
 *
 * The user picks which record survives (primary), then for every scalar
 * field where the selected records disagree, picks the winning value
 * (defaulting to the primary's). Child contact info and all other
 * related data are reparented server-side; the duplicates are deleted.
 */
export function MergeDialog({
  open,
  onOpenChange,
  entityNoun,
  records,
  fields,
  recordLabel,
  invalidateKeys,
  onSubmit,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Singular noun, e.g. "organization" / "person". */
  entityNoun: string;
  /** Full records for the selected ids (scalar fields read for conflicts). */
  records: ReadonlyArray<MergeRecord>;
  fields: ReadonlyArray<MergeField>;
  /** Human label for a record in the primary picker. */
  recordLabel: (record: MergeRecord) => string;
  /** React Query keys to invalidate after a successful merge. */
  invalidateKeys: QueryKey[];
  onSubmit: (args: {
    primaryId: string;
    mergeIds: string[];
    overrides: Record<string, unknown>;
  }) => Promise<MergeResultLike>;
  /** Called with the merge result so the page can clear its selection. */
  onDone?: (result: MergeResultLike) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [primaryId, setPrimaryId] = useState<string>("");
  // Per-field chosen value, JSON-stringified for stable Select values.
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const recordIds = useMemo(() => records.map((r) => r.id).join(","), [records]);

  // Default the primary to the first selected record whenever the set
  // of records changes (e.g. dialog reopened with a new selection).
  useEffect(() => {
    if (records.length === 0) return;
    setPrimaryId((prev) =>
      records.some((r) => r.id === prev) ? prev : records[0].id,
    );
  }, [recordIds, records]);

  const primary = records.find((r) => r.id === primaryId);

  /**
   * Per-field distinct values across all records (primary's value first),
   * skipping fields where everyone agrees. Each option carries a
   * JSON-stringified key so the Select can round-trip arbitrary scalars.
   */
  const conflicts = useMemo(() => {
    if (!primary) return [];
    return fields
      .map((field) => {
        const ordered = [primary, ...records.filter((r) => r.id !== primary.id)];
        const seen = new Set<string>();
        const options: Array<{ key: string; value: unknown }> = [];
        for (const r of ordered) {
          const value = norm(r[field.key]);
          const k = JSON.stringify(value);
          if (!seen.has(k)) {
            seen.add(k);
            options.push({ key: k, value });
          }
        }
        return { field, options };
      })
      .filter((c) => c.options.length > 1);
  }, [fields, records, primary]);

  // Reset each conflict choice to the primary's value when the primary
  // (or the conflict set) changes.
  useEffect(() => {
    if (!primary) return;
    const next: Record<string, string> = {};
    for (const c of conflicts) {
      next[c.field.key] = JSON.stringify(norm(primary[c.field.key]));
    }
    setChoices(next);
  }, [conflicts, primary]);

  if (records.length < 2) return null;

  const handleMerge = async () => {
    if (!primary) return;
    setSubmitting(true);
    try {
      const overrides: Record<string, unknown> = {};
      for (const c of conflicts) {
        const chosenKey = choices[c.field.key];
        const primaryKey = JSON.stringify(norm(primary[c.field.key]));
        if (chosenKey != null && chosenKey !== primaryKey) {
          const opt = c.options.find((o) => o.key === chosenKey);
          if (opt) overrides[c.field.key] = opt.value;
        }
      }
      const mergeIds = records.map((r) => r.id).filter((id) => id !== primary.id);
      const result = await onSubmit({ primaryId: primary.id, mergeIds, overrides });
      await Promise.all(
        invalidateKeys.map((key) => qc.invalidateQueries({ queryKey: key })),
      );
      toast({
        title: "Records merged",
        description: `${mergeIds.length.toLocaleString()} duplicate${
          mergeIds.length === 1 ? "" : "s"
        } merged into the primary record.`,
      });
      setConfirmOpen(false);
      onOpenChange(false);
      onDone?.(result);
    } catch (err) {
      toast({
        title: "Merge failed",
        description: err instanceof Error ? err.message : "Something went wrong.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (submitting) return;
          onOpenChange(o);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Merge {records.length.toLocaleString()} {entityNoun}s
            </DialogTitle>
            <DialogDescription>
              Choose the record to keep. All notes, gifts, opportunities, contact
              info, and other related data from the others will be moved onto it,
              then the duplicates will be permanently deleted.
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[60vh] pr-3">
            <div className="space-y-5 py-2">
              <div className="space-y-2">
                <Label className="text-sm font-medium">Keep this record</Label>
                <RadioGroup
                  value={primaryId}
                  onValueChange={setPrimaryId}
                  className="gap-2"
                >
                  {records.map((r) => (
                    <label
                      key={r.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                      data-testid={`merge-primary-${r.id}`}
                    >
                      <RadioGroupItem value={r.id} />
                      <span className="truncate">{recordLabel(r)}</span>
                    </label>
                  ))}
                </RadioGroup>
              </div>

              {conflicts.length > 0 ? (
                <div className="space-y-3">
                  <Label className="text-sm font-medium">
                    Resolve conflicting fields
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    These fields differ between the selected records. Pick the
                    value to keep — the primary's value is selected by default.
                  </p>
                  {conflicts.map((c) => (
                    <div
                      key={c.field.key}
                      className="grid grid-cols-[10rem_1fr] items-center gap-3"
                    >
                      <span className="text-sm text-muted-foreground">
                        {c.field.label}
                      </span>
                      <Select
                        value={choices[c.field.key] ?? ""}
                        onValueChange={(v) =>
                          setChoices((prev) => ({ ...prev, [c.field.key]: v }))
                        }
                      >
                        <SelectTrigger
                          data-testid={`merge-field-${c.field.key}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {c.options.map((o) => (
                            <SelectItem key={o.key} value={o.key}>
                              {(c.field.display ?? defaultDisplay)(o.value)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No conflicting fields — the selected records agree on every
                  field shown here.
                </p>
              )}
            </div>
          </ScrollArea>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={submitting || !primary}
              data-testid="button-merge-submit"
            >
              Merge records
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(o) => {
          if (!submitting) setConfirmOpen(o);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm merge</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This will move all related data onto the primary record and{" "}
                  <strong>permanently delete</strong>{" "}
                  <strong>{(records.length - 1).toLocaleString()}</strong>{" "}
                  duplicate {entityNoun}
                  {records.length - 1 === 1 ? "" : "s"}. This can't be undone.
                </p>
                {primary && (
                  <p className="text-sm">
                    Keeping: <strong>{recordLabel(primary)}</strong>
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleMerge();
              }}
              disabled={submitting}
              data-testid="button-merge-confirm"
            >
              {submitting ? "Merging…" : "Yes, merge"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
