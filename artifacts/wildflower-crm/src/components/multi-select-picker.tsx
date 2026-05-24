import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronsUpDown, Pencil, Plus, X } from "lucide-react";
import {
  useListRegions,
  getListRegionsQueryKey,
} from "@workspace/api-client-react";
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
import { regionDisplayName } from "@/components/region-picker";
import { formatEnum } from "@/lib/format";

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
      <div className="flex items-start gap-2 min-w-0">
        <div className="flex flex-wrap gap-1 flex-1 min-w-0 justify-end">
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
          className="h-6 w-6 text-muted-foreground hover:text-foreground shrink-0"
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
                {visibleOptions.length === 0 && !showAddCustom ? (
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
/* These are the union of distinct values observed across the funders +     */
/* people tables in the seeded DB. Both columns are free-form text[]        */
/* server-side (no enum), so users can add new tags via the "Add 'X'"       */
/* affordance — the lists here are just convenience suggestions.            */
/* ──────────────────────────────────────────────────────────────────────── */

export const INTERESTS_THEMATIC_SUGGESTIONS: ReadonlyArray<MultiSelectOption> =
  [
    { value: "Black Wildflowers Fund", label: "Black Wildflowers Fund" },
    { value: "Data-driven instruction", label: "Data-driven instruction" },
    { value: "data_accountability", label: "Data accountability" },
    { value: "Decentralized Governance", label: "Decentralized governance" },
    { value: "ECE policy", label: "ECE policy" },
    { value: "ece_policy", label: "ECE policy (legacy)" },
    { value: "Ed tech", label: "Ed tech" },
    { value: "ed_tech", label: "Ed tech (legacy)" },
    { value: "family_engagement", label: "Family engagement" },
    { value: "Geographic", label: "Geographic" },
    { value: "Intentional diversity", label: "Intentional diversity" },
    { value: "intentional_diversity", label: "Intentional diversity (legacy)" },
    { value: "Microschools", label: "Microschools" },
    {
      value: "microschools_teacher_leadership",
      label: "Microschools / teacher leadership",
    },
    { value: "Montessori", label: "Montessori" },
    { value: "montessori", label: "Montessori (legacy)" },
    { value: "Parent engagement", label: "Parent engagement" },
    { value: "Platform Innovations", label: "Platform innovations" },
    { value: "Racial Justice", label: "Racial justice" },
    { value: "racial_equity", label: "Racial equity (legacy)" },
    { value: "social_emotional", label: "Social-emotional" },
    { value: "Socio-emotional learning", label: "Socio-emotional learning" },
    { value: "Tax credits", label: "Tax credits" },
    { value: "Women", label: "Women" },
    { value: "women", label: "Women (legacy)" },
    { value: "Workforce development", label: "Workforce development" },
    { value: "workforce", label: "Workforce (legacy)" },
    { value: "youth", label: "Youth" },
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

const REGION_QUERY_PARAMS = { limit: 1000 } as const;

/**
 * Inline-edit multi-region picker. Sources all regions (~568 rows, well
 * under the 1000 cap) from /api/regions and shows each region's full
 * displayPath so users can disambiguate same-named regions. Saves the
 * selection as a `string[]` of region ids; clears to `null` when empty.
 */
export function InlineEditMultiRegionPicker({
  value,
  onSave,
  testIdBase,
  label = "Regions",
}: {
  value: string[];
  onSave: (next: string[] | null) => SaveResult;
  testIdBase?: string;
  label?: string;
}) {
  const { data } = useListRegions(REGION_QUERY_PARAMS, {
    query: {
      queryKey: getListRegionsQueryKey(REGION_QUERY_PARAMS),
      staleTime: 5 * 60_000,
    },
  });
  const options: ReadonlyArray<MultiSelectOption> = useMemo(() => {
    const opts: MultiSelectOption[] = (data?.data ?? []).map((r) => ({
      value: r.id,
      label: regionDisplayName(r),
    }));
    opts.sort((a, b) => a.label.localeCompare(b.label));
    // Defensive: pin unknown ids so re-saving doesn't silently drop them.
    for (const v of value) {
      if (!opts.some((o) => o.value === v)) {
        opts.unshift({ value: v, label: `${v} (unknown)` });
      }
    }
    return opts;
  }, [data, value]);
  const labelMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of options) m.set(o.value, o.label);
    return m;
  }, [options]);

  return (
    <InlineEditMultiSelect
      label={label}
      testIdBase={testIdBase}
      value={value}
      options={options}
      renderChipLabel={(v) => labelMap.get(v) ?? v}
      onSave={onSave}
      placeholder="Add region…"
    />
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
