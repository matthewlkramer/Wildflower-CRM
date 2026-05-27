import * as React from "react";

// Per-tab persisted useState. Survives in-app navigation (Link clicks)
// and the browser back/forward button by reading/writing sessionStorage
// on every set. Used to keep list-page filters (search, multi-selects,
// pagination) from resetting when the user clicks into a row's detail
// page and comes back.
//
// sessionStorage (not localStorage) on purpose: filters that linger
// across tab closes feel stale on next visit, and we don't want
// filters bleeding between different windows.
export function usePersistedState<T>(
  key: string,
  initialValue: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = React.useState<T>(() => {
    if (typeof window === "undefined") return initialValue;
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw === null) return initialValue;
      return JSON.parse(raw) as T;
    } catch {
      return initialValue;
    }
  });

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota / disabled — ignore */
    }
  }, [key, value]);

  return [value, setValue];
}
