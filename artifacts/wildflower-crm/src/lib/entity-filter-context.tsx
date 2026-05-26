import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

// Global entity filter — persisted to localStorage so the user's selection
// follows them across pages and survives reloads. `defaults` is the
// preference set on the Settings page that seeds `selected` the first time
// the app is opened in a browser (or after the user clears localStorage).
//
// Storage shape:
//   wf-entity-filter      : string[] of currently-selected entity ids
//                           ([] means "all entities" / no filter)
//   wf-default-entities   : string[] of the user's preferred default set
//
// We deliberately store this client-side rather than on the user record:
// it's a UI preference, not a CRM datum, and avoiding a server round-trip
// keeps the dropdown snappy on first paint.

const SELECTION_KEY = "wf-entity-filter";
const DEFAULT_KEY = "wf-default-entities";

function readIdList(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function writeIdList(key: string, value: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota / privacy mode — best-effort, don't crash the UI.
  }
}

type EntityFilterContextValue = {
  // Currently-selected entity ids (sorted, deduped). [] = no filter.
  selected: string[];
  setSelected: (next: string[]) => void;
  // User-preferred default selection (Settings page).
  defaults: string[];
  setDefaults: (next: string[]) => void;
};

const EntityFilterContext = createContext<EntityFilterContextValue | null>(null);

function normalize(input: string[]): string[] {
  return Array.from(new Set(input)).sort();
}

export function EntityFilterProvider({ children }: { children: ReactNode }) {
  const [defaults, setDefaultsState] = useState<string[]>(() =>
    normalize(readIdList(DEFAULT_KEY)),
  );
  // On first ever load (no SELECTION_KEY in storage) seed from defaults so
  // the user's preferred starting set takes effect without a manual click.
  const [selected, setSelectedState] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(SELECTION_KEY);
    if (raw === null) return normalize(readIdList(DEFAULT_KEY));
    return normalize(readIdList(SELECTION_KEY));
  });

  const setSelected = (next: string[]) => {
    const n = normalize(next);
    setSelectedState(n);
    writeIdList(SELECTION_KEY, n);
  };

  const setDefaults = (next: string[]) => {
    const n = normalize(next);
    setDefaultsState(n);
    writeIdList(DEFAULT_KEY, n);
  };

  const value = useMemo(
    () => ({ selected, setSelected, defaults, setDefaults }),
    [selected, defaults],
  );

  return (
    <EntityFilterContext.Provider value={value}>
      {children}
    </EntityFilterContext.Provider>
  );
}

export function useEntityFilter(): EntityFilterContextValue {
  const ctx = useContext(EntityFilterContext);
  if (!ctx) {
    throw new Error("useEntityFilter must be used within an EntityFilterProvider");
  }
  return ctx;
}
