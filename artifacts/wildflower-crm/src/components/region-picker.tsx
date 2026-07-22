import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
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
import {
  RegionTypeBadge,
  groupRegionOptions,
  matchesRegionQuery,
  useRegionOptions,
  useRegionRecents,
  type RegionOption,
  type RegionPickerContext,
} from "@/components/region-picker-core";
import { RegionCreateDialog } from "@/components/region-create-dialog";
import { useIsAdmin } from "@/hooks/use-is-admin";

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
 * Inline-edit single-region picker. Search-first (name, path, state
 * abbreviation, alias), type-grouped for the picker context, recents on top,
 * type badges. One-click create is retired: admins get a "New region…" entry
 * that opens the structured create dialog; non-admins can only select.
 */
export function InlineEditRegionPicker({
  value,
  onSave,
  label = "Region",
  testIdBase,
  context = "home",
}: {
  value: string | null;
  onSave: (next: string | null) => unknown | Promise<unknown>;
  label?: string;
  testIdBase?: string;
  context?: RegionPickerContext;
}) {
  const { options, byId } = useRegionOptions();
  const { recents, recordRecent } = useRegionRecents(context);
  const isAdmin = useIsAdmin();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(value);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
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

  const labelFor = (id: string | null) =>
    id ? (byId.get(id)?.label ?? `${id} (unknown)`) : null;

  if (!editing) {
    return (
      <EditTriggerRow
        display={labelFor(value) ?? "—"}
        onEdit={() => setEditing(true)}
        testIdBase={testIdBase}
        ariaLabel={`Edit ${label}`}
      />
    );
  }

  const term = query.trim();
  const visible = term ? options.filter((o) => matchesRegionQuery(o, term)) : options;
  const groups = groupRegionOptions(visible, context);
  const recentOptions = term
    ? []
    : recents.map((id) => byId.get(id)).filter((o): o is RegionOption => !!o);

  const dirty = (draft ?? null) !== (value ?? null);
  const trySave = () => {
    if (!dirty || busy) return;
    run(() => onSave(draft ?? null), () => setEditing(false));
  };
  const select = (next: string | null) => {
    setDraft(next);
    setPopoverOpen(false);
    if (next) recordRecent(next);
  };

  const renderItem = (o: RegionOption) => (
    <CommandItem
      key={o.id}
      value={o.id}
      onSelect={() => select(o.id)}
      data-testid={testIdBase ? `select-${testIdBase}-option-${o.id}` : undefined}
    >
      <Check
        className={cn("mr-2 h-4 w-4", draft === o.id ? "opacity-100" : "opacity-0")}
      />
      <span className="truncate">{o.label}</span>
      <RegionTypeBadge type={o.type} />
    </CommandItem>
  );

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
              {labelFor(draft) ?? `Select ${label.toLowerCase()}…`}
            </span>
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
              data-testid={testIdBase ? `select-${testIdBase}-search` : undefined}
            />
            <CommandList className="max-h-[300px]">
              {visible.length === 0 && !isAdmin ? (
                <CommandEmpty>
                  No matches.
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Can't find this region? Ask an admin to add it.
                  </span>
                </CommandEmpty>
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
              </CommandGroup>
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
      <ActionButtons
        busy={busy}
        canSave={dirty}
        onSave={trySave}
        onCancel={() => setEditing(false)}
        testIdBase={testIdBase}
        label={label}
      />
      {isAdmin && (
        <RegionCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          initialName={term}
          onCreated={(id) => setDraft(id)}
        />
      )}
    </div>
  );
}
