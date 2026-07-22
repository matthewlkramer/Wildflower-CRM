import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListUsers,
  getListUsersQueryKey,
  useListRegions,
  getListRegionsQueryKey,
  useCreateRegion,
  useListFiscalYears,
  getListFiscalYearsQueryKey,
  useListEntities,
  getListEntitiesQueryKey,
  useListFundableProjects,
  getListFundableProjectsQueryKey,
} from "@workspace/api-client-react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { userDisplayName } from "@/components/user-picker";
import { regionDisplayName, buildRegionIndex } from "@/components/region-picker";
import { useIsAdmin } from "@/hooks/use-is-admin";
import {
  INTERESTS_THEMATIC_SUGGESTIONS,
  INTERESTS_AGES_SUGGESTIONS,
  INTERESTS_GOV_MODELS_SUGGESTIONS,
} from "@/components/multi-select-picker";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";

const NULL_SENTINEL = "__null__";
const CONFIRM_THRESHOLD = 25;

// ── BulkRegionCombobox ────────────────────────────────────────────────────
// A searchable combobox for the region field in BulkEditDialog that also
// Selection-only: region creation lives in the admin-only structured dialog.

interface BulkRegionComboboxProps {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  nullable?: boolean;
  options: ReadonlyArray<{ value: string; label: string }>;
}

