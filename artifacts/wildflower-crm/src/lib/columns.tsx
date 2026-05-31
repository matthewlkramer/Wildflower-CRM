import * as React from "react";

// Shared infrastructure for user-customizable list-page columns.
//
// Each list page declares a typed `ColumnDef<R>[]` describing every
// available column (header + cell renderer + sort key + alignment).
// The page persists a small `ColumnsState` blob that captures the
// user's column order and which optional columns are hidden. The
// default (no customization) is represented as `null`, which lets the
// saved-views shallow-equal comparator treat "haven't touched columns"
// as equivalent to an old saved view that predates the feature.
//
// Required columns (anchor columns like the name link) are listed in
// `required: true` on their definition and can never be hidden — the
// menu just doesn't offer the checkbox for them. They still
// participate in reordering.

export type ColumnDef<R> = {
  /** Stable key used by saved-view blobs and react keys. */
  key: string;
  /** Human label shown in the header AND the columns menu. */
  label: string;
  /** Rendered inside <TableCell> for each row. */
  cell: (row: R) => React.ReactNode;
  /**
   * When true, the column can't be hidden via the columns menu (it can
   * still be reordered). Use for anchor columns like the entity name.
   */
  required?: boolean;
  /** Defaults to true. Set false on infrequently useful columns. */
  defaultVisible?: boolean;
  align?: "left" | "right" | "center";
  /** Sort key passed to SortableTH. Defaults to `key`. */
  sortKey?: string;
  /** False = render a non-clickable header. */
  sortable?: boolean;
  thClassName?: string;
  tdClassName?: string;
  /** Custom header content; defaults to <span>{label}</span>. */
  header?: React.ReactNode;
};

export type ColumnsState = {
  /**
   * Full ordered list of column keys. Unknown keys are dropped during
   * resolution; columns introduced after the state was saved are
   * appended in their registry order.
   */
  order: string[];
  /** Keys the user has explicitly hidden. Required columns are ignored. */
  hidden: string[];
};

/**
 * Reduce the registry through the user's saved state into the actual
 * ordered list of visible columns to render. Tolerates missing /
 * stale keys on both sides so adding or removing a column from a
 * page doesn't invalidate existing saved views.
 */
export function resolveColumns<R>(
  registry: readonly ColumnDef<R>[],
  state: ColumnsState | null | undefined,
): ColumnDef<R>[] {
  const byKey = new Map(registry.map((c) => [c.key, c]));
  const hiddenSet = new Set(state?.hidden ?? []);

  let ordered: ColumnDef<R>[];
  if (state?.order && state.order.length > 0) {
    const seen = new Set<string>();
    ordered = [];
    for (const key of state.order) {
      const def = byKey.get(key);
      if (def && !seen.has(key)) {
        ordered.push(def);
        seen.add(key);
      }
    }
    // Append any registry columns that weren't in the saved order
    // (i.e. introduced after the user saved their state).
    for (const def of registry) {
      if (!seen.has(def.key)) ordered.push(def);
    }
  } else {
    ordered = [...registry];
  }

  // When an explicit state exists, its `hidden` array is the source of
  // truth for visibility — a column the user removed from `hidden` must
  // show even if its registry default is hidden (`defaultVisible: false`).
  // The one exception is a column the saved state predates entirely
  // (absent from `state.order`): for those we fall back to the registry
  // default so newly-introduced opt-in columns stay hidden until the user
  // has actually seen/toggled them.
  const hasState = !!(state?.order && state.order.length > 0);
  const orderSet = new Set(state?.order ?? []);
  return ordered.filter((def) => {
    if (def.required) return true;
    if (hasState && !orderSet.has(def.key)) return def.defaultVisible ?? true;
    if (hiddenSet.has(def.key)) return false;
    if (hasState) return true;
    return def.defaultVisible ?? true;
  });
}

/**
 * Produce the canonical "no customization" state derived from a
 * registry. Used by the columns menu's Reset button so reverting
 * is a one-click affordance.
 */
export function defaultColumnsState<R>(
  registry: readonly ColumnDef<R>[],
): ColumnsState {
  return {
    order: registry.map((c) => c.key),
    hidden: registry
      .filter((c) => c.defaultVisible === false && !c.required)
      .map((c) => c.key),
  };
}

/**
 * True when the given state matches the registry defaults. Pages use
 * this to decide whether to persist `null` (canonical default) vs the
 * explicit state, keeping saved-view comparisons stable for users who
 * never touched their columns.
 */
export function isDefaultColumnsState<R>(
  registry: readonly ColumnDef<R>[],
  state: ColumnsState | null | undefined,
): boolean {
  if (!state) return true;
  const def = defaultColumnsState(registry);
  if (state.order.length !== def.order.length) return false;
  for (let i = 0; i < def.order.length; i++) {
    if (state.order[i] !== def.order[i]) return false;
  }
  const hiddenA = [...state.hidden].sort();
  const hiddenB = [...def.hidden].sort();
  if (hiddenA.length !== hiddenB.length) return false;
  for (let i = 0; i < hiddenA.length; i++) {
    if (hiddenA[i] !== hiddenB[i]) return false;
  }
  return true;
}
