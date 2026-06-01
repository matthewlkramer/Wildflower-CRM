import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  useListRegions,
  getListRegionsQueryKey,
  type Region,
} from "@workspace/api-client-react";
import {
  EditTriggerRow,
  ActionButtons,
  useSaveRunner,
} from "@/components/inline-edit";
import { Button } from "@/components/ui/button";
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
import { abbreviateUsStates } from "@/lib/format";

const PAGE_SIZE = 1000;
const QUERY_PARAMS = { limit: PAGE_SIZE } as const;

// Walk the parentRegionId chain (starting from r itself) and return the first
// ancestor of the given type, or undefined. Guards against cycles/missing
// parents so a malformed chain can't loop forever.
function findAncestorOfType(
  r: Region,
  byId: Map<string, Region>,
  type: NonNullable<Region["type"]>,
): Region | undefined {
  let cur: Region | undefined = r;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    if (cur.type === type) return cur;
    seen.add(cur.id);
    cur = cur.parentRegionId ? byId.get(cur.parentRegionId) : undefined;
  }
  return undefined;
}

// Resolve the USPS-style state abbreviation for a region by finding its
// state-type ancestor. US states carry `stateAbbreviation` (e.g. "MA");
// non-US "state" rows (provinces, etc.) usually don't, so we fall back to
// their name run through the US-state abbreviator (a no-op for non-US names).
function stateAbbrFor(r: Region, byId: Map<string, Region>): string {
  const s = findAncestorOfType(r, byId, "state");
  if (!s) return "";
  return s.stateAbbreviation || abbreviateUsStates(s.name);
}

// Legacy displayPath-based label, used as the fallback for region types the
// type-aware rules don't cover (region-within-state, country, continent,
// untyped/non-US rows). The seed data uses "United States" as the implicit
// default country — every US region's displayPath starts with
// "United States, ...". Strip that prefix (and treat the bare "united_states"
// region as having no display) so US regions render as their state/metro path
// and non-US regions still lead with their country (e.g.
// "Canada, British Columbia", "Asia, China, Beijing").
function regionDisplayPathLabel(r: Region): string {
  const raw = r.displayPath?.trim() || r.name;
  if (raw === "United States") return "";
  const stripped = raw.startsWith("United States, ")
    ? raw.slice("United States, ".length)
    : raw;
  return abbreviateUsStates(stripped);
}

/**
 * Type-aware region label. Formatting depends on the region's `type` so it
 * reads naturally instead of dumping the full geographic path:
 *   - state               → "Minnesota"
 *   - multi_state_region  → "Great Lakes Region"
 *   - region_within_state → "Western Massachusetts, MA" (skips parent metro/multi-state)
 *   - metro_area          → "Greater Boston, MA"
 *   - city                → "Boston, MA"            (skips the metro level)
 *   - neighborhood        → "Back Bay, Boston, MA"
 * State names are abbreviated when they appear as a suffix; cities, metros,
 * regions-within-state, and states never include a multi-state region name.
 *
 * `byId` is the full id→region lookup so the helper can resolve ancestors
 * (state, and city for neighborhoods). When it's omitted, or when a US-style
 * state can't be resolved (non-US rows), we fall back to the displayPath label.
 */
export function regionDisplayName(
  r: Region,
  byId?: Map<string, Region>,
): string {
  if (!byId) return regionDisplayPathLabel(r);

  switch (r.type) {
    case "state":
      return r.name;
    case "multi_state_region":
      return r.name;
    case "region_within_state":
    case "metro_area":
    case "city": {
      const abbr = stateAbbrFor(r, byId);
      return abbr ? `${r.name}, ${abbr}` : regionDisplayPathLabel(r);
    }
    case "neighborhood": {
      const abbr = stateAbbrFor(r, byId);
      if (!abbr) return regionDisplayPathLabel(r);
      const city = findAncestorOfType(r, byId, "city");
      const parts = city ? [r.name, city.name, abbr] : [r.name, abbr];
      return parts.join(", ");
    }
    default:
      return regionDisplayPathLabel(r);
  }
}