function BulkRegionCombobox({
  value,
  onChange,
  disabled,
  nullable,
  options,
}: BulkRegionComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const isAdmin = useIsAdmin();

  const trimmedQuery = query.trim();
  const filtered = trimmedQuery
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(trimmedQuery.toLowerCase()) ||
          o.value.toLowerCase().includes(trimmedQuery.toLowerCase()),
      )
    : options;

  const selectedLabel =
    value === NULL_SENTINEL
      ? "— Clear —"
      : (options.find((o) => o.value === value)?.label ?? (value ? value : undefined));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          className="w-full justify-between font-normal"
          disabled={disabled}
          data-testid="bulk-select-regionId"
        >
          <span className="truncate text-left">
            {selectedLabel ?? <span className="text-muted-foreground">Pick a region…</span>}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[--radix-popover-trigger-width] min-w-[260px]" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search regions…"
          />
          <CommandList>
            {filtered.length === 0 ? (
              <CommandEmpty>
                No regions match.
                {!isAdmin && (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Can't find this region? Ask an admin to add it.
                  </span>
                )}
              </CommandEmpty>
            ) : null}
            <CommandGroup>
              {nullable && (
                <CommandItem
                  value={NULL_SENTINEL}
                  onSelect={() => { onChange(NULL_SENTINEL); setOpen(false); setQuery(""); }}
                >
                  <Check className={cn("mr-2 h-4 w-4", value === NULL_SENTINEL ? "opacity-100" : "opacity-0")} />
                  <span className="text-muted-foreground">— Clear —</span>
                </CommandItem>
              )}
              {filtered.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  onSelect={() => { onChange(o.value); setOpen(false); setQuery(""); }}
                >
                  <Check className={cn("mr-2 h-4 w-4", value === o.value ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{o.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

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
      /**
       * When set, picking a non-clear value auto-enables the referenced
       * date field (defaulted to today) and requires it in the assembled
       * patch — used for close transitions (lossType/stage) where the API
       * rejects rows newly closed without an actualCompletionDate.
       */
      requiresDate?: { key: string; label: string };
    }
  | {
      // Intended-usage enum coupled with a fundable-project picker that
      // only appears (and is required) when the "project" usage value is
      // chosen. The chosen project id is written under `projectKey`.
      kind: "intended-usage";
      key: string;
      /** Patch key carrying the chosen fundable project id. */
      projectKey: string;
      label: string;
      /** Label for the dependent project picker row. */
      projectLabel: string;
      options: ReadonlyArray<{ value: string; label: string }>;
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
    }
  | {
      kind: "string-array";
      key: string;
      /** Companion patch key holding the "replace" / "append" mode. */
      modeKey: string;
      label: string;
      /** Where to pull the option set from. */
      source: BulkArraySource;
    };

/** Option source for a `string-array` bulk field. */
export type BulkArraySource =
  | "fiscalYears"
  | "entities"
  | "regions"
  | "interestsThematic"
  | "interestsAges"
  | "interestsGovModels";

// Per-field draft state. Each field starts disabled (`enabled=false`)
// and is only included in the outbound patch when the user toggles its
// checkbox on AND provides a value. `value` is kept as a string for the
// `<Select>`/`<Input>` and coerced at submit time. `values` and `mode`
// are used by the `string-array` kind only.
type FieldDraft = {
  enabled: boolean;
  value: string; // empty string = unset, NULL_SENTINEL = explicit null
  bool: boolean; // for kind === "boolean"
  values: string[]; // for kind === "string-array"
  mode: "replace" | "append"; // for kind === "string-array"
  projectValue: string; // for kind === "intended-usage" (fundable project id)
};

function blankDraft(): FieldDraft {
  return { enabled: false, value: "", bool: false, values: [], mode: "append", projectValue: "" };
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
   * string, enum, or string[]+mode). Should reject on transport errors
   * so the dialog can show a toast and stay open.
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
  // Lifted-out result panel that appears after a partial-failure
  // submit so the user can see (and copy) every failure. Full-success
  // submits just toast and close.
  const [resultPanel, setResultPanel] = useState<BulkResult | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const needsFy = fields.some((f) => f.kind === "string-array" && f.source === "fiscalYears");
  const needsEntities = fields.some((f) => f.kind === "string-array" && f.source === "entities");
  const needsFundableProjects = fields.some((f) => f.kind === "intended-usage");

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
  const regionOptions = useMemo(() => {
    const regions = regionsData?.data ?? [];
    const byId = buildRegionIndex(regions);
    return regions
      .map((r) => ({ value: r.id, label: regionDisplayName(r, byId) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [regionsData]);

  // Allocation-table option sets — only fetched when actually needed.
  const { data: fyData } = useListFiscalYears(undefined, {
    query: {
      queryKey: getListFiscalYearsQueryKey(),
      staleTime: 5 * 60_000,
      enabled: open && needsFy,
    },
  });
  const fyOptions = useMemo(
    () =>
      [...(fyData ?? [])]
        .map((f) => ({ value: f.id, label: f.id }))
        .sort((a, b) => a.value.localeCompare(b.value)),
    [fyData],
  );

  const { data: entitiesData } = useListEntities({
    query: {
      queryKey: getListEntitiesQueryKey(),
      staleTime: 5 * 60_000,
      enabled: open && needsEntities,
    },
  });
  const entityOptions = useMemo(
    () =>
      [...(entitiesData ?? [])]
        .map((e) => ({ value: e.id, label: e.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [entitiesData],
  );

  // Fundable projects — only fetched when an intended-usage field is
  // present. Active projects only (retired ones can't be newly assigned
  // in bulk), sorted by name.
  const { data: fundableProjectsData } = useListFundableProjects(undefined, {
    query: {
      queryKey: getListFundableProjectsQueryKey(),
      staleTime: 5 * 60_000,
      enabled: open && needsFundableProjects,
    },
  });
  const fundableProjectOptions = useMemo(
    () =>
      (fundableProjectsData ?? [])
        .filter((p) => p.active)
        .map((p) => ({ value: p.id, label: p.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [fundableProjectsData],
  );

  function optionsFor(source: BulkArraySource): ReadonlyArray<{ value: string; label: string }> {
    switch (source) {
      case "fiscalYears":
        return fyOptions;
      case "entities":
        return entityOptions;
      case "regions":
        return regionOptions;
      case "interestsThematic":
        return INTERESTS_THEMATIC_SUGGESTIONS;
      case "interestsAges":
        return INTERESTS_AGES_SUGGESTIONS;
      case "interestsGovModels":
        return INTERESTS_GOV_MODELS_SUGGESTIONS;
    }
  }

  function reset() {
    setDrafts(Object.fromEntries(fields.map((f) => [f.key, blankDraft()])));
    setPendingConfirm(null);
  }

  function patchDraft(key: string, partial: Partial<FieldDraft>) {
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...partial } }));
  }

  // Build the outbound patch and the list of "destructive" reasons
  // that would trigger the confirmation gate. Returns an error if the
  // user toggled fields on but left them empty.
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
        case "intended-usage": {
          if (!d.value) {
            return { error: `Please pick a value for ${f.label} or untick it.` };
          }
          patch[f.key] = d.value;
          if (d.value === "project") {
            if (!d.projectValue) {
              return {
                error: `Please pick a ${f.projectLabel.toLowerCase()} for ${f.label} = Project, or choose a different usage.`,
              };
            }
            patch[f.projectKey] = d.projectValue;
          } else {
            // Non-project usage clears any fundable project link.
            patch[f.projectKey] = null;
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
        case "string-array": {
          if (d.values.length === 0) {
            return { error: `Pick at least one value for ${f.label} or untick it.` };
          }
          patch[f.key] = [...d.values];
          patch[f.modeKey] = d.mode;
          // Replace is destructive on the related allocation table —
          // it deletes existing rows before re-inserting.
          if (d.mode === "replace") {
            reasons.push(`${f.label} → Replace (drops existing rows)`);
          }
          break;
        }
      }
    }

    if (Object.keys(patch).length === 0) {
      return { error: "Tick at least one field to update." };
    }

    // Close-transition guard: an enum with `requiresDate` (e.g. lossType)
    // set to a real value needs its companion date in the same patch —
    // rows being newly closed would otherwise fail per-row validation.
    for (const f of fields) {
      if (f.kind !== "enum" || !f.requiresDate) continue;
      const v = patch[f.key];
      if (v === undefined || v === null) continue;
      const dateVal = patch[f.requiresDate.key];
      if (dateVal === undefined || dateVal === null || dateVal === "") {
        return {
          error: `${f.requiresDate.label} is required when setting ${f.label} — records being newly closed need a completion date.`,
        };
      }
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
            ? `Updated ${successCount.toLocaleString()} of ${result.requested.toLocaleString()} ${entityNoun}${result.requested === 1 ? "" : "s"}`
            : `Updated ${successCount.toLocaleString()} of ${result.requested.toLocaleString()} (${failCount.toLocaleString()} failed — see details)`,
        variant: failCount > 0 && successCount === 0 ? "destructive" : undefined,
      });
      onDone(result);
      // Always close the form dialog — failures show in a separate
      // results panel so the user can copy them.
      reset();
      onOpenChange(false);
      if (failCount > 0) {
        setResultPanel(result);
      }
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
      case "owner": {
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
              {userOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
        break;
      }
      case "region": {
        control = (
          <BulkRegionCombobox
            value={d.value}
            onChange={(v) => patchDraft(f.key, { value: v })}
            disabled={!d.enabled}
            nullable={f.nullable}
            options={regionOptions}
          />
        );
        break;
      }
      case "enum": {
        control = (
          <Select
            value={d.value || undefined}
            onValueChange={(v) => {
              patchDraft(f.key, { value: v });
              // Closing values require a completion date on newly-closed
              // rows — pre-fill the companion date field with today so the
              // user sees (and can adjust) it instead of a per-row 400.
              if (f.requiresDate && v !== NULL_SENTINEL) {
                const dd = drafts[f.requiresDate.key];
                if (!dd?.enabled || !dd.value || dd.value === NULL_SENTINEL) {
                  patchDraft(f.requiresDate.key, {
                    enabled: true,
                    value: new Date().toISOString().slice(0, 10),
                  });
                }
              }
            }}
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
      case "intended-usage": {
        control = (
          <div className="space-y-2">
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
                {f.options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {d.enabled && d.value === "project" && (
              <Select
                value={d.projectValue || undefined}
                onValueChange={(v) => patchDraft(f.key, { projectValue: v })}
              >
                <SelectTrigger
                  className="w-full"
                  data-testid={`bulk-select-${f.projectKey}`}
                >
                  <SelectValue placeholder={`Pick a ${f.projectLabel.toLowerCase()}…`} />
                </SelectTrigger>
                <SelectContent>
                  {fundableProjectOptions.length === 0 && (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      No active projects
                    </div>
                  )}
                  {fundableProjectOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
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
      case "string-array": {
        const options = optionsFor(f.source);
        const valuesSet = new Set(d.values);
        control = (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Select
                value={d.mode}
                onValueChange={(v) =>
                  patchDraft(f.key, { mode: v === "replace" ? "replace" : "append" })
                }
                disabled={!d.enabled}
              >
                <SelectTrigger
                  className="w-32"
                  data-testid={`bulk-mode-${f.key}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="append">Append</SelectItem>
                  <SelectItem value="replace">Replace</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                {d.mode === "replace"
                  ? "Drops existing, re-creates from selection"
                  : "Adds only what's missing"}
              </span>
            </div>
            <ScrollArea
              className={`h-32 rounded-md border p-2 ${d.enabled ? "" : "opacity-50"}`}
            >
              <div className="space-y-1">
                {options.length === 0 && (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                )}
                {options.map((o) => {
                  const checked = valuesSet.has(o.value);
                  return (
                    <label
                      key={o.value}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={checked}
                        disabled={!d.enabled}
                        onCheckedChange={(c) => {
                          const next = new Set(valuesSet);
                          if (c === true) next.add(o.value);
                          else next.delete(o.value);
                          patchDraft(f.key, { values: Array.from(next) });
                        }}
                        data-testid={`bulk-array-opt-${f.key}-${o.value}`}
                      />
                      <span>{o.label}</span>
                    </label>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
        );
        break;
      }
    }

    return (
      <div
        key={f.key}
        className={`grid grid-cols-[24px_1fr_2fr] gap-3 ${f.kind === "string-array" ? "items-start" : "items-center"}`}
      >
        <Checkbox
          checked={d.enabled}
          onCheckedChange={(v) => patchDraft(f.key, { enabled: v === true })}
          aria-label={`Update ${f.label}`}
          data-testid={`bulk-toggle-${f.key}`}
          className={f.kind === "string-array" ? "mt-2" : ""}
        />
        <Label
          htmlFor={id}
          className={`${d.enabled ? "" : "text-muted-foreground"} ${f.kind === "string-array" ? "pt-2" : ""}`}
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

          <ScrollArea className="max-h-[60vh] pr-3">
            <div className="space-y-3 py-2">{fields.map(renderField)}</div>
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

      {/* Post-submit results panel — only shown when there were
          per-row failures. Lists every failed id + reason so the user
          can copy them out. Successful rows have already been
          removed from the parent's selection by onDone. */}
      <AlertDialog
        open={!!resultPanel}
        onOpenChange={(o) => {
          if (!o) setResultPanel(null);
        }}
      >
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Bulk update results</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {resultPanel && (
                  <p>
                    Updated{" "}
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
              data-testid="button-bulk-results-close"
            >
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
