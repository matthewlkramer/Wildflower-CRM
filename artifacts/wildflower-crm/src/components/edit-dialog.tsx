import { useState, useEffect, ReactNode, useMemo } from "react";
import {
  useListFundingEntities,
  getListFundingEntitiesQueryKey,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type EditField<K extends string> =
  | { kind: "date"; key: K; label: string; value: string | null | undefined }
  | { kind: "text"; key: K; label: string; value: string | null | undefined }
  | { kind: "textarea"; key: K; label: string; value: string | null | undefined }
  | { kind: "select"; key: K; label: string; value: string | null | undefined; options: { value: string; label: string }[] }
  | { kind: "checkbox"; key: K; label: string; value: boolean | null | undefined }
  | {
      kind: "fundingEntityPicker";
      key: K;
      label: string;
      value: string | null | undefined;
      currentLabel?: string | null;
      excludeId?: string | null;
    }
  | {
      kind: "keyValue";
      key: K;
      label: string;
      value: Record<string, unknown> | null | undefined;
      help?: string;
    };

type EditValue = string | boolean | null | Record<string, unknown>;

type KvRow = { id: string; key: string; value: string };
type FieldState =
  | { kind: "scalar"; value: string | boolean }
  | { kind: "kv"; rows: KvRow[] }
  | { kind: "entity"; id: string | null; label: string };

function newRowId() {
  return Math.random().toString(36).slice(2, 10);
}

function rowsFromObject(obj: Record<string, unknown> | null | undefined): KvRow[] {
  if (!obj) return [];
  return Object.entries(obj).map(([k, v]) => ({
    id: newRowId(),
    key: k,
    value: typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v),
  }));
}

