import { useEffect, useState } from "react";

/** Browser preferences belong to one CRM account, including on shared devices. */
export function useBrowserPreference(
  userId: string | undefined,
  name: string,
  fallback: string,
) {
  const key = userId ? `wf-${name}:${userId}` : undefined;
  const [saved, setSaved] = useState<{ key?: string; value: string }>({
    value: fallback,
  });
  useEffect(() => {
    let value = fallback;
    try {
      if (key) value = localStorage.getItem(key) ?? fallback;
    } catch {
      /* Storage is optional. */
    }
    setSaved({ key, value });
  }, [key, fallback]);
  const value = saved.key === key ? saved.value : fallback;
  function setValue(next: string) {
    if (!key) return;
    setSaved({ key, value: next });
    try {
      localStorage.setItem(key, next);
    } catch {
      /* Keep session state. */
    }
  }
  return [value, setValue] as const;
}
