import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Lightweight per-page "saved views" — named filter presets persisted in
// localStorage. The roadmap calls for localStorage first, DB-backed
// (shareable) later; the public API here is intentionally narrow so the
// later DB-backed implementation can swap behind it without churning
// every list page.

export type SavedView<T> = {
  id: string;
  name: string;
  state: T;
};

type Stored<T> = {
  version: 1;
  views: SavedView<T>[];
  lastActiveId: string | null;
};

const VERSION = 1;

function read<T>(storageKey: string): Stored<T> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored<T>;
    // Forward-compat guard: ignore stored shapes from a future schema
    // rather than corrupting the user's saved views by partial parsing.
    if (parsed?.version !== VERSION || !Array.isArray(parsed.views)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function write<T>(storageKey: string, value: Stored<T>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage unavailable — silently ignore; saved
    // views are convenience, not correctness.
  }
}

function shallowEqualObject(a: unknown, b: unknown): boolean {
  // Filter states are flat string/boolean/number records, so a stringify
  // comparison is sufficient and avoids pulling in a deep-equal dep.
  // Key order matters here — callers should construct view state with
  // a stable key order (which they do, since the state object literal
  // shape is fixed in each page).
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export interface UseSavedViewsOptions<T> {
  /** Unique localStorage key per page, e.g. "wfcrm.views.individuals". */
  storageKey: string;
  /** The page's current filter state. */
  current: T;
  /** Apply a saved view back into the page's filter state. */
  apply: (state: T) => void;
  /**
   * Whether `current` represents the page's default (no filters). Used
   * to decide whether to show a "modified" badge on the Default chip
   * and to disable the "Save as…" affordance on the empty state.
   */
  isDefault: (state: T) => boolean;
}

export interface UseSavedViewsResult<T> {
  views: SavedView<T>[];
  /** id of the saved view whose state matches `current`, or null. */
  activeId: string | null;
  /**
   * True when an active view existed (was applied) and the user has
   * since changed the filters. Useful for showing an "update view"
   * affordance.
   */
  isModified: boolean;
  /** Save the current filter state as a new view. */
  saveAs: (name: string) => SavedView<T>;
  /** Overwrite the currently-active view with the current state. */
  updateActive: () => void;
  /** Delete a view by id. */
  remove: (id: string) => void;
  /** Apply a view by id. */
  applyView: (id: string) => void;
  /** Mark the default state active (clears the lastActiveId). */
  clearActive: () => void;
}

export function useSavedViews<T extends object>({
  storageKey,
  current,
  apply,
  isDefault,
}: UseSavedViewsOptions<T>): UseSavedViewsResult<T> {
  const [views, setViews] = useState<SavedView<T>[]>(() => read<T>(storageKey)?.views ?? []);
  // The view the user explicitly applied / saved most recently. We
  // track it separately from "the view whose state matches current"
  // (activeId below) so the user gets an "update view" affordance even
  // after they make changes that no longer match the saved state.
  const [pinnedId, setPinnedId] = useState<string | null>(
    () => read<T>(storageKey)?.lastActiveId ?? null,
  );

  // On mount, if we have a pinned view from a previous session, apply
  // it once so the user lands back where they left off. We only do this
  // if the page is currently in its default state — otherwise we'd
  // clobber filter values the page may have initialized from elsewhere
  // (URL params, props, etc.).
  const didAutoApplyRef = useRef(false);
  useEffect(() => {
    if (didAutoApplyRef.current) return;
    didAutoApplyRef.current = true;
    if (!pinnedId) return;
    const stored = read<T>(storageKey);
    const v = stored?.views.find((x) => x.id === pinnedId);
    if (v && isDefault(current)) {
      apply(v.state);
    }
    // Intentionally empty deps — first-mount-only. Including `current`
    // or `apply` would create an infinite re-apply loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback(
    (next: { views?: SavedView<T>[]; pinnedId?: string | null }) => {
      const v = next.views ?? views;
      const p = next.pinnedId === undefined ? pinnedId : next.pinnedId;
      write<T>(storageKey, { version: VERSION, views: v, lastActiveId: p });
      if (next.views) setViews(v);
      if (next.pinnedId !== undefined) setPinnedId(p);
    },
    [storageKey, views, pinnedId],
  );

  const activeId = useMemo(() => {
    // "Active" = a saved view whose state matches what's currently
    // applied. Prefer the pinned id if its state still matches; fall
    // back to any matching view (so renames / reordering don't break
    // the badge).
    if (pinnedId) {
      const v = views.find((x) => x.id === pinnedId);
      if (v && shallowEqualObject(v.state, current)) return pinnedId;
    }
    const v = views.find((x) => shallowEqualObject(x.state, current));
    return v?.id ?? null;
  }, [views, pinnedId, current]);

  const isModified = pinnedId !== null && activeId === null;

  const saveAs = useCallback(
    (name: string): SavedView<T> => {
      const v: SavedView<T> = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: name.trim() || "Untitled view",
        // Clone so subsequent mutations to `current` don't bleed into
        // saved storage.
        state: JSON.parse(JSON.stringify(current)) as T,
      };
      persist({ views: [...views, v], pinnedId: v.id });
      return v;
    },
    [views, current, persist],
  );

  const updateActive = useCallback(() => {
    if (!pinnedId) return;
    const next = views.map((v) =>
      v.id === pinnedId
        ? { ...v, state: JSON.parse(JSON.stringify(current)) as T }
        : v,
    );
    persist({ views: next });
  }, [views, pinnedId, current, persist]);

  const remove = useCallback(
    (id: string) => {
      persist({
        views: views.filter((v) => v.id !== id),
        pinnedId: pinnedId === id ? null : pinnedId,
      });
    },
    [views, pinnedId, persist],
  );

  const applyView = useCallback(
    (id: string) => {
      const v = views.find((x) => x.id === id);
      if (!v) return;
      apply(v.state);
      persist({ pinnedId: id });
    },
    [views, apply, persist],
  );

  const clearActive = useCallback(() => {
    persist({ pinnedId: null });
  }, [persist]);

  return {
    views,
    activeId,
    isModified,
    saveAs,
    updateActive,
    remove,
    applyView,
    clearActive,
  };
}