function FundingEntityPickerField({
  state,
  excludeId,
  onChange,
}: {
  state: { id: string | null; label: string };
  excludeId?: string | null;
  onChange: (next: { id: string | null; label: string }) => void;
}) {
  const [search, setSearch] = useState(state.label);
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState(search);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (state.label !== search) setSearch(state.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.id, state.label]);

  const params = useMemo(
    () => ({ search: debounced || undefined, limit: 8 }),
    [debounced],
  );
  const resp = useListFundingEntities(params, {
    query: {
      enabled: open,
      queryKey: getListFundingEntitiesQueryKey(params),
    },
  });
  const results = (resp.data?.data ?? []).filter((e) => e.id !== excludeId);

  return (
    <div className="space-y-1">
      <div className="relative">
        <Input
          placeholder="Search funding entities…"
          value={search}
          onFocus={(e) => {
            if (state.id) e.currentTarget.select();
            setOpen(true);
          }}
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 150);
          }}
          onChange={(e) => {
            setSearch(e.target.value);
            setOpen(true);
            if (state.id) onChange({ id: null, label: e.target.value });
          }}
        />
        {open && (
          <div className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto rounded-md border bg-popover shadow">
            <button
              type="button"
              onClick={() => {
                onChange({ id: null, label: "" });
                setSearch("");
                setOpen(false);
              }}
              className="block w-full text-left px-3 py-1.5 text-sm hover:bg-muted text-muted-foreground italic"
            >
              None (clear parent)
            </button>
            {results.length === 0 ? (
              <div className="p-2 text-xs text-muted-foreground">No matches.</div>
            ) : (
              results.map((r) => {
                const label = r.displayName || r.legalName || "Funding Entity";
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      onChange({ id: r.id, label });
                      setSearch(label);
                      setOpen(false);
                    }}
                    className="block w-full text-left px-3 py-1.5 text-sm hover:bg-muted"
                  >
                    {label}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
      {state.id ? (
        <p className="text-xs text-muted-foreground">
          Selected: <span className="font-medium text-foreground">{state.label}</span>
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Choose a result from the list (typing alone won't set a parent).
        </p>
      )}
    </div>
  );
}

export function EditDialog<T extends Record<string, EditValue>>({
  trigger,
  title,
  fields,
  onSubmit,
  isPending,
}: {
  trigger: ReactNode;
  title: string;
  fields: ReadonlyArray<EditField<keyof T & string>>;
  onSubmit: (values: T) => Promise<void> | void;
  isPending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<Record<string, FieldState>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const init: Record<string, FieldState> = {};
    for (const f of fields) {
      if (f.kind === "keyValue") {
        init[f.key] = { kind: "kv", rows: rowsFromObject(f.value) };
      } else if (f.kind === "checkbox") {
        init[f.key] = { kind: "scalar", value: !!f.value };
      } else if (f.kind === "fundingEntityPicker") {
        init[f.key] = {
          kind: "entity",
          id: f.value ?? null,
          label: f.value ? (f.currentLabel ?? f.value) : "",
        };
      } else {
        init[f.key] = { kind: "scalar", value: f.value ?? "" };
      }
    }
    setState(init);
    setError(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateScalar = (key: string, value: string | boolean) => {
    setState((s) => ({ ...s, [key]: { kind: "scalar", value } }));
  };
  const updateRows = (key: string, updater: (rows: KvRow[]) => KvRow[]) => {
    setState((s) => {
      const cur = s[key];
      const rows = cur && cur.kind === "kv" ? cur.rows : [];
      return { ...s, [key]: { kind: "kv", rows: updater(rows) } };
    });
  };
  const updateEntity = (key: string, next: { id: string | null; label: string }) => {
    setState((s) => ({ ...s, [key]: { kind: "entity", id: next.id, label: next.label } }));
  };

  const getScalar = (key: string): string => {
    const f = state[key];
    if (!f || f.kind !== "scalar") return "";
    return typeof f.value === "string" ? f.value : "";
  };
  const getBool = (key: string): boolean => {
    const f = state[key];
    return f && f.kind === "scalar" && typeof f.value === "boolean" ? f.value : false;
  };
  const getRows = (key: string): KvRow[] => {
    const f = state[key];
    return f && f.kind === "kv" ? f.rows : [];
  };
  const getEntity = (key: string): { id: string | null; label: string } => {
    const f = state[key];
    return f && f.kind === "entity" ? { id: f.id, label: f.label } : { id: null, label: "" };
  };

  const handleSave = async () => {
    setError(null);
    const out: Record<string, EditValue> = {};
    for (const f of fields) {
      const fs = state[f.key];
      if (f.kind === "keyValue") {
        const rows = fs && fs.kind === "kv" ? fs.rows : [];
        const obj: Record<string, unknown> = {};
        const seen = new Set<string>();
        const original = f.value ?? {};
        for (const r of rows) {
          const k = r.key.trim();
          if (!k) continue;
          if (seen.has(k)) {
            setError(`${f.label}: duplicate key "${k}".`);
            return;
          }
          seen.add(k);
          const orig = (original as Record<string, unknown>)[k];
          const origStr =
            orig === undefined
              ? undefined
              : orig === null
              ? ""
              : typeof orig === "string"
              ? orig
              : JSON.stringify(orig);
          if (orig !== undefined && origStr === r.value) {
            obj[k] = orig;
          } else {
            obj[k] = r.value;
          }
        }
        out[f.key] = Object.keys(obj).length === 0 ? null : obj;
      } else if (f.kind === "checkbox") {
        out[f.key] = fs && fs.kind === "scalar" ? !!fs.value : false;
      } else if (f.kind === "fundingEntityPicker") {
        out[f.key] = fs && fs.kind === "entity" ? fs.id : null;
      } else {
        const raw = fs && fs.kind === "scalar" && typeof fs.value === "string" ? fs.value : "";
        out[f.key] = raw === "" ? null : raw;
      }
    }
    try {
      await onSubmit(out as T);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {fields.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={f.key}>{f.label}</Label>
              {f.kind === "text" && (
                <Input
                  id={f.key}
                  value={getScalar(f.key)}
                  onChange={(e) => updateScalar(f.key, e.target.value)}
                />
              )}
              {f.kind === "date" && (
                <Input
                  id={f.key}
                  type="date"
                  value={getScalar(f.key)}
                  onChange={(e) => updateScalar(f.key, e.target.value)}
                />
              )}
              {f.kind === "textarea" && (
                <Textarea
                  id={f.key}
                  rows={4}
                  value={getScalar(f.key)}
                  onChange={(e) => updateScalar(f.key, e.target.value)}
                />
              )}
              {f.kind === "select" && (
                <select
                  id={f.key}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={getScalar(f.key)}
                  onChange={(e) => updateScalar(f.key, e.target.value)}
                >
                  <option value="">—</option>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              )}
              {f.kind === "checkbox" && (
                <div className="flex items-center gap-2">
                  <input
                    id={f.key}
                    type="checkbox"
                    checked={getBool(f.key)}
                    onChange={(e) => updateScalar(f.key, e.target.checked)}
                  />
                  <span className="text-sm text-muted-foreground">{f.label}</span>
                </div>
              )}
              {f.kind === "fundingEntityPicker" && (
                <FundingEntityPickerField
                  state={getEntity(f.key)}
                  excludeId={f.excludeId ?? undefined}
                  onChange={(next) => updateEntity(f.key, next)}
                />
              )}
              {f.kind === "keyValue" && (
                <KeyValueEditor
                  rows={getRows(f.key)}
                  onChange={(updater) => updateRows(f.key, updater)}
                  help={f.help}
                />
              )}
            </div>
          ))}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending}>{isPending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KeyValueEditor({
  rows,
  onChange,
  help,
}: {
  rows: KvRow[];
  onChange: (updater: (rows: KvRow[]) => KvRow[]) => void;
  help?: string;
}) {
  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <p className="text-xs text-muted-foreground italic">No custom fields. Click "Add field" to create one.</p>
      )}
      {rows.map((row) => (
        <div key={row.id} className="flex items-start gap-2">
          <Input
            placeholder="key"
            value={row.key}
            className="flex-1"
            onChange={(e) =>
              onChange((rs) => rs.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))
            }
          />
          <Input
            placeholder="value"
            value={row.value}
            className="flex-[2]"
            onChange={(e) =>
              onChange((rs) => rs.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange((rs) => rs.filter((r) => r.id !== row.id))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          onChange((rs) => [...rs, { id: newRowId(), key: "", value: "" }])
        }
      >
        Add field
      </Button>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}
