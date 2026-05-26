import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListUsers,
  getListUsersQueryKey,
  useListRegions,
  getListRegionsQueryKey,
} from "@workspace/api-client-react";
import { userDisplayName } from "@/components/user-picker";
import { regionDisplayName } from "@/components/region-picker";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const NULL_SENTINEL = "__null__";
const CONFIRM_THRESHOLD = 25;

export type BulkField =
  | {
      kind: "owner";
      key: string;
      label: string;
      nullable?: boolean;
    }
  | {
      kind: "region";
      key: string;
      label: string;
      nullable?: boolean;
    }
  | {
      kind: "enum";
      key: string;
      label: string;
      nullable?: boolean;
      options: ReadonlyArray<{ value: string; label: string; destructive?: boolean }>;
    }
  | {
      kind: "boolean";
      key: string;
      label: string;
      /** Value of the boolean that counts as destructive for the confirmation gate. */
      destructiveValue?: boolean;
      trueLabel?: string;
      falseLabel?: string;
    }
  | {
      kind: "date";
      key: string;
      label: string;
      nullable?: boolean;
    };

// Per-field draft state. Each field starts disabled (`enabled=false`)
// and is only included in the outbound patch when the user toggles its
// checkbox on AND provides a value. `value` is kept as a string for the
// `<Select>`/`<Input>` and coerced at submit time.
type FieldDraft = {
  enabled: boolean;
  value: string; // empty string = unset, NULL_SENTINEL = explicit null
  bool: boolean; // for kind === "boolean"
};

function blankDraft(): FieldDraft {
  return { enabled: false, value: "", bool: false };
}

export interface BulkEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Singular noun used in titles + confirmation copy. */
  entityNoun: string;
  /** Selected ids — the dialog itself stays presentation-only. */
  selectedIds: ReadonlyArray<string>;
  fields: ReadonlyArray<BulkField>;
  /**
   * Caller-supplied submit. Receives the assembled patch (only opted-in
   * fields; values coerced to their final shape — null, boolean, date
   * string, or enum). Should reject on transport errors so the dialog
   * can show a toast and stay open.
   */
  onSubmit: (patch: Record<string, unknown>) => Promise<BulkResult>;
  /**
   * React Query keys to invalidate after a successful (or partially
   * successful) submit so the list re-fetches with fresh data.
   */
  invalidateKeys?: ReadonlyArray<readonly unknown[]>;
  /** Called after submit settles (success or partial). */
  onDone: (result: BulkResult) => void;
}

export interface BulkResult {
  requested: number;
  succeededIds: string[];
  failed: Array<{ id: string; message: string }>;
}

