import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  useListRegions,
  useGetRegionContainment,
  getListRegionsQueryKey,
  getGetRegionContainmentQueryKey,
  type Region,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { buildRegionIndex, regionDisplayName } from "@/components/region-picker";

/**
 * Shared plumbing for every region picker: one data hook, one search matcher
 * (name + displayPath + state abbreviation + aliases), one type-grouped
 * ordering per picker context, recents, type badges, and a containment hook
 * for advisory redundancy hints. Individual pickers stay thin.
 */

export const REGION_QUERY_PARAMS = { limit: 1000 } as const;

/** Picker context — controls which region types lead the grouped list. */
export type RegionPickerContext = "allocation" | "interest" | "home" | "generic";

export interface RegionOption {
  id: string;
  label: string;
  type: string | null;
  displayPath: string;
  aliases: string[];
  /** Pre-lowercased haystack for search. */
  searchText: string;
}

const TYPE_LABELS: Record<string, string> = {
  state: "States",
  metro_area: "Metro areas",
  city: "Cities",
  neighborhood: "Neighborhoods",
  region_within_state: "Regions within a state",
  multi_state_region: "Multi-state regions",
  country: "Countries",
  continent: "Continents",
  custom_region: "Custom groupings",
};

const TYPE_BADGES: Record<string, string> = {
  state: "State",
  metro_area: "Metro",
  city: "City",
  neighborhood: "Neighborhood",
  region_within_state: "In-state region",
  multi_state_region: "Multi-state",
  country: "Country",
  continent: "Continent",
  custom_region: "Grouping",
};

/** Broad-to-narrow ordering (interest / allocation contexts). */
const BROAD_FIRST = [
  "country",
  "multi_state_region",
  "custom_region",
  "state",
  "region_within_state",
  "metro_area",
  "city",
  "neighborhood",
  "continent",
];

/** Narrow/home ordering — where someone lives comes first. */
const HOME_FIRST = [
  "state",
  "city",
  "neighborhood",
  "metro_area",
  "region_within_state",
  "multi_state_region",
  "custom_region",
  "country",
  "continent",
];

function typeOrder(context: RegionPickerContext): string[] {
  return context === "home" ? HOME_FIRST : BROAD_FIRST;
}

export function regionTypeLabel(type: string | null | undefined): string {
  return (type && TYPE_LABELS[type]) || "Other";
}

export function regionTypeBadge(type: string | null | undefined): string {
  return (type && TYPE_BADGES[type]) || "Region";
}

/** Small muted type badge rendered to the right of a picker row. */
export function RegionTypeBadge({ type }: { type: string | null | undefined }) {
  return (
    <Badge
      variant="outline"
      className="ml-auto shrink-0 px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
    >
      {regionTypeBadge(type)}
    </Badge>
  );
}

/** Fetch all regions and derive the shared option list (label + search text). */
export function useRegionOptions(): {
  options: RegionOption[];
  byId: Map<string, RegionOption>;
  isLoading: boolean;
} {
  const { data, isLoading } = useListRegions(REGION_QUERY_PARAMS, {
    query: {
      queryKey: getListRegionsQueryKey(REGION_QUERY_PARAMS),
      staleTime: 5 * 60_000,
    },
  });
  return useMemo(() => {
    const regions = data?.data ?? [];
    const index = buildRegionIndex(regions);
    const options = regions.map((r): RegionOption => {
      const label = regionDisplayName(r, index);
      const aliases = [...(r.aliases ?? [])];
      return {
        id: r.id,
        label,
        type: r.type ?? null,
        displayPath: r.displayPath ?? "",
        aliases,
        searchText: [label, r.name, r.displayPath ?? "", r.stateAbbreviation ?? "", ...aliases]
          .join("\n")
          .toLowerCase(),
      };
    });
    options.sort((a, b) => a.label.localeCompare(b.label));
    const byId = new Map(options.map((o) => [o.id, o]));
    return { options, byId, isLoading };
  }, [data, isLoading]);
}

/** Case-insensitive match over name, displayPath, state abbr, and aliases. */
export function matchesRegionQuery(option: RegionOption, query: string): boolean {
  const term = query.trim().toLowerCase();
  if (!term) return true;
  return option.searchText.includes(term) || option.id.toLowerCase().includes(term);
}

