import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSavedViews,
  useCreateSavedView,
  useUpdateSavedView,
  useDeleteSavedView,
  useGetCurrentUser,
  getListSavedViewsQueryKey,
} from "@workspace/api-client-react";

// DB-backed per-list-page saved views.
//
// Each list page picks a stable `listKey` (e.g. "individuals"). The
// page passes its current filter+sort blob as `current`, plus an
// `apply` callback that writes a blob back to its own state. The hook
// itself doesn't know what's in the blob — it just round-trips it.
//
// Visibility:
//   - 'team':       visible to everyone, edit/delete only by creator
//   - 'individual': visible only to the creator
//
// The currently-pinned view id is kept per-list in localStorage (a
// device-local preference), so reloading the page lands the user back
// in the same view, but switching devices doesn't drag the choice
// across.

export type SavedViewVisibility = "team" | "individual";

export type SavedView<T> = {
  id: string;
  name: string;
  visibility: SavedViewVisibility;
  state: T;
  creatorUserId: string;
};

function pinnedKey(listKey: string): string {
  return `wfcrm.savedViews.pinned.${listKey}`;
}

function readPinned(listKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(pinnedKey(listKey));
  } catch {
    return null;
  }
}

function writePinned(listKey: string, id: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (id === null) window.localStorage.removeItem(pinnedKey(listKey));
    else window.localStorage.setItem(pinnedKey(listKey), id);
  } catch {
    /* quota / disabled — ignore */
  }
}

