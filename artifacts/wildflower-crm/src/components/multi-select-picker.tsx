import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronsUpDown, Pencil, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import {
  INLINE_EDIT_GROUP,
  EDIT_PENCIL_REVEAL,
  EDIT_VALUE_CLICKABLE,
  makeEditValueClick,
} from "@/components/inline-edit";
import { formatEnum } from "@/lib/format";
import {
  RegionTypeBadge,
  groupRegionOptions,
  matchesRegionQuery,
  useRegionContainmentInfo,
  useRegionOptions,
  useRegionRecents,
  type RegionOption,
  type RegionPickerContext,
} from "@/components/region-picker-core";
import { RegionCreateDialog } from "@/components/region-create-dialog";
import { useIsAdmin } from "@/hooks/use-is-admin";

type SaveResult = unknown | Promise<unknown>;

function useSaveRunner() {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  async function run(fn: () => SaveResult, onDone: () => void) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch {
      // toast handled by caller
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return { busy, run };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Generic multi-select primitive                                           */
/* ──────────────────────────────────────────────────────────────────────── */

export interface MultiSelectOption {
  value: string;
  label: string;
  sublabel?: string;
}

interface InlineEditMultiSelectProps {
  label: string;
  testIdBase?: string;
  /**
   * The value array. Pass `[]` when the record has no tags — `null` from
   * the API should be coerced to `[]` by the caller.
   */
  value: string[];
  options: ReadonlyArray<MultiSelectOption>;
  /**
   * Optional render override for the chip label. Defaults to looking up
   * the option's label, then `formatEnum(v)`, then the raw value.
   */
  renderChipLabel?: (value: string) => string;
  /**
   * If true, the search input shows an "Add '<query>'" affordance whenever
   * the typed query doesn't already exist in options or selection. Allows
   * extending the suggestion set with free-form tags.
   */
  allowCustom?: boolean;
  /**
   * If provided, shown instead of (or alongside) `allowCustom` — calling
   * this async function creates a new option server-side and returns the
   * id/value to add to the current selection. Used by the region picker
   * so that "Create 'X'" POSTs a new region and adds its id.
   */
  onCreateOption?: (label: string) => Promise<string>;
  emptyLabel?: string;
  placeholder?: string;
  onSave: (next: string[] | null) => SaveResult;
  /**
   * If true (default), submitting an empty selection sends `null` instead
   * of `[]`. Most API columns are `text[]?`, so this keeps stored values
   * NULL-when-empty.
   */
  nullWhenEmpty?: boolean;
}

function defaultChipLabel(
  v: string,
  options: ReadonlyArray<MultiSelectOption>,
): string {
  const hit = options.find((o) => o.value === v);
  if (hit) return hit.label;
  return formatEnum(v) || v;
}

export function InlineEditMultiSelect({
  label,
  testIdBase,
  value,
  options,
  renderChipLabel,
  allowCustom = false,
  onCreateOption,
  emptyLabel = "—",
  placeholder,
  onSave,
  nullWhenEmpty = true,
}: InlineEditMultiSelectProps) {
  const [editing, setEditing] = useState(false);
  const { busy, run } = useSaveRunner();
  const [draft, setDraft] = useState<string[]>(value);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creatingOption, setCreatingOption] = useState(false);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      setQuery("");
      setPopoverOpen(false);
    }
  }, [editing, value]);

  // Clear search input when the suggestions popover closes so reopening
  // starts fresh.
  useEffect(() => {
    if (!popoverOpen) setQuery("");
  }, [popoverOpen]);

  const chipLabel = (v: string) =>
    renderChipLabel ? renderChipLabel(v) : defaultChipLabel(v, options);

  // Read mode: chips + pencil edit button.
  if (!editing) {
    return (
      <div className={cn(INLINE_EDIT_GROUP, "flex items-start gap-2 min-w-0")}>
        <div
          className={cn(
            "flex flex-wrap gap-1 flex-1 min-w-0 justify-end",
            EDIT_VALUE_CLICKABLE,
          )}
          onClick={makeEditValueClick(() => setEditing(true))}
          title={`Edit ${label}`}
        >
          {value.length === 0 ? (
            <span className="text-muted-foreground">{emptyLabel}</span>
          ) : (
            value.map((v) => (
              <Badge
                key={v}
                variant="secondary"
                data-testid={
                  testIdBase ? `chip-${testIdBase}-${v}` : undefined
                }
              >
                {chipLabel(v)}
              </Badge>
            ))
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground",
            EDIT_PENCIL_REVEAL,
          )}
          onClick={() => setEditing(true)}
          aria-label={`Edit ${label}`}
          data-testid={testIdBase ? `button-edit-${testIdBase}` : undefined}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  // ── Edit mode ──
  const draftSet = new Set(draft);
  const visibleOptions = options.filter((o) => {
    if (!query.trim()) return true;
    const term = query.trim().toLowerCase();
    return (
      o.label.toLowerCase().includes(term) ||
      o.value.toLowerCase().includes(term)
    );
  });
  const trimmedQuery = query.trim();
  const exactMatchExists =
    !!trimmedQuery &&
    (options.some(
      (o) =>
        o.value.toLowerCase() === trimmedQuery.toLowerCase() ||
        o.label.toLowerCase() === trimmedQuery.toLowerCase(),
    ) ||
      draft.some((v) => v.toLowerCase() === trimmedQuery.toLowerCase()));
  const showAddCustom = allowCustom && !!trimmedQuery && !exactMatchExists;
  const showCreateOption =
    !!onCreateOption &&
    !!trimmedQuery &&
    visibleOptions.length === 0 &&
    !creatingOption;

  const toggle = (v: string) => {
    setDraft((d) =>
      d.includes(v) ? d.filter((x) => x !== v) : [...d, v],
    );
  };
  const removeChip = (v: string) => setDraft((d) => d.filter((x) => x !== v));
  const addCustom = () => {
    if (!trimmedQuery) return;
    if (!draft.includes(trimmedQuery)) setDraft((d) => [...d, trimmedQuery]);
    setQuery("");
  };
  const handleCreateOption = async () => {
    if (!trimmedQuery || !onCreateOption || creatingOption) return;
    setCreatingOption(true);
    try {
      const newValue = await onCreateOption(trimmedQuery);
      setDraft((d) => (d.includes(newValue) ? d : [...d, newValue]));
      setQuery("");
    } finally {
      setCreatingOption(false);
    }
  };

  const arraysEqual = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
  };
  const dirty = !arraysEqual(draft, value);
  const trySave = () => {
    if (!dirty || busy) return;
    const next = nullWhenEmpty && draft.length === 0 ? null : draft;
    run(() => onSave(next), () => setEditing(false));
  };

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex flex-wrap gap-1 min-w-0">
        {draft.length === 0 ? (
          <span className="text-muted-foreground text-xs">{emptyLabel}</span>
        ) : (
          draft.map((v) => (
            <Badge
              key={v}
              variant="secondary"
              className="gap-1 pr-1"
              data-testid={
                testIdBase ? `chip-${testIdBase}-${v}` : undefined
              }
            >
              {chipLabel(v)}
              <button
                type="button"
                onClick={() => removeChip(v)}
                disabled={busy}
                aria-label={`Remove ${chipLabel(v)}`}
                className="rounded hover:bg-muted-foreground/10"
                data-testid={
                  testIdBase ? `button-remove-${testIdBase}-${v}` : undefined
                }
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))
        )}
      </div>

      <div className="flex items-center gap-1 min-w-0">
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              size="sm"
              className="h-8 min-w-0 flex-1 justify-between font-normal"
              disabled={busy}
              data-testid={
                testIdBase ? `select-${testIdBase}` : undefined
              }
            >
              <span className="truncate">
                {placeholder ?? `Add ${label.toLowerCase()}…`}
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="p-0 w-[--radix-popover-trigger-width] min-w-[260px]"
            align="start"
          >
            <Command shouldFilter={false}>
              <CommandInput
                value={query}
                onValueChange={setQuery}
                placeholder={`Search ${label.toLowerCase()}…`}
                data-testid={
                  testIdBase ? `select-${testIdBase}-search` : undefined
                }
              />
              <CommandList>
                {visibleOptions.length === 0 && !showAddCustom && !showCreateOption ? (
                  <CommandEmpty>No matches.</CommandEmpty>
                ) : null}
                {visibleOptions.length > 0 ? (
                  <CommandGroup>
                    {visibleOptions.map((o) => {
                      const selected = draftSet.has(o.value);
                      return (
                        <CommandItem
                          key={o.value}
                          value={o.value}
                          onSelect={() => toggle(o.value)}
                          data-testid={
                            testIdBase
                              ? `select-${testIdBase}-option-${o.value}`
                              : undefined
                          }
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              selected ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <div className="flex flex-col min-w-0">
                            <span className="truncate">{o.label}</span>
                            {o.sublabel ? (
                              <span className="truncate text-xs text-muted-foreground">
                                {o.sublabel}
                              </span>
                            ) : null}
                          </div>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ) : null}
                {showAddCustom ? (
                  <CommandGroup heading="New tag">
                    <CommandItem
                      value={`__add__${trimmedQuery}`}
                      onSelect={addCustom}
                      data-testid={
                        testIdBase
                          ? `select-${testIdBase}-add-custom`
                          : undefined
                      }
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add &ldquo;{trimmedQuery}&rdquo;
                    </CommandItem>
                  </CommandGroup>
                ) : null}
                {showCreateOption ? (
                  <CommandGroup heading="New region">
                    <CommandItem
                      value={`__create__${trimmedQuery}`}
                      onSelect={handleCreateOption}
                      disabled={creatingOption}
                      data-testid={
                        testIdBase
                          ? `select-${testIdBase}-create`
                          : undefined
                      }
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      {creatingOption ? "Creating…" : `Create "${trimmedQuery}"`}
                    </CommandItem>
                  </CommandGroup>
                ) : null}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-primary"
          disabled={!dirty || busy}
          onClick={trySave}
          aria-label={`Save ${label}`}
          data-testid={testIdBase ? `button-save-${testIdBase}` : undefined}
        >
          <Check className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground"
          disabled={busy}
          onClick={() => setEditing(false)}
          aria-label={`Cancel ${label}`}
          data-testid={testIdBase ? `button-cancel-${testIdBase}` : undefined}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Suggestion sets for the interests* tag arrays                            */
/*                                                                          */
/* Canonical normalized set of distinct values across the organizations +    */
/* people tables (legacy snake_case + casing duplicates were merged into     */
/* these — see lib/db/migrations/0007). Both columns are free-form text[]    */
/* server-side (no enum), so users can add new tags via the "Add 'X'"       */
/* affordance — the lists here are just convenience suggestions.            */
/* ──────────────────────────────────────────────────────────────────────── */

export const INTERESTS_THEMATIC_SUGGESTIONS: ReadonlyArray<MultiSelectOption> =
  [
    { value: "Black Wildflowers Fund", label: "Black Wildflowers Fund" },
    { value: "Data accountability", label: "Data accountability" },
    { value: "Data-driven instruction", label: "Data-driven instruction" },
    { value: "Decentralized Governance", label: "Decentralized Governance" },
    { value: "ECE policy", label: "ECE policy" },
    { value: "Ed tech", label: "Ed tech" },
    { value: "Geographic", label: "Geographic" },
    { value: "Intentional diversity", label: "Intentional diversity" },
    { value: "Microschools", label: "Microschools" },
    { value: "Montessori", label: "Montessori" },
    { value: "Parent engagement", label: "Parent engagement" },
    { value: "Platform Innovations", label: "Platform Innovations" },
    { value: "Racial equity & justice", label: "Racial equity & justice" },
    { value: "Socio-emotional learning", label: "Socio-emotional learning" },
    { value: "Tax credits", label: "Tax credits" },
    { value: "Women", label: "Women" },
    { value: "Workforce development", label: "Workforce development" },
    { value: "Youth", label: "Youth" },
  ];

export const INTERESTS_AGES_SUGGESTIONS: ReadonlyArray<MultiSelectOption> = [
  { value: "Early childhood", label: "Early childhood" },
  { value: "Elementary", label: "Elementary" },
  { value: "Secondary", label: "Secondary" },
  { value: "Post-secondary", label: "Post-secondary" },
];

export const INTERESTS_GOV_MODELS_SUGGESTIONS: ReadonlyArray<MultiSelectOption> =
  [
    { value: "Charter", label: "Charter" },
    { value: "Voucher", label: "Voucher" },
  ];

/* ──────────────────────────────────────────────────────────────────────── */
/* Multi-region picker                                                      */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Inline-edit multi-region picker built on the shared region picker core:
 * search-first (name, path, state abbreviation, alias), type-grouped for the
 * picker context, recents, type badges, and advisory-disabled redundant rows
 * ("Already included through X") when a candidate is already contained in a
 * selected region — labeled and visible, never hidden or auto-removed.
 * One-click create is retired — admins get a "New region…" entry that opens
 * the structured create dialog; everyone else can only select.
 * Saves as `string[]` of region ids; clears to `null` when empty.
 */
export function InlineEditMultiRegionPicker({
  value,
  onSave,
  testIdBase,
  label = "Regions",
  context = "interest",
}: {
  value: string[];
  onSave: (next: string[] | null) => SaveResult;
  testIdBase?: string;
  label?: string;
  context?: RegionPickerContext;
}) {
  const [editing, setEditing] = useState(false);
  const { busy, run } = useSaveRunner();
  const [draft, setDraft] = useState<string[]>(value);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const { options, byId } = useRegionOptions();
  const { recents, recordRecent } = useRegionRecents(context);
  const isAdmin = useIsAdmin();
  const { coveredBy } = useRegionContainmentInfo(editing ? draft : []);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      setQuery("");
      setPopoverOpen(false);
    }
  }, [editing, value]);

  useEffect(() => {
    if (!popoverOpen) setQuery("");
  }, [popoverOpen]);

  const chipLabel = (v: string) => byId.get(v)?.label ?? v;

  // Read mode: chips + pencil edit button.
  if (!editing) {
    return (
      <div className={cn(INLINE_EDIT_GROUP, "flex items-start gap-2 min-w-0")}>
        <div
          className={cn(
            "flex flex-wrap gap-1 flex-1 min-w-0 justify-end",
            EDIT_VALUE_CLICKABLE,
          )}
          onClick={makeEditValueClick(() => setEditing(true))}
          title={`Edit ${label}`}
        >
          {value.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            value.map((v) => (
              <Badge
                key={v}
                variant="secondary"
                data-testid={testIdBase ? `chip-${testIdBase}-${v}` : undefined}
              >
                {chipLabel(v)}
              </Badge>
            ))
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground",
            EDIT_PENCIL_REVEAL,
          )}
          onClick={() => setEditing(true)}
          aria-label={`Edit ${label}`}
          data-testid={testIdBase ? `button-edit-${testIdBase}` : undefined}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  // ── Edit mode ──
  const term = query.trim();
  const visible = term
    ? options.filter((o) => matchesRegionQuery(o, term))
    : options;
  const groups = groupRegionOptions(visible, context);
  const recentOptions = term
    ? []
    : recents.map((id) => byId.get(id)).filter((o): o is RegionOption => !!o);

  const toggle = (v: string) => {
    setDraft((d) => {
      if (d.includes(v)) return d.filter((x) => x !== v);
      recordRecent(v);
      return [...d, v];
    });
  };
  const removeChip = (v: string) => setDraft((d) => d.filter((x) => x !== v));

  const arraysEqual = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
  };
  const dirty = !arraysEqual(draft, value);
  const trySave = () => {
    if (!dirty || busy) return;
    const next = draft.length === 0 ? null : draft;
    run(() => onSave(next), () => setEditing(false));
  };

  const renderItem = (o: RegionOption) => {
    const checked = draft.includes(o.id);
    const container = !checked ? coveredBy.get(o.id) : undefined;
    return (
      <CommandItem
        key={o.id}
        value={o.id}
        onSelect={() => toggle(o.id)}
        disabled={!!container}
        className={cn(container && "opacity-60")}
        data-testid={
          testIdBase ? `select-${testIdBase}-option-${o.id}` : undefined
        }
      >
        <Check
          className={cn(
            "mr-2 h-4 w-4 shrink-0",
            checked ? "opacity-100" : "opacity-0",
          )}
        />
        <span className="truncate">{o.label}</span>
        {container ? (
          <Badge
            variant="outline"
            className="ml-auto max-w-[14rem] shrink-0 truncate px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
          >
            Already included through {chipLabel(container)}
          </Badge>
        ) : (
          <RegionTypeBadge type={o.type} />
        )}
      </CommandItem>
    );
  };

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex flex-wrap gap-1 min-w-0">
        {draft.length === 0 ? (
          <span className="text-muted-foreground text-xs">—</span>
        ) : (
          draft.map((v) => (
            <Badge
              key={v}
              variant="secondary"
              className="gap-1 pr-1"
              data-testid={testIdBase ? `chip-${testIdBase}-${v}` : undefined}
            >
              {chipLabel(v)}
              <button
                type="button"
                onClick={() => removeChip(v)}
                disabled={busy}
                aria-label={`Remove ${chipLabel(v)}`}
                className="rounded hover:bg-muted-foreground/10"
                data-testid={
                  testIdBase ? `button-remove-${testIdBase}-${v}` : undefined
                }
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))
        )}
      </div>

      <div className="flex items-center gap-1 min-w-0">
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              size="sm"
              className="h-8 min-w-0 flex-1 justify-between font-normal"
              disabled={busy}
              data-testid={testIdBase ? `select-${testIdBase}` : undefined}
            >
              <span className="truncate">Add region…</span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="p-0 w-[--radix-popover-trigger-width] min-w-[280px]"
            align="start"
          >
            <Command shouldFilter={false}>
              <CommandInput
                value={query}
                onValueChange={setQuery}
                placeholder="Search name, state, or alias…"
                data-testid={
                  testIdBase ? `select-${testIdBase}-search` : undefined
                }
              />
              <CommandList className="max-h-[300px]">
                {visible.length === 0 && !isAdmin ? (
                  <CommandEmpty>
                    No regions match.
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Can't find this region? Ask an admin to add it.
                    </span>
                  </CommandEmpty>
                ) : null}
                {recentOptions.length > 0 && (
                  <CommandGroup heading="Recent">
                    {recentOptions.map((o) => renderItem(o))}
                  </CommandGroup>
                )}
                {groups.map((g) => (
                  <CommandGroup key={g.key} heading={g.heading}>
                    {g.options.map((o) => renderItem(o))}
                  </CommandGroup>
                ))}
                {isAdmin && (
                  <CommandGroup heading="Admin">
                    <CommandItem
                      value="__create__"
                      onSelect={() => {
                        setPopoverOpen(false);
                        setCreateOpen(true);
                      }}
                      data-testid={
                        testIdBase ? `select-${testIdBase}-create` : undefined
                      }
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      New region…
                    </CommandItem>
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          size="sm"
          className="h-8"
          disabled={!dirty || busy}
          onClick={trySave}
          data-testid={testIdBase ? `button-save-${testIdBase}` : undefined}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8"
          disabled={busy}
          onClick={() => setEditing(false)}
          data-testid={testIdBase ? `button-cancel-${testIdBase}` : undefined}
        >
          Cancel
        </Button>
      </div>
      {isAdmin && (
        <RegionCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          initialName={term}
          onCreated={(id) =>
            setDraft((d) => (d.includes(id) ? d : [...d, id]))
          }
        />
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Convenience wrapper used by Person + Funder Interests cards              */
/* ──────────────────────────────────────────────────────────────────────── */

export function InlineEditInterestsThematic({
  value,
  onSave,
  testIdBase,
}: {
  value: string[];
  onSave: (next: string[] | null) => SaveResult;
  testIdBase?: string;
}) {
  return (
    <InlineEditMultiSelect
      label="Thematic interests"
      testIdBase={testIdBase}
      value={value}
      options={INTERESTS_THEMATIC_SUGGESTIONS}
      allowCustom
      onSave={onSave}
      placeholder="Add thematic interest…"
    />
  );
}

/**
 * Free-text multi-value editor for an org's prior names (`historicalNames`).
 * No suggestion set — every entry is an arbitrary proper name typed by the
 * user, so we render chips verbatim (no enum formatting) and add each typed
 * value via the "Add …" affordance. Saves as a `string[]`, clearing to
 * `null` when empty.
 */
export function InlineEditHistoricalNames({
  value,
  onSave,
  testIdBase,
}: {
  value: string[];
  onSave: (next: string[] | null) => SaveResult;
  testIdBase?: string;
}) {
  return (
    <InlineEditMultiSelect
      label="Historical names"
      testIdBase={testIdBase}
      value={value}
      options={[]}
      allowCustom
      renderChipLabel={(v) => v}
      onSave={onSave}
      placeholder="Add a prior name…"
    />
  );
}

export function InlineEditInterestsAges({
  value,
  onSave,
  testIdBase,
}: {
  value: string[];
  onSave: (next: string[] | null) => SaveResult;
  testIdBase?: string;
}) {
  return (
    <InlineEditMultiSelect
      label="Age interests"
      testIdBase={testIdBase}
      value={value}
      options={INTERESTS_AGES_SUGGESTIONS}
      allowCustom
      onSave={onSave}
      placeholder="Add age range…"
    />
  );
}

export function InlineEditInterestsGovModels({
  value,
  onSave,
  testIdBase,
}: {
  value: string[];
  onSave: (next: string[] | null) => SaveResult;
  testIdBase?: string;
}) {
  return (
    <InlineEditMultiSelect
      label="Gov models"
      testIdBase={testIdBase}
      value={value}
      options={INTERESTS_GOV_MODELS_SUGGESTIONS}
      allowCustom
      onSave={onSave}
      placeholder="Add governance model…"
    />
  );
}