export interface RegionOptionGroup {
  key: string;
  heading: string;
  options: RegionOption[];
}

/**
 * Group options by region type in context order. When a query is present the
 * same grouping applies to the filtered set, so results stay scannable.
 */
export function groupRegionOptions(
  options: ReadonlyArray<RegionOption>,
  context: RegionPickerContext,
): RegionOptionGroup[] {
  const order = typeOrder(context);
  const byType = new Map<string, RegionOption[]>();
  for (const o of options) {
    const key = o.type ?? "__other__";
    const list = byType.get(key) ?? [];
    list.push(o);
    byType.set(key, list);
  }
  const groups: RegionOptionGroup[] = [];
  for (const t of order) {
    const list = byType.get(t);
    if (list?.length) groups.push({ key: t, heading: regionTypeLabel(t), options: list });
    byType.delete(t);
  }
  for (const [t, list] of byType) {
    groups.push({ key: t, heading: regionTypeLabel(t === "__other__" ? null : t), options: list });
  }
  return groups;
}

/* ── Recents (localStorage, per context) ─────────────────────────────────── */

const RECENTS_LIMIT = 6;
const recentsKey = (context: RegionPickerContext) => `wf-region-recents:${context}`;

const recentsListeners = new Set<() => void>();
function emitRecentsChanged() {
  for (const l of recentsListeners) l();
}

function readRecents(context: RegionPickerContext): string[] {
  try {
    const raw = localStorage.getItem(recentsKey(context));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const recentsCache = new Map<string, { raw: string; value: string[] }>();
function readRecentsCached(context: RegionPickerContext): string[] {
  const key = recentsKey(context);
  let raw = "";
  try {
    raw = localStorage.getItem(key) ?? "";
  } catch {
    /* ignore */
  }
  const hit = recentsCache.get(key);
  if (hit && hit.raw === raw) return hit.value;
  const value = readRecents(context);
  recentsCache.set(key, { raw, value });
  return value;
}

/** Reactive recents list + a recorder to call on every selection. */
export function useRegionRecents(context: RegionPickerContext): {
  recents: string[];
  recordRecent: (id: string) => void;
} {
  const subscribe = useCallback((cb: () => void) => {
    recentsListeners.add(cb);
    return () => {
      recentsListeners.delete(cb);
    };
  }, []);
  const recents = useSyncExternalStore(subscribe, () => readRecentsCached(context));
  const recordRecent = useCallback(
    (id: string) => {
      try {
        const next = [id, ...readRecents(context).filter((x) => x !== id)].slice(0, RECENTS_LIMIT);
        localStorage.setItem(recentsKey(context), JSON.stringify(next));
      } catch {
        /* localStorage unavailable — recents are best-effort */
      }
      emitRecentsChanged();
    },
    [context],
  );
  return { recents, recordRecent };
}

/* ── Containment (advisory redundancy + filter expansion indicator) ──────── */

/**
 * For the currently selected ids, derive which other regions are already
 * covered (contained in a selection). Returns:
 *  - `coveredBy`: containedRegionId → selected container id (first found);
 *  - `containedCount`: total distinct regions contained across the selection
 *    (drives the "filter also matches N contained regions" indicator).
 */
export function useRegionContainmentInfo(selectedIds: string[]): {
  coveredBy: Map<string, string>;
  containedCount: number;
  isLoading: boolean;
} {
  const ids = useMemo(() => [...selectedIds].sort(), [selectedIds]);
  const params = { ids };
  const { data, isLoading } = useGetRegionContainment(params, {
    query: {
      queryKey: getGetRegionContainmentQueryKey(params),
      enabled: ids.length > 0 && ids.length <= 200,
      staleTime: 5 * 60_000,
    },
  });
  return useMemo(() => {
    const coveredBy = new Map<string, string>();
    const all = new Set<string>();
    for (const row of data?.data ?? []) {
      for (const contained of row.containedRegionIds) {
        if (!coveredBy.has(contained)) coveredBy.set(contained, row.regionId);
        if (!ids.includes(contained)) all.add(contained);
      }
    }
    return { coveredBy, containedCount: all.size, isLoading };
  }, [data, ids, isLoading]);
}
