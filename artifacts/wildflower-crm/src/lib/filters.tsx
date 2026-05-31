import * as React from "react";

// Shared infrastructure for user-customizable list-page filters.
//
// Mirrors `lib/columns.tsx` but for the filter toolbar. Each list page
// declares a typed `FilterDef[]` describing every available filter
// control (label + a render function for the control itself). The page
// persists a small `FiltersState` blob capturing which optional filters
// the user has hidden. The default (no customization) is represented as
// `null`, which lets the saved-views shallow-equal comparator treat
// "haven't touched filters" as equivalent to an old saved view that
// predates this feature.
//
// Unlike columns, filters are NOT reorderable (out of scope) — the
// chooser only toggles visibility. A `required` filter (e.g. the name
// search box) is always shown and can never be hidden.
//
// Hiding a filter that currently holds a value must not silently keep
// narrowing the results. The page supplies a `clear` callback per
// filter; the menu invokes it when the user hides an active filter.

export type FilterDef = {
  /** Stable key used by saved-view blobs and react keys. */
  key: string;
  /** Human label shown in the chooser menu. */
  label: string;
  /** Renders the actual filter control in the toolbar. */
  render: () => React.ReactNode;
  /** True when this filter currently holds a non-empty value. */
  active?: boolean;
  /**
   * Reset this filter's value to empty/default. Called when the user
   * hides the filter so a hidden filter never silently narrows results.
   */
  clear?: () => void;
  /** Defaults to true. Set false on infrequently-useful filters. */
  defaultVisible?: boolean;
  /**
   * When true, the filter can't be hidden via the chooser (the menu
   * just doesn't offer a checkbox). Use for the name search box.
   */
  required?: boolean;
};

export type FiltersState = {
  /**
   * All filter keys present when the state was saved. Used the same way
   * as `ColumnsState.order`: a registry filter absent from `known` is a
   * newly-introduced filter and follows its registry default instead of
   * the saved hidden list, so a new opt-in filter stays hidden until the
   * user has actually seen/toggled it.
   */
  known: string[];
  /** Keys the user has explicitly hidden. Required filters are ignored. */
  hidden: string[];
};

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

/**
 * Reduce the registry through the user's saved state into the list of
 * visible filters to render, in registry order. Tolerates missing /
 * stale keys on both sides so adding or removing a filter from a page
 * doesn't invalidate existing saved views.
 */
export function resolveFilters(
  registry: readonly FilterDef[],
  state: FiltersState | null | undefined,
): FilterDef[] {
  const hasState = !!(state?.known && state.known.length > 0);
  const knownSet = new Set(state?.known ?? []);
  const hiddenSet = new Set(state?.hidden ?? []);
  return registry.filter((def) => {
    if (def.required) return true;
    // A filter the saved state predates entirely follows its registry
    // default so newly-introduced opt-in filters stay hidden.
    if (hasState && !knownSet.has(def.key)) return def.defaultVisible ?? true;
    if (hiddenSet.has(def.key)) return false;
    if (hasState) return true;
    return def.defaultVisible ?? true;
  });
}

/**
 * Produce the canonical "no customization" state derived from a
 * registry. Used by the filters menu's Reset button.
 */
export function defaultFiltersState(
  registry: readonly FilterDef[],
): FiltersState {
  return {
    known: registry.map((f) => f.key),
    hidden: registry
      .filter((f) => f.defaultVisible === false && !f.required)
      .map((f) => f.key),
  };
}

/**
 * True when the given state matches the registry defaults. Pages use
 * this to persist `null` (canonical default) vs the explicit state,
 * keeping saved-view comparisons stable for users who never touched
 * their filters.
 */
export function isDefaultFiltersState(
  registry: readonly FilterDef[],
  state: FiltersState | null | undefined,
): boolean {
  if (!state) return true;
  const def = defaultFiltersState(registry);
  return sameSet(state.known, def.known) && sameSet(state.hidden, def.hidden);
}
