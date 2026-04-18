import { useState, useMemo, useEffect } from "react";
import {
  useListIndividuals,
  useListHouseholds,
  useListFundingEntities,
  getListIndividualsQueryKey,
  getListHouseholdsQueryKey,
  getListFundingEntitiesQueryKey,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type DonorType = "individual" | "household" | "funding_entity";

export type DonorSelection = {
  type: DonorType;
  id: string;
  label: string;
};

const DONOR_TYPE_OPTIONS: { value: DonorType; label: string }[] = [
  { value: "individual", label: "Individual" },
  { value: "household", label: "Household" },
  { value: "funding_entity", label: "Funding Entity" },
];

function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function DonorPicker({
  value,
  onChange,
  disabled,
}: {
  value: DonorSelection | null;
  onChange: (next: DonorSelection | null) => void;
  disabled?: boolean;
}) {
  const [type, setType] = useState<DonorType>(value?.type ?? "individual");
  const [search, setSearch] = useState(value?.label ?? "");
  const [open, setOpen] = useState(false);
  const debouncedSearch = useDebounced(search, 250);

  useEffect(() => {
    if (value && value.label !== search) setSearch(value.label);
  }, [value?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const params = useMemo(
    () => ({ search: debouncedSearch || undefined, limit: 8 }),
    [debouncedSearch],
  );
  const indResp = useListIndividuals(params, {
    query: {
      enabled: open && type === "individual",
      queryKey: getListIndividualsQueryKey(params),
    },
  });
  const hhResp = useListHouseholds(params, {
    query: {
      enabled: open && type === "household",
      queryKey: getListHouseholdsQueryKey(params),
    },
  });
  const feResp = useListFundingEntities(params, {
    query: {
      enabled: open && type === "funding_entity",
      queryKey: getListFundingEntitiesQueryKey(params),
    },
  });

  const results: DonorSelection[] = useMemo(() => {
    if (type === "individual") {
      return (indResp.data?.data ?? []).map((i) => ({
        type,
        id: i.id,
        label: `${i.firstName ?? ""} ${i.lastName ?? ""}`.trim() || "Individual",
      }));
    }
    if (type === "household") {
      return (hhResp.data?.data ?? []).map((h) => ({
        type,
        id: h.id,
        label: h.name ?? "Household",
      }));
    }
    return (feResp.data?.data ?? []).map((f) => ({
      type,
      id: f.id,
      label: f.legalName ?? "Funding Entity",
    }));
  }, [type, indResp.data, hhResp.data, feResp.data]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {DONOR_TYPE_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => {
              setType(o.value);
              if (value && value.type !== o.value) onChange(null);
              setSearch("");
              setOpen(true);
            }}
            className={`text-xs px-2 py-1 rounded-md border ${
              type === o.value
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="relative">
        <Label htmlFor="donor-search" className="sr-only">
          Search donor
        </Label>
        <Input
          id="donor-search"
          placeholder={`Search ${type.replace("_", " ")}…`}
          value={search}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setSearch(e.target.value);
            setOpen(true);
            if (value) onChange(null);
          }}
        />
        {open && (
          <div className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto rounded-md border bg-popover shadow">
            {results.length === 0 ? (
              <div className="p-2 text-xs text-muted-foreground">No matches.</div>
            ) : (
              results.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    onChange(r);
                    setSearch(r.label);
                    setOpen(false);
                  }}
                  className="block w-full text-left px-3 py-1.5 text-sm hover:bg-muted"
                >
                  {r.label}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {value && (
        <p className="text-xs text-muted-foreground">
          Selected: <span className="font-medium text-foreground">{value.label}</span>{" "}
          ({value.type.replace("_", " ")})
        </p>
      )}
    </div>
  );
}
