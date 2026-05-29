import { useMemo } from "react";
import {
  useListUsers,
  getListUsersQueryKey,
} from "@workspace/api-client-react";
import {
  BLANK_VALUE,
  MultiFilterSelect,
  type MultiFilterOption,
} from "@/components/multi-filter-select";
import { hasUsableIdentity, userDisplayName } from "@/components/user-picker";

/**
 * Multi-select dropdown for filtering by `owner_user_id`. Sources
 * options from the active users list (same as InlineEditUserPicker).
 * Any currently-selected id that's missing from the active list
 * (e.g. an archived owner persisted in a saved view) is pinned at the
 * top with an "(archived)" suffix so the dropdown stays in sync with
 * the actual filter state instead of silently dropping the chip.
 */
export function OwnerMultiFilter({
  selected,
  onChange,
  testId,
  label = "Owner",
  includeBlank = true,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  testId: string;
  label?: string;
  /** Default true — owner_user_id is nullable on every entity that uses it. */
  includeBlank?: boolean;
}) {
  const { data } = useListUsers({
    query: { queryKey: getListUsersQueryKey(), staleTime: 60_000 },
  });

  const options: MultiFilterOption[] = useMemo(() => {
    const opts: MultiFilterOption[] = (data ?? [])
      .filter(hasUsableIdentity)
      .map((u) => ({
        value: u.id,
        label: userDisplayName(u),
      }));
    opts.sort((a, b) => a.label.localeCompare(b.label));
    // If the currently selected list includes an id we don't know about
    // (archived owner), surface it pinned at the top so the dropdown
    // reflects current state rather than silently dropping the chip.
    // Skip the (Blank) sentinel — it's rendered by MultiFilterSelect
    // itself via `includeBlank` and must not be pinned as an "archived"
    // owner row (would create a duplicate option/key collision).
    for (const id of selected) {
      if (id === BLANK_VALUE) continue;
      if (!opts.some((o) => o.value === id)) {
        opts.unshift({ value: id, label: `${id} (archived)` });
      }
    }
    return opts;
  }, [data, selected]);

  return (
    <MultiFilterSelect
      label={label}
      selected={selected}
      onChange={onChange}
      options={options}
      testId={testId}
      includeBlank={includeBlank}
    />
  );
}
