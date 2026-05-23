import { useMemo, type ReactNode } from "react";
import {
  useListRegions,
  getListRegionsQueryKey,
  type Region,
} from "@workspace/api-client-react";
import {
  InlineEditSelect,
  type InlineSelectOption,
} from "@/components/inline-edit";

const PAGE_SIZE = 1000;
const QUERY_PARAMS = { limit: PAGE_SIZE } as const;

export function regionDisplayName(r: Region): string {
  return r.displayPath?.trim() || r.name;
}

export function useRegionNameMap(): Map<string, string> {
  const { data } = useListRegions(QUERY_PARAMS, {
    query: {
      queryKey: getListRegionsQueryKey(QUERY_PARAMS),
      staleTime: 5 * 60_000,
    },
  });
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const r of data?.data ?? []) m.set(r.id, regionDisplayName(r));
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

  const options: ReadonlyArray<InlineSelectOption<string>> = useMemo(() => {
    const opts: InlineSelectOption<string>[] = (data?.data ?? []).map((r) => ({
      value: r.id,
      label: regionDisplayName(r),
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

  return (
    <InlineEditSelect
      label={label}
      testIdBase={testIdBase}
      value={value}
      display={display}
      options={options}
      onSave={onSave}
    />
  );
}