// Drop keys whose value is `null` or `undefined` from a plain object,
// recursively. Lets us treat a saved-view blob that predates a newly-
// added field (e.g. `columns`) as equal to a fresh one that includes
// the field set to its canonical default (`null`). Arrays / scalars
// pass through unchanged so empty arrays still differ from absent keys.
function stripNulls(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(stripNulls);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    for (const [k, v] of entries) {
      const cleaned = stripNulls(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

function shallowEqualObject(a: unknown, b: unknown): boolean {
  // Saved-view state blobs are flat string/boolean/number/array records.
  // We strip null/undefined and sort keys before serializing so:
  //   - adding an optional field (default null) to the view shape doesn't
  //     invalidate older saved views that lack it;
  //   - subtle key-ordering differences between client and server-round-
  //     tripped blobs don't surface as spurious "modified" indicators.
  try {
    return JSON.stringify(stripNulls(a)) === JSON.stringify(stripNulls(b));
  } catch {
    return false;
  }
}

export interface UseSavedViewsOptions<T> {
  /** Page identifier, e.g. "individuals", "funders". */
  listKey: string;
  /** The page's current filter+sort state. */
  current: T;
  /** Apply a saved view back into the page's state. */
  apply: (state: T) => void;
  /**
   * Whether `current` represents the page's default (no filters). Used
   * to gate auto-apply on mount and to disable the "Save as…" affordance
   * on the empty state.
   */
  isDefault: (state: T) => boolean;
}

export interface UseSavedViewsResult<T> {
  views: SavedView<T>[];
  isLoading: boolean;
  /** id of the saved view whose state matches `current`, or null. */
  activeId: string | null;
  /**
   * The user's last-pinned view id (the one they actually clicked /
   * just saved), regardless of whether `current` still matches it.
   * Used by the bar to find the "originally applied" view when the
   * filters have since been edited away from it.
   */
  pinnedId: string | null;
  /**
   * True when an active view existed (was applied) and the user has
   * since changed the filters. Drives the "Update view" affordance.
   */
  isModified: boolean;
  /** DB id of the currently signed-in user (for ownership checks). */
  currentUserId: string | null;
  /** Save the current state as a new view. */
  saveAs: (name: string, visibility: SavedViewVisibility) => Promise<void>;
  /** Overwrite the currently-pinned view with the current state. */
  updateActive: () => Promise<void>;
  /** Delete a view by id. */
  remove: (id: string) => Promise<void>;
  /** Apply a view by id. */
  applyView: (id: string) => void;
  /** Mark the default state active (clears pinned). */
  clearActive: () => void;
}

export function useSavedViews<T extends object>({
  listKey,
  current,
  apply,
  isDefault,
}: UseSavedViewsOptions<T>): UseSavedViewsResult<T> {
  const queryClient = useQueryClient();
  const listQueryKey = useMemo(
    () => getListSavedViewsQueryKey({ listKey }),
    [listKey],
  );
  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: listQueryKey }),
    [queryClient, listQueryKey],
  );

  const { data, isLoading, isSuccess } = useListSavedViews({ listKey });
  const { data: me } = useGetCurrentUser();
  const currentUserId = me?.id ?? null;

  const createMut = useCreateSavedView({
    mutation: { onSuccess: () => invalidate() },
  });
  const updateMut = useUpdateSavedView({
    mutation: { onSuccess: () => invalidate() },
  });
  const deleteMut = useDeleteSavedView({
    mutation: { onSuccess: () => invalidate() },
  });

  // Project the API response into the page-typed shape. The server
  // stores `state` as opaque jsonb so we cast it to T at the boundary.
  const views = useMemo<SavedView<T>[]>(
    () =>
      (data?.data ?? []).map((v) => ({
        id: v.id,
        name: v.name,
        visibility: v.visibility,
        creatorUserId: v.creatorUserId,
        state: v.state as T,
      })),
    [data],
  );

  const [pinnedId, setPinnedId] = useState<string | null>(() =>
    readPinned(listKey),
  );

  // Auto-apply pinned view once per mount, but only if the page is
  // currently in its default state. We wait for the views list to
  // succeed — gating on isLoading alone would treat a network error as
  // "list is empty" and wrongly clear a valid pinned id.
  const didAutoApplyRef = useRef(false);
  useEffect(() => {
    if (didAutoApplyRef.current) return;
    if (!isSuccess) return;
    didAutoApplyRef.current = true;
    if (!pinnedId) return;
    const v = views.find((x) => x.id === pinnedId);
    if (v && isDefault(current)) {
      apply(v.state);
    } else if (!v) {
      // Pinned id refers to a view that no longer exists (deleted on
      // another device). Clear the dangling pointer. Safe to do here
      // because we only enter this branch on a successful response.
      writePinned(listKey, null);
      setPinnedId(null);
    }
    // Intentionally empty deps beyond `isSuccess` — first-mount-only.
    // Including current/apply would create an infinite re-apply loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess]);

  const setPinned = useCallback(
    (id: string | null) => {
      writePinned(listKey, id);
      setPinnedId(id);
    },
    [listKey],
  );

  const activeId = useMemo(() => {
    // Prefer the pinned id if its state still matches the page, so
    // pinning sticks across re-renders. Fall back to any matching view
    // so renames / saving from another tab still light up correctly.
    if (pinnedId) {
      const v = views.find((x) => x.id === pinnedId);
      if (v && shallowEqualObject(v.state, current)) return pinnedId;
    }
    const v = views.find((x) => shallowEqualObject(x.state, current));
    return v?.id ?? null;
  }, [views, pinnedId, current]);

  const isModified = pinnedId !== null && activeId === null;

  const saveAs = useCallback(
    async (name: string, visibility: SavedViewVisibility) => {
      const trimmed = name.trim() || "Untitled view";
      // Clone so subsequent mutations to `current` don't bleed into the
      // payload before the request lands.
      const state = JSON.parse(JSON.stringify(current)) as T;
      const created = await createMut.mutateAsync({
        data: {
          listKey,
          name: trimmed,
          visibility,
          state: state as unknown as { [key: string]: unknown },
        },
      });
      setPinned(created.id);
    },
    [createMut, current, listKey, setPinned],
  );

  const updateActive = useCallback(async () => {
    if (!pinnedId) return;
    const v = views.find((x) => x.id === pinnedId);
    // Block silently if the user doesn't own this view — the UI should
    // hide the button in that case, but defend in depth so a stale
    // render can't fire a 403.
    if (!v || v.creatorUserId !== currentUserId) return;
    const state = JSON.parse(JSON.stringify(current)) as T;
    await updateMut.mutateAsync({
      id: pinnedId,
      data: { state: state as unknown as { [key: string]: unknown } },
    });
  }, [pinnedId, views, currentUserId, current, updateMut]);

  const remove = useCallback(
    async (id: string) => {
      await deleteMut.mutateAsync({ id });
      if (pinnedId === id) setPinned(null);
    },
    [deleteMut, pinnedId, setPinned],
  );

  const applyView = useCallback(
    (id: string) => {
      const v = views.find((x) => x.id === id);
      if (!v) return;
      apply(v.state);
      setPinned(id);
    },
    [views, apply, setPinned],
  );

  const clearActive = useCallback(() => {
    setPinned(null);
  }, [setPinned]);

  return {
    views,
    isLoading,
    activeId,
    pinnedId,
    isModified,
    currentUserId,
    saveAs,
    updateActive,
    remove,
    applyView,
    clearActive,
  };
}
