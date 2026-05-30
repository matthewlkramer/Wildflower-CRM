import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronsUpDown, Pencil, X } from "lucide-react";
import {
  useListFunders,
  useListPeople,
  useListHouseholds,
  useListPaymentIntermediaries,
  useListOrganizations,
  useGetFunder,
  useGetPerson,
  useGetHousehold,
  useGetPaymentIntermediary,
  useGetOrganization,
  getListFundersQueryKey,
  getListPeopleQueryKey,
  getListHouseholdsQueryKey,
  getListPaymentIntermediariesQueryKey,
  getListOrganizationsQueryKey,
  getGetFunderQueryKey,
  getGetPersonQueryKey,
  getGetHouseholdQueryKey,
  getGetPaymentIntermediaryQueryKey,
  getGetOrganizationQueryKey,
  type Funder,
  type Person,
  type Household,
  type PaymentIntermediary,
  type Organization,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

type SaveResult = unknown | Promise<unknown>;

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function useSaveRunner() {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  async function run(fn: () => SaveResult, onDone: () => void) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch {
      // toast handled by caller
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return { busy, run };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Generic searchable record picker                                         */
/* ──────────────────────────────────────────────────────────────────────── */

export interface PickerItem {
  id: string;
  label: string;
  sublabel?: string;
}

interface EntityPickerCoreProps {
  /** Hook that returns the searched options for the given query. */
  useSearch: (query: string) => { items: PickerItem[]; isLoading: boolean };
  /** Resolve a selected id to its label (for showing inside the trigger). */
  useResolve: (id: string | null) => string | null;
  value: string | null;
  onChange: (next: string | null) => void;
  placeholder?: string;
  testId?: string;
  disabled?: boolean;
  allowNull?: boolean;
  /** Option ids to hide from the list (e.g. to prevent self-references). */
  excludeIds?: string[];
}

/**
 * Headless combobox: trigger + popover + cmdk search. Renders the chosen
 * label inside the trigger. Caller controls `value` (uncontrolled-friendly
 * since cmdk does its own search state). Use this inside InlineEditX
 * components that handle the edit/save lifecycle, or standalone.
 */
export function EntityCombobox({
  useSearch,
  useResolve,
  value,
  onChange,
  placeholder = "Search…",
  testId,
  disabled,
  allowNull = true,
  excludeIds,
}: EntityPickerCoreProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query);
  // Clear stale search input when the popover closes so reopening starts
  // fresh instead of showing the previous filter's results.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  const { items: rawItems, isLoading } = useSearch(debounced);
  const items = useMemo(
    () =>
      excludeIds?.length
        ? rawItems.filter((it) => !excludeIds.includes(it.id))
        : rawItems,
    [rawItems, excludeIds],
  );
  const resolvedLabel = useResolve(value);
  const triggerLabel = value
    ? (resolvedLabel ?? value)
    : placeholder;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          data-testid={testId}
          className="h-8 justify-between min-w-0 flex-1 font-normal"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[--radix-popover-trigger-width] min-w-[260px]"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={placeholder}
            data-testid={testId ? `${testId}-search` : undefined}
          />
          <CommandList>
            {isLoading ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                Loading…
              </div>
            ) : items.length === 0 ? (
              <CommandEmpty>No results.</CommandEmpty>
            ) : null}
            <CommandGroup>
              {allowNull ? (
                <CommandItem
                  value="__null__"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  data-testid={testId ? `${testId}-option-null` : undefined}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === null ? "opacity-100" : "opacity-0",
                    )}
                  />
                  — None —
                </CommandItem>
              ) : null}
              {items.map((it) => (
                <CommandItem
                  key={it.id}
                  value={it.id}
                  onSelect={() => {
                    onChange(it.id);
                    setOpen(false);
                  }}
                  data-testid={testId ? `${testId}-option-${it.id}` : undefined}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === it.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate">{it.label}</span>
                    {it.sublabel ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {it.sublabel}
                      </span>
                    ) : null}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Inline-edit wrapper                                                      */
/* ──────────────────────────────────────────────────────────────────────── */

interface InlineEditEntityPickerProps {
  label: string;
  testIdBase?: string;
  display: ReactNode;
  value: string | null;
  onSave: (next: string | null) => SaveResult;
  useSearch: (query: string) => { items: PickerItem[]; isLoading: boolean };
  useResolve: (id: string | null) => string | null;
  placeholder?: string;
  allowNull?: boolean;
}

export function InlineEditEntityPicker({
  label,
  testIdBase,
  display,
  value,
  onSave,
  useSearch,
  useResolve,
  placeholder,
  allowNull = true,
}: InlineEditEntityPickerProps) {
  const [editing, setEditing] = useState(false);
  const { busy, run } = useSaveRunner();
  const [draft, setDraft] = useState<string | null>(value);

  useEffect(() => {
    if (editing) setDraft(value);
  }, [editing, value]);

  if (!editing) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <div className="truncate text-right flex-1">{display}</div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={() => setEditing(true)}
          aria-label={`Edit ${label}`}
          data-testid={testIdBase ? `button-edit-${testIdBase}` : undefined}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  const dirty = draft !== value;
  const canSave = dirty && (allowNull || draft !== null);
  const trySave = () => {
    if (!canSave || busy) return;
    run(() => onSave(draft), () => setEditing(false));
  };

  return (
    <div className="flex items-center gap-1 min-w-0">
      <EntityCombobox
        useSearch={useSearch}
        useResolve={useResolve}
        value={draft}
        onChange={setDraft}
        placeholder={placeholder ?? `Pick ${label.toLowerCase()}…`}
        disabled={busy}
        allowNull={allowNull}
        testId={testIdBase ? `select-${testIdBase}` : undefined}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7 text-primary"
        disabled={!canSave || busy}
        onClick={trySave}
        aria-label={`Save ${label}`}
        data-testid={testIdBase ? `button-save-${testIdBase}` : undefined}
      >
        <Check className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7 text-muted-foreground"
        disabled={busy}
        onClick={() => setEditing(false)}
        aria-label={`Cancel ${label}`}
        data-testid={testIdBase ? `button-cancel-${testIdBase}` : undefined}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Per-entity search + resolve hooks + display helpers                      */
/* ──────────────────────────────────────────────────────────────────────── */

const SEARCH_LIMIT = 50;
const SEARCH_STALE = 30_000;

export function personDisplayName(p: Person): string {
  if (p.fullName?.trim()) return p.fullName;
  const full = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  return full || p.id;
}

export function usePersonSearch(query: string) {
  const params = query
    ? { search: query, limit: SEARCH_LIMIT }
    : { limit: SEARCH_LIMIT };
  const q = useListPeople(params, {
    query: { queryKey: getListPeopleQueryKey(params), staleTime: SEARCH_STALE },
  });
  const items: PickerItem[] = useMemo(
    () =>
      (q.data?.data ?? []).map((p) => ({
        id: p.id,
        label: personDisplayName(p),
      })),
    [q.data],
  );
  return { items, isLoading: q.isLoading };
}

export function usePersonName(id: string | null): string | null {
  const q = useGetPerson(id ?? "", {
    query: {
      queryKey: getGetPersonQueryKey(id ?? ""),
      enabled: !!id,
      staleTime: 5 * 60_000,
    },
  });
  return id && q.data ? personDisplayName(q.data) : null;
}

export function funderDisplayName(f: Funder): string {
  return f.name?.trim() || f.id;
}

export function useFunderSearch(query: string) {
  const params = query
    ? { search: query, limit: SEARCH_LIMIT }
    : { limit: SEARCH_LIMIT };
  const q = useListFunders(params, {
    query: { queryKey: getListFundersQueryKey(params), staleTime: SEARCH_STALE },
  });
  const items: PickerItem[] = useMemo(
    () =>
      (q.data?.data ?? []).map((f) => ({
        id: f.id,
        label: funderDisplayName(f),
      })),
    [q.data],
  );
  return { items, isLoading: q.isLoading };
}

export function useFunderName(id: string | null): string | null {
  const q = useGetFunder(id ?? "", {
    query: {
      queryKey: getGetFunderQueryKey(id ?? ""),
      enabled: !!id,
      staleTime: 5 * 60_000,
    },
  });
  return id && q.data ? funderDisplayName(q.data) : null;
}

export function householdDisplayName(h: Household): string {
  return h.name?.trim() || h.id;
}

export function useHouseholdSearch(query: string) {
  const params = query
    ? { search: query, limit: SEARCH_LIMIT }
    : { limit: SEARCH_LIMIT };
  const q = useListHouseholds(params, {
    query: {
      queryKey: getListHouseholdsQueryKey(params),
      staleTime: SEARCH_STALE,
    },
  });
  const items: PickerItem[] = useMemo(
    () =>
      (q.data?.data ?? []).map((h) => ({
        id: h.id,
        label: householdDisplayName(h),
      })),
    [q.data],
  );
  return { items, isLoading: q.isLoading };
}

export function useHouseholdName(id: string | null): string | null {
  const q = useGetHousehold(id ?? "", {
    query: {
      queryKey: getGetHouseholdQueryKey(id ?? ""),
      enabled: !!id,
      staleTime: 5 * 60_000,
    },
  });
  return id && q.data ? householdDisplayName(q.data) : null;
}

export function intermediaryDisplayName(p: PaymentIntermediary): string {
  return p.name?.trim() || p.id;
}

export function useIntermediarySearch(_query: string) {
  // Only ~35 records — no server-side search needed; cmdk filters locally.
  // We still respect the query param for forward compatibility but ignore it
  // here because the server only indexes name and there are too few rows
  // to bother paginating.
  const q = useListPaymentIntermediaries(
    { limit: 200 },
    {
      query: {
        queryKey: getListPaymentIntermediariesQueryKey({ limit: 200 }),
        staleTime: 5 * 60_000,
      },
    },
  );
  const items: PickerItem[] = useMemo(
    () =>
      (q.data?.data ?? []).map((p) => ({
        id: p.id,
        label: intermediaryDisplayName(p),
      })),
    [q.data],
  );
  // Filter locally to keep the API simple
  const filtered = useMemo(() => {
    const term = _query.trim().toLowerCase();
    if (!term) return items;
    return items.filter((it) => it.label.toLowerCase().includes(term));
  }, [items, _query]);
  return { items: filtered, isLoading: q.isLoading };
}

export function useIntermediaryName(id: string | null): string | null {
  const q = useGetPaymentIntermediary(id ?? "", {
    query: {
      queryKey: getGetPaymentIntermediaryQueryKey(id ?? ""),
      enabled: !!id,
      staleTime: 5 * 60_000,
    },
  });
  return id && q.data ? intermediaryDisplayName(q.data) : null;
}

export function organizationDisplayName(o: Organization): string {
  return o.name?.trim() || o.id;
}

export function useOrganizationName(id: string | null): string | null {
  const q = useGetOrganization(id ?? "", {
    query: {
      queryKey: getGetOrganizationQueryKey(id ?? ""),
      enabled: !!id,
      staleTime: 5 * 60_000,
    },
  });
  return id && q.data ? organizationDisplayName(q.data) : null;
}

export function useOrganizationSearch(query: string) {
  const params = query
    ? { search: query, limit: SEARCH_LIMIT }
    : { limit: SEARCH_LIMIT };
  const q = useListOrganizations(params, {
    query: {
      queryKey: getListOrganizationsQueryKey(params),
      staleTime: SEARCH_STALE,
    },
  });
  const items: PickerItem[] = useMemo(
    () =>
      (q.data?.data ?? []).map((o) => ({
        id: o.id,
        label: organizationDisplayName(o),
      })),
    [q.data],
  );
  return { items, isLoading: q.isLoading };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Ready-made InlineEdit wrappers                                           */
/* ──────────────────────────────────────────────────────────────────────── */

type EntityPickerProps = {
  label?: string;
  testIdBase?: string;
  display: ReactNode;
  value: string | null;
  onSave: (next: string | null) => SaveResult;
  allowNull?: boolean;
};

export function InlineEditPersonPicker(props: EntityPickerProps) {
  return (
    <InlineEditEntityPicker
      label={props.label ?? "Person"}
      testIdBase={props.testIdBase}
      display={props.display}
      value={props.value}
      onSave={props.onSave}
      useSearch={usePersonSearch}
      useResolve={usePersonName}
      allowNull={props.allowNull}
      placeholder="Search people…"
    />
  );
}

export function InlineEditFunderPicker(props: EntityPickerProps) {
  return (
    <InlineEditEntityPicker
      label={props.label ?? "Funder"}
      testIdBase={props.testIdBase}
      display={props.display}
      value={props.value}
      onSave={props.onSave}
      useSearch={useFunderSearch}
      useResolve={useFunderName}
      allowNull={props.allowNull}
      placeholder="Search funders…"
    />
  );
}

export function InlineEditHouseholdPicker(props: EntityPickerProps) {
  return (
    <InlineEditEntityPicker
      label={props.label ?? "Household"}
      testIdBase={props.testIdBase}
      display={props.display}
      value={props.value}
      onSave={props.onSave}
      useSearch={useHouseholdSearch}
      useResolve={useHouseholdName}
      allowNull={props.allowNull}
      placeholder="Search households…"
    />
  );
}

export function InlineEditIntermediaryPicker(props: EntityPickerProps) {
  return (
    <InlineEditEntityPicker
      label={props.label ?? "Intermediary"}
      testIdBase={props.testIdBase}
      display={props.display}
      value={props.value}
      onSave={props.onSave}
      useSearch={useIntermediarySearch}
      useResolve={useIntermediaryName}
      allowNull={props.allowNull}
      placeholder="Search intermediaries…"
    />
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Donor composite picker — enforces donor_xor invariant                    */
/* ──────────────────────────────────────────────────────────────────────── */

export type DonorType = "funder" | "individual" | "household";

export interface DonorValue {
  funderId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
}

export interface DonorSaveBody {
  funderId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
}

// Use `!= null` (not truthiness) to mirror the server-side num_nonnulls()
// semantics in validateGiftInvariants / validateOppInvariants — an empty
// string ID is "set" from the DB CHECK's perspective, so the UI must
// treat it the same way to avoid divergent client/server state.
function currentDonorType(v: DonorValue): DonorType | null {
  if (v.funderId != null) return "funder";
  if (v.individualGiverPersonId != null) return "individual";
  if (v.householdId != null) return "household";
  return null;
}

function donorIdForType(v: DonorValue, t: DonorType | null): string | null {
  if (!t) return null;
  if (t === "funder") return v.funderId;
  if (t === "individual") return v.individualGiverPersonId;
  return v.householdId;
}

function buildDonorBody(t: DonorType | null, id: string | null): DonorSaveBody {
  return {
    funderId: t === "funder" ? id : null,
    individualGiverPersonId: t === "individual" ? id : null,
    householdId: t === "household" ? id : null,
  };
}

const DONOR_TYPE_LABEL: Record<DonorType, string> = {
  funder: "Funder",
  individual: "Individual",
  household: "Household",
};

/**
 * Edits a donor on a gift or opportunity. The donor is one of (funder,
 * individual giver person, household) and the server enforces XOR via
 * validateGiftInvariants / validateOppInvariants. This composite control
 * sends ALL THREE FK fields on save, with the two non-selected fields set
 * to null, so the merged-state validator in the API always sees exactly
 * one populated id.
 *
 * Note: a saved donor cannot be cleared to "no donor" because the invariant
 * requires exactly one. To remove a donor, delete the gift/opportunity
 * itself or pick a different donor.
 */
export function InlineEditDonor({
  testIdBase,
  value,
  display,
  onSave,
  individualLabel = "Individual",
}: {
  testIdBase?: string;
  value: DonorValue;
  display: ReactNode;
  onSave: (body: DonorSaveBody) => SaveResult;
  individualLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const { busy, run } = useSaveRunner();
  const initialType = currentDonorType(value);
  const initialId = donorIdForType(value, initialType);
  const [type, setType] = useState<DonorType>(initialType ?? "funder");
  const [pickedId, setPickedId] = useState<string | null>(initialId);

  useEffect(() => {
    if (editing) {
      const t0 = currentDonorType(value) ?? "funder";
      setType(t0);
      setPickedId(donorIdForType(value, t0));
    }
  }, [editing, value]);

  if (!editing) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <div className="truncate text-right flex-1">{display}</div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={() => setEditing(true)}
          aria-label="Edit donor"
          data-testid={testIdBase ? `button-edit-${testIdBase}` : undefined}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  const body = buildDonorBody(type, pickedId);
  const dirty =
    body.funderId !== (value.funderId ?? null) ||
    body.individualGiverPersonId !== (value.individualGiverPersonId ?? null) ||
    body.householdId !== (value.householdId ?? null);
  const canSave = dirty && pickedId !== null && !busy;
  const trySave = () => {
    if (!canSave) return;
    run(() => onSave(body), () => setEditing(false));
  };

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex gap-1">
        {(["funder", "individual", "household"] as const).map((t) => (
          <Button
            key={t}
            type="button"
            size="sm"
            variant={type === t ? "default" : "outline"}
            className="h-7 px-2 text-xs"
            disabled={busy}
            onClick={() => {
              if (t !== type) {
                setType(t);
                setPickedId(null);
              }
            }}
            data-testid={
              testIdBase ? `button-${testIdBase}-type-${t}` : undefined
            }
          >
            {t === "individual" ? individualLabel : DONOR_TYPE_LABEL[t]}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-1 min-w-0">
        {type === "funder" ? (
          <EntityCombobox
            useSearch={useFunderSearch}
            useResolve={useFunderName}
            value={pickedId}
            onChange={setPickedId}
            allowNull={false}
            placeholder="Search funders…"
            disabled={busy}
            testId={testIdBase ? `select-${testIdBase}` : undefined}
          />
        ) : type === "individual" ? (
          <EntityCombobox
            useSearch={usePersonSearch}
            useResolve={usePersonName}
            value={pickedId}
            onChange={setPickedId}
            allowNull={false}
            placeholder="Search people…"
            disabled={busy}
            testId={testIdBase ? `select-${testIdBase}` : undefined}
          />
        ) : (
          <EntityCombobox
            useSearch={useHouseholdSearch}
            useResolve={useHouseholdName}
            value={pickedId}
            onChange={setPickedId}
            allowNull={false}
            placeholder="Search households…"
            disabled={busy}
            testId={testIdBase ? `select-${testIdBase}` : undefined}
          />
        )}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-primary"
          disabled={!canSave}
          onClick={trySave}
          aria-label="Save donor"
          data-testid={testIdBase ? `button-save-${testIdBase}` : undefined}
        >
          <Check className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground"
          disabled={busy}
          onClick={() => setEditing(false)}
          aria-label="Cancel donor"
          data-testid={testIdBase ? `button-cancel-${testIdBase}` : undefined}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Donor picker for create forms — controlled, no inline-edit chrome         */
/* ──────────────────────────────────────────────────────────────────────── */

export function donorTypeFromValue(v: DonorValue): DonorType | null {
  return currentDonorType(v);
}

export function donorIdFromValue(
  v: DonorValue,
  t: DonorType | null,
): string | null {
  return donorIdForType(v, t);
}

export function donorBodyFor(
  t: DonorType | null,
  id: string | null,
): DonorSaveBody {
  return buildDonorBody(t, id);
}

/**
 * A donor selector for use inside create/edit forms (as opposed to the
 * inline-edit row that {@link InlineEditDonor} renders). Fully controlled:
 * the parent owns `type` + `id` and gets both back via `onChange`. Switching
 * type clears the picked id so the donor_xor invariant can never be violated.
 */
export function DonorFieldPicker({
  type,
  id,
  onChange,
  testIdBase,
  individualLabel = "Individual",
  disabled,
}: {
  type: DonorType;
  id: string | null;
  onChange: (type: DonorType, id: string | null) => void;
  testIdBase?: string;
  individualLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex gap-1">
        {(["funder", "individual", "household"] as const).map((t) => (
          <Button
            key={t}
            type="button"
            size="sm"
            variant={type === t ? "default" : "outline"}
            className="h-7 px-2 text-xs"
            disabled={disabled}
            onClick={() => {
              if (t !== type) onChange(t, null);
            }}
            data-testid={
              testIdBase ? `button-${testIdBase}-type-${t}` : undefined
            }
          >
            {t === "individual" ? individualLabel : DONOR_TYPE_LABEL[t]}
          </Button>
        ))}
      </div>
      {type === "funder" ? (
        <EntityCombobox
          useSearch={useFunderSearch}
          useResolve={useFunderName}
          value={id}
          onChange={(next) => onChange("funder", next)}
          allowNull={false}
          placeholder="Search funders…"
          disabled={disabled}
          testId={testIdBase ? `select-${testIdBase}` : undefined}
        />
      ) : type === "individual" ? (
        <EntityCombobox
          useSearch={usePersonSearch}
          useResolve={usePersonName}
          value={id}
          onChange={(next) => onChange("individual", next)}
          allowNull={false}
          placeholder="Search people…"
          disabled={disabled}
          testId={testIdBase ? `select-${testIdBase}` : undefined}
        />
      ) : (
        <EntityCombobox
          useSearch={useHouseholdSearch}
          useResolve={useHouseholdName}
          value={id}
          onChange={(next) => onChange("household", next)}
          allowNull={false}
          placeholder="Search households…"
          disabled={disabled}
          testId={testIdBase ? `select-${testIdBase}` : undefined}
        />
      )}
    </div>
  );
}