// Build an id→region lookup so display helpers can resolve ancestors.
export function buildRegionIndex(
  regions: ReadonlyArray<Region>,
): Map<string, Region> {
  const m = new Map<string, Region>();
  for (const r of regions) m.set(r.id, r);
  return m;
}

export function useRegionNameMap(): Map<string, string> {
  const { data } = useListRegions(QUERY_PARAMS, {
    query: {
      queryKey: getListRegionsQueryKey(QUERY_PARAMS),
      staleTime: 5 * 60_000,
    },
  });
  return useMemo(() => {
    const regions = data?.data ?? [];
    const byId = buildRegionIndex(regions);
    const m = new Map<string, string>();
    for (const r of regions) m.set(r.id, regionDisplayName(r, byId));
    return m;
  }, [data]);
}

/**
 * Inline-edit Region picker. Sources options from /api/regions and
 * surfaces each region's full displayPath (e.g.
 * "United States, Massachusetts, Greater Boston, Boston") so users can
 * disambiguate same-named regions across states/countries.
 *
 * Pages pass a `display` fallback resolved via useRegionNameMap so the
 * read-mode label shows the name instead of a raw slug.
 */
export function InlineEditRegionPicker({
  value,
  display,
  onSave,
  label = "Region",
  testIdBase,
}: {
  value: string | null;
  display: ReactNode;
  onSave: (next: string | null) => unknown | Promise<unknown>;
  label?: string;
  testIdBase?: string;
}) {
  const { data } = useListRegions(QUERY_PARAMS, {
    query: {
      queryKey: getListRegionsQueryKey(QUERY_PARAMS),
      staleTime: 5 * 60_000,
    },
  });

  const options: ReadonlyArray<{ value: string; label: string }> = useMemo(() => {
    const regions = data?.data ?? [];
    const byId = buildRegionIndex(regions);
    const opts = regions.map((r) => ({
      value: r.id,
      label: regionDisplayName(r, byId),
    }));
    opts.sort((a, b) => a.label.localeCompare(b.label));
    // If the current value isn't in the fetched list (shouldn't happen
    // with a 1000-row cap covering ~568 regions, but defensive), pin it
    // at the top so editing doesn't silently clear the selection.
    if (value && !opts.some((o) => o.value === value)) {
      opts.unshift({ value, label: `${value} (unknown)` });
    }
    return opts;
  }, [data, value]);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(value);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { busy, run } = useSaveRunner();

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

  if (!editing) {
    return (
      <EditTriggerRow
        display={display}
        onEdit={() => setEditing(true)}
        testIdBase={testIdBase}
        ariaLabel={`Edit ${label}`}
      />
    );
  }

  const selectedLabel = draft
    ? (options.find((o) => o.value === draft)?.label ?? draft)
    : null;

  const term = query.trim().toLowerCase();
  const visibleOptions = term
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(term) ||
          o.value.toLowerCase().includes(term),
      )
    : options;

  const dirty = (draft ?? null) !== (value ?? null);
  const trySave = () => {
    if (!dirty || busy) return;
    run(() => onSave(draft ?? null), () => setEditing(false));
  };
  const select = (next: string | null) => {
    setDraft(next);
    setPopoverOpen(false);
  };

  return (
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
            <span className="truncate">
              {selectedLabel ?? `Select ${label.toLowerCase()}…`}
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
              {visibleOptions.length === 0 ? (
                <CommandEmpty>No matches.</CommandEmpty>
              ) : null}
              <CommandGroup>
                <CommandItem
                  value="__null__"
                  onSelect={() => select(null)}
                  data-testid={
                    testIdBase ? `select-${testIdBase}-option-none` : undefined
                  }
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      draft === null ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="text-muted-foreground">— None —</span>
                </CommandItem>
                {visibleOptions.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={o.value}
                    onSelect={() => select(o.value)}
                    data-testid={
                      testIdBase
                        ? `select-${testIdBase}-option-${o.value}`
                        : undefined
                    }
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        draft === o.value ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="truncate">{o.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <ActionButtons
        busy={busy}
        canSave={dirty}
        onSave={trySave}
        onCancel={() => setEditing(false)}
        testIdBase={testIdBase}
        label={label}
      />
    </div>
  );
}
