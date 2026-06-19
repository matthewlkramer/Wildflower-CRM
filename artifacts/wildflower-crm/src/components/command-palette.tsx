import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "wouter";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useSearch, getSearchQueryKey } from "@workspace/api-client-react";
import {
  Building2,
  Gift,
  Home,
  Target,
  Users,
} from "lucide-react";

// Global command palette — opens with ⌘K / Ctrl+K from anywhere.
// We hold the open/close state in a tiny context so the header
// button (and future "/" shortcut, action chips, etc.) can open
// the palette without each consumer re-implementing it.

type Ctx = {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
};

const CommandPaletteContext = createContext<Ctx | null>(null);

export function useCommandPalette(): Ctx {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) {
    throw new Error("useCommandPalette must be used inside CommandPaletteProvider");
  }
  return ctx;
}

const SEARCH_MIN_LEN = 2;
const PER_GROUP_LIMIT = 5;
const DEBOUNCE_MS = 180;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function PaletteInner({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), DEBOUNCE_MS);
  const enabled = debounced.length >= SEARCH_MIN_LEN;

  // One unified server-side search across all five entities. The server
  // ranks hits by relevance, excludes archived rows, and masks anonymous
  // names, so the client renders `label` (and an optional donor `sublabel`)
  // directly — no viewer-side masking needed. cmdk's own client-side filter
  // stays disabled (shouldFilter:false) because matching already happened
  // server-side; `enabled` gates the network call so we don't fire below the
  // minimum length. The generated option type requires a queryKey, so we
  // forward the matching helper to keep query identity stable across renders.
  const params = { q: debounced, limitPerType: PER_GROUP_LIMIT };
  const results = useSearch(params, {
    query: { enabled, queryKey: getSearchQueryKey(params) },
  });
  const data = results.data;
  const loading = enabled && results.isFetching;

  const go = useCallback(
    (path: string) => {
      onClose();
      navigate(path);
    },
    [navigate, onClose],
  );

  return (
    <CommandDialog
      open
      onOpenChange={(v) => !v && onClose()}
      commandProps={{ shouldFilter: false }}
    >
      <CommandInput
        placeholder="Search people, funders, households, opportunities, gifts…"
        value={query}
        onValueChange={setQuery}
        data-testid="command-palette-input"
      />
      <CommandList>
        {!enabled ? (
          <CommandEmpty>Type at least {SEARCH_MIN_LEN} characters.</CommandEmpty>
        ) : loading ? (
          <CommandEmpty>Searching…</CommandEmpty>
        ) : (
          <CommandEmpty>No results found.</CommandEmpty>
        )}

        {enabled && data?.people.length ? (
          <CommandGroup heading="People">
            {data.people.map((p) => (
              <CommandItem
                key={`per-${p.id}`}
                value={`per-${p.id}`}
                onSelect={() => go(`/individuals/${p.id}`)}
                data-testid={`palette-person-${p.id}`}
              >
                <Users />
                <span className="truncate">{p.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {enabled && data?.organizations.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Funding entities">
              {data.organizations.map((f) => (
                <CommandItem
                  key={`fnd-${f.id}`}
                  value={`fnd-${f.id}`}
                  onSelect={() => go(`/organizations/${f.id}`)}
                  data-testid={`palette-funder-${f.id}`}
                >
                  <Building2 />
                  <span className="truncate">{f.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {enabled && data?.households.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Households">
              {data.households.map((h) => (
                <CommandItem
                  key={`hh-${h.id}`}
                  value={`hh-${h.id}`}
                  onSelect={() => go(`/households/${h.id}`)}
                  data-testid={`palette-household-${h.id}`}
                >
                  <Home />
                  <span className="truncate">{h.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {enabled && data?.opportunities.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Opportunities & pledges">
              {data.opportunities.map((o) => (
                <CommandItem
                  key={`opp-${o.id}`}
                  value={`opp-${o.id}`}
                  onSelect={() => go(`/opportunities/${o.id}`)}
                  data-testid={`palette-opportunity-${o.id}`}
                >
                  <Target />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{o.label}</span>
                    {o.sublabel ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {o.sublabel}
                      </span>
                    ) : null}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {enabled && data?.gifts.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Gifts & payments">
              {data.gifts.map((g) => (
                <CommandItem
                  key={`gft-${g.id}`}
                  value={`gft-${g.id}`}
                  onSelect={() => go(`/gifts/${g.id}`)}
                  data-testid={`palette-gift-${g.id}`}
                >
                  <Gift />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{g.label}</span>
                    {g.sublabel ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {g.sublabel}
                      </span>
                    ) : null}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  // Global keyboard shortcut: ⌘K on macOS, Ctrl+K elsewhere. Toggles
  // open so a second press closes the dialog the same way it opened it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const cmd = e.metaKey || e.ctrlKey;
      if (!cmd || (e.key !== "k" && e.key !== "K")) return;
      // Don't intercept Cmd/Ctrl+K while the user is mid-typing in an
      // input, textarea, or contenteditable region — they may be using
      // a native shortcut (e.g. Chrome's "open Reader" or a rich-text
      // editor's link insertion). Modal inputs are inside the palette
      // dialog itself; the toggle below still closes the palette
      // because event listeners fire even from within it.
      const t = e.target as HTMLElement | null;
      const insidePalette = !!t?.closest("[role='dialog']");
      const tag = t?.tagName;
      const isTyping =
        !insidePalette &&
        (tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          t?.isContentEditable === true);
      if (isTyping) return;
      e.preventDefault();
      setOpen((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ctx = useMemo<Ctx>(
    () => ({ open, setOpen, toggle: () => setOpen((v) => !v) }),
    [open],
  );

  return (
    <CommandPaletteContext.Provider value={ctx}>
      {children}
      {open ? <PaletteInner onClose={() => setOpen(false)} /> : null}
    </CommandPaletteContext.Provider>
  );
}

// Header trigger — clickable affordance + shortcut hint. Lives in the
// app shell. Keyboard-only users still get the ⌘K shortcut without
// needing this button.
export function CommandPaletteTrigger() {
  const { toggle } = useCommandPalette();
  // Best-effort platform detection for the shortcut hint. We treat
  // anything that looks Mac-ish as ⌘, everything else as Ctrl. This is
  // cosmetic — the shortcut listener already accepts both modifiers.
  const isMac =
    typeof navigator !== "undefined" &&
    /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");
  return (
    <button
      type="button"
      onClick={toggle}
      className="hidden md:inline-flex items-center gap-2 rounded-md border border-input bg-background px-2.5 h-9 text-sm text-muted-foreground hover:bg-muted transition-colors"
      data-testid="command-palette-trigger"
      aria-label="Open command palette"
    >
      <span className="truncate">Search…</span>
      <CommandShortcut>{isMac ? "⌘K" : "Ctrl K"}</CommandShortcut>
    </button>
  );
}
