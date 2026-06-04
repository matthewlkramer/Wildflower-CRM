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
import {
  useListPeople,
  useListOrganizations,
  useListHouseholds,
  useListOpportunitiesAndPledges,
  useListGiftsAndPayments,
  getListPeopleQueryKey,
  getListOrganizationsQueryKey,
  getListHouseholdsQueryKey,
  getListOpportunitiesAndPledgesQueryKey,
  getListGiftsAndPaymentsQueryKey,
  useGetCurrentUser,
} from "@workspace/api-client-react";
import { displayPersonName, displayOrganizationName } from "@/lib/visibility";
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
  const viewer = useGetCurrentUser().data ?? null;

  // cmdk does its own client-side filtering by default. We're already
  // filtering server-side via the `search` query param, so we disable
  // cmdk's filter to prevent it from hiding rows that don't textually
  // match (e.g. when the server-side match is on first_name but the
  // CommandItem `value` is the full display name).
  const params = { search: debounced, limit: PER_GROUP_LIMIT };
  // The generated React Query option type requires queryKey, so we
  // forward the matching helper to keep query identity stable across
  // renders when params change. `enabled` gates the network call so we
  // don't fire 5 list requests on every keystroke below the min length.
  const people = useListPeople(params, {
    query: { enabled, queryKey: getListPeopleQueryKey(params) },
  });
  const funders = useListOrganizations(params, {
    query: { enabled, queryKey: getListOrganizationsQueryKey(params) },
  });
  const households = useListHouseholds(params, {
    query: { enabled, queryKey: getListHouseholdsQueryKey(params) },
  });
  const opps = useListOpportunitiesAndPledges(params, {
    query: { enabled, queryKey: getListOpportunitiesAndPledgesQueryKey(params) },
  });
  const gifts = useListGiftsAndPayments(params, {
    query: { enabled, queryKey: getListGiftsAndPaymentsQueryKey(params) },
  });

  const loading =
    enabled &&
    (people.isFetching ||
      funders.isFetching ||
      households.isFetching ||
      opps.isFetching ||
      gifts.isFetching);

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

        {enabled && people.data?.data.length ? (
          <CommandGroup heading="People">
            {people.data.data.map((p) => (
              <CommandItem
                key={`per-${p.id}`}
                value={`per-${p.id}`}
                onSelect={() => go(`/individuals/${p.id}`)}
                data-testid={`palette-person-${p.id}`}
              >
                <Users />
                <span className="truncate">{displayPersonName(p, viewer)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {enabled && funders.data?.data.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Funding entities">
              {funders.data.data.map((f) => (
                <CommandItem
                  key={`fnd-${f.id}`}
                  value={`fnd-${f.id}`}
                  onSelect={() => go(`/organizations/${f.id}`)}
                  data-testid={`palette-funder-${f.id}`}
                >
                  <Building2 />
                  <span className="truncate">{displayOrganizationName(f, viewer)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {enabled && households.data?.data.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Households">
              {households.data.data.map((h) => (
                <CommandItem
                  key={`hh-${h.id}`}
                  value={`hh-${h.id}`}
                  onSelect={() => go(`/households/${h.id}`)}
                  data-testid={`palette-household-${h.id}`}
                >
                  <Home />
                  <span className="truncate">{h.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {enabled && opps.data?.data.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Opportunities & pledges">
              {opps.data.data.map((o) => (
                <CommandItem
                  key={`opp-${o.id}`}
                  value={`opp-${o.id}`}
                  onSelect={() => go(`/opportunities/${o.id}`)}
                  data-testid={`palette-opportunity-${o.id}`}
                >
                  <Target />
                  <span className="truncate">{o.name ?? `Untitled (${o.id})`}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {enabled && gifts.data?.data.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Gifts & payments">
              {gifts.data.data.map((g) => (
                <CommandItem
                  key={`gft-${g.id}`}
                  value={`gft-${g.id}`}
                  onSelect={() => go(`/gifts/${g.id}`)}
                  data-testid={`palette-gift-${g.id}`}
                >
                  <Gift />
                  <span className="truncate">{g.name ?? `Untitled (${g.id})`}</span>
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