export function BulkEditDialog({
  open,
  onOpenChange,
  entityNoun,
  selectedIds,
  fields,
  onSubmit,
  invalidateKeys = [],
  onDone,
}: BulkEditDialogProps) {
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, blankDraft()])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{
    patch: Record<string, unknown>;
    reasons: string[];
  } | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Used for owner/region select options inside the dialog.
  const { data: usersData } = useListUsers({
    query: { queryKey: getListUsersQueryKey(), staleTime: 60_000, enabled: open },
  });
  const userOptions = useMemo(
    () =>
      [...(usersData ?? [])]
        .map((u) => ({ value: u.id, label: userDisplayName(u) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [usersData],
  );

  const REGIONS_PARAMS = { limit: 1000 } as const;
  const { data: regionsData } = useListRegions(REGIONS_PARAMS, {
    query: {
      queryKey: getListRegionsQueryKey(REGIONS_PARAMS),
      staleTime: 5 * 60_000,
      enabled: open,
    },
  });
  const regionOptions = useMemo(
    () =>
      (regionsData?.data ?? [])
        .map((r) => ({ value: r.id, label: regionDisplayName(r) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [regionsData],
  );

  function reset() {
    setDrafts(Object.fromEntries(fields.map((f) => [f.key, blankDraft()])));
    setPendingConfirm(null);
  }

  function patchDraft(key: string, partial: Partial<FieldDraft>) {
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...partial } }));
  }

  // Build the outbound patch and the list of "destructive" reasons
  // that would trigger the confirmation gate. Returns null if the user
  // toggled fields on but left them empty (we surface a toast instead
  // of failing silently).
  function assemble():
    | { patch: Record<string, unknown>; reasons: string[] }
    | { error: string } {
    const patch: Record<string, unknown> = {};
    const reasons: string[] = [];

    for (const f of fields) {
      const d = drafts[f.key];
      if (!d?.enabled) continue;

      switch (f.kind) {
        case "owner":
        case "region":
        case "enum": {
          if (!d.value) {
            return { error: `Please pick a value for ${f.label} or untick it.` };
          }
          if (d.value === NULL_SENTINEL) {
            if (!f.nullable) {
              return { error: `${f.label} cannot be cleared.` };
            }
            patch[f.key] = null;
          } else {
            patch[f.key] = d.value;
            if (f.kind === "enum") {
              const opt = f.options.find((o) => o.value === d.value);
              if (opt?.destructive) {
                reasons.push(`${f.label} → ${opt.label}`);
              }
            }
          }
          break;
        }
        case "date": {
          if (!d.value) {
            if (!f.nullable) {
              return { error: `Please pick a date for ${f.label} or untick it.` };
            }
            patch[f.key] = null;
          } else if (d.value === NULL_SENTINEL) {
            patch[f.key] = null;
          } else {
            patch[f.key] = d.value;
          }
          break;
        }
        case "boolean": {
          patch[f.key] = d.bool;
          if (f.destructiveValue !== undefined && d.bool === f.destructiveValue) {
            reasons.push(
              `${f.label} → ${d.bool ? (f.trueLabel ?? "true") : (f.falseLabel ?? "false")}`,
            );
          }
          break;
        }
      }
    }

    if (Object.keys(patch).length === 0) {
      return { error: "Tick at least one field to update." };
    }
    return { patch, reasons };
  }

  async function performSubmit(patch: Record<string, unknown>) {
    setSubmitting(true);
    try {
      const result = await onSubmit(patch);
      // Refresh list data, even on partial failure — succeeded rows
      // moved.
      for (const k of invalidateKeys) {
        await queryClient.invalidateQueries({ queryKey: [...k] });
      }
      const successCount = result.succeededIds.length;
      const failCount = result.failed.length;
      toast({
        title:
          failCount === 0
            ? `Updated ${successCount.toLocaleString()} ${entityNoun}${successCount === 1 ? "" : "s"}`
            : `Updated ${successCount.toLocaleString()}, ${failCount.toLocaleString()} failed`,
        description:
          failCount === 0
            ? undefined
            : result.failed
                .slice(0, 3)
                .map((f) => `${f.id}: ${f.message}`)
                .join(" • "),
        variant: failCount > 0 && successCount === 0 ? "destructive" : undefined,
      });
      onDone(result);
      reset();
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "Bulk update failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmitClick() {
    const r = assemble();
    if ("error" in r) {
      toast({ title: r.error, variant: "destructive" });
      return;
    }
    const needsConfirm =
      selectedIds.length >= CONFIRM_THRESHOLD || r.reasons.length > 0;
    if (needsConfirm) {
      setPendingConfirm(r);
    } else {
      void performSubmit(r.patch);
    }
  }

  function renderField(f: BulkField): ReactNode {
    const d = drafts[f.key] ?? blankDraft();
    const id = `bulk-field-${f.key}`;

    let control: ReactNode = null;
    switch (f.kind) {
      case "owner":
      case "region": {
        const options = f.kind === "owner" ? userOptions : regionOptions;
        control = (
          <Select
            value={d.value || undefined}
            onValueChange={(v) => patchDraft(f.key, { value: v })}
            disabled={!d.enabled}
          >
            <SelectTrigger
              id={id}
              className="w-full"
              data-testid={`bulk-select-${f.key}`}
            >
              <SelectValue placeholder="Pick a value…" />
            </SelectTrigger>
            <SelectContent>
              {f.nullable && (
                <SelectItem value={NULL_SENTINEL}>
                  <span className="text-muted-foreground">— Clear —</span>
                </SelectItem>
              )}
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
        break;
      }
      case "enum": {
        control = (
          <Select
            value={d.value || undefined}
            onValueChange={(v) => patchDraft(f.key, { value: v })}
            disabled={!d.enabled}
          >
            <SelectTrigger
              id={id}
              className="w-full"
              data-testid={`bulk-select-${f.key}`}
            >
              <SelectValue placeholder="Pick a value…" />
            </SelectTrigger>
            <SelectContent>
              {f.nullable && (
                <SelectItem value={NULL_SENTINEL}>
                  <span className="text-muted-foreground">— Clear —</span>
                </SelectItem>
              )}
              {f.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
        break;
      }
      case "boolean": {
        control = (
          <Select
            value={d.enabled ? String(d.bool) : undefined}
            onValueChange={(v) => patchDraft(f.key, { bool: v === "true" })}
            disabled={!d.enabled}
          >
            <SelectTrigger
              id={id}
              className="w-full"
              data-testid={`bulk-select-${f.key}`}
            >
              <SelectValue placeholder="Pick a value…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">{f.trueLabel ?? "Yes"}</SelectItem>
              <SelectItem value="false">{f.falseLabel ?? "No"}</SelectItem>
            </SelectContent>
          </Select>
        );
        break;
      }
      case "date": {
        control = (
          <Input
            id={id}
            type="date"
            value={d.value === NULL_SENTINEL ? "" : d.value}
            onChange={(e) => patchDraft(f.key, { value: e.target.value })}
            disabled={!d.enabled}
            data-testid={`bulk-input-${f.key}`}
          />
        );
        break;
      }
    }

    return (
      <div key={f.key} className="grid grid-cols-[24px_1fr_2fr] items-center gap-3">
        <Checkbox
          checked={d.enabled}
          onCheckedChange={(v) => patchDraft(f.key, { enabled: v === true })}
          aria-label={`Update ${f.label}`}
          data-testid={`bulk-toggle-${f.key}`}
        />
        <Label
          htmlFor={id}
          className={d.enabled ? "" : "text-muted-foreground"}
        >
          {f.label}
        </Label>
        <div>{control}</div>
      </div>
    );
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !submitting) reset();
          onOpenChange(o);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              Edit {selectedIds.length.toLocaleString()} {entityNoun}
              {selectedIds.length === 1 ? "" : "s"}
            </DialogTitle>
            <DialogDescription>
              Tick the fields you want to overwrite. Only ticked fields are
              changed — every other field is left as-is.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">{fields.map(renderField)}</div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmitClick}
              disabled={submitting || selectedIds.length === 0}
              data-testid="button-bulk-submit"
            >
              {submitting ? "Updating…" : "Apply changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!pendingConfirm}
        onOpenChange={(o) => {
          if (!o) setPendingConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm bulk update</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  You're about to update{" "}
                  <strong>{selectedIds.length.toLocaleString()}</strong>{" "}
                  {entityNoun}
                  {selectedIds.length === 1 ? "" : "s"}. This can't be undone in one
                  click.
                </p>
                {pendingConfirm && pendingConfirm.reasons.length > 0 && (
                  <div className="rounded-md bg-destructive/10 p-3 text-sm">
                    <p className="font-medium">Heads up — these changes are destructive:</p>
                    <ul className="mt-1 list-inside list-disc">
                      {pendingConfirm.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingConfirm) {
                  const p = pendingConfirm.patch;
                  setPendingConfirm(null);
                  void performSubmit(p);
                }
              }}
              data-testid="button-bulk-confirm"
            >
              Yes, apply
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
