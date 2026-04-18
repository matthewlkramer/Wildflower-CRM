import { useState, useEffect, ReactNode } from "react";
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
  | { kind: "json"; key: K; label: string; value: Record<string, unknown> | null | undefined; help?: string };

type EditValue = string | boolean | null | Record<string, unknown>;

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
  const [state, setState] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const init: Record<string, string | boolean> = {};
    for (const f of fields) {
      if (f.kind === "json") {
        init[f.key] = f.value ? JSON.stringify(f.value, null, 2) : "";
      } else if (f.kind === "checkbox") {
        init[f.key] = !!f.value;
      } else {
        init[f.key] = f.value ?? "";
      }
    }
    setState(init);
    setError(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    setError(null);
    const out: Record<string, EditValue> = {};
    for (const f of fields) {
      const raw = state[f.key];
      if (f.kind === "json") {
        const text = (typeof raw === "string" ? raw : "").trim();
        if (!text) {
          out[f.key] = null;
        } else {
          try {
            const parsed: unknown = JSON.parse(text);
            if (parsed === null || (typeof parsed === "object" && !Array.isArray(parsed))) {
              out[f.key] = parsed as Record<string, unknown> | null;
            } else {
              setError(`${f.label}: must be a JSON object.`);
              return;
            }
          } catch {
            setError(`${f.label}: must be valid JSON.`);
            return;
          }
        }
      } else if (f.kind === "checkbox") {
        out[f.key] = !!raw;
      } else {
        out[f.key] = raw === "" ? null : (raw as string);
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
                  value={(state[f.key] as string) ?? ""}
                  onChange={(e) => setState((s) => ({ ...s, [f.key]: e.target.value }))}
                />
              )}
              {f.kind === "date" && (
                <Input
                  id={f.key}
                  type="date"
                  value={(state[f.key] as string) ?? ""}
                  onChange={(e) => setState((s) => ({ ...s, [f.key]: e.target.value }))}
                />
              )}
              {f.kind === "textarea" && (
                <Textarea
                  id={f.key}
                  rows={4}
                  value={(state[f.key] as string) ?? ""}
                  onChange={(e) => setState((s) => ({ ...s, [f.key]: e.target.value }))}
                />
              )}
              {f.kind === "select" && (
                <select
                  id={f.key}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={(state[f.key] as string) ?? ""}
                  onChange={(e) => setState((s) => ({ ...s, [f.key]: e.target.value }))}
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
                    checked={!!state[f.key]}
                    onChange={(e) => setState((s) => ({ ...s, [f.key]: e.target.checked }))}
                  />
                  <span className="text-sm text-muted-foreground">{f.label}</span>
                </div>
              )}
              {f.kind === "json" && (
                <>
                  <Textarea
                    id={f.key}
                    rows={6}
                    placeholder='{ "myKey": "myValue" }'
                    value={(state[f.key] as string) ?? ""}
                    onChange={(e) => setState((s) => ({ ...s, [f.key]: e.target.value }))}
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">{f.help ?? "Enter a JSON object of custom field key/value pairs."}</p>
                </>
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
