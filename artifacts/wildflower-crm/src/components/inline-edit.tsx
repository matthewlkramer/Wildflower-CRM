import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type SaveResult = unknown | Promise<unknown>;

type BaseProps = {
  label: string;
  testIdBase?: string;
  display: ReactNode;
};

function EditTriggerRow({
  display,
  onEdit,
  testIdBase,
  ariaLabel,
}: {
  display: ReactNode;
  onEdit: () => void;
  testIdBase?: string;
  ariaLabel: string;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="truncate text-right flex-1">{display}</div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-muted-foreground hover:text-foreground"
        onClick={onEdit}
        aria-label={ariaLabel}
        data-testid={testIdBase ? `button-edit-${testIdBase}` : undefined}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function ActionButtons({
  busy,
  canSave,
  onSave,
  onCancel,
  testIdBase,
  label,
}: {
  busy: boolean;
  canSave: boolean;
  onSave: () => void;
  onCancel: () => void;
  testIdBase?: string;
  label: string;
}) {
  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7 text-primary"
        disabled={!canSave || busy}
        onClick={onSave}
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
        onClick={onCancel}
        aria-label={`Cancel ${label}`}
        data-testid={testIdBase ? `button-cancel-${testIdBase}` : undefined}
      >
        <X className="h-4 w-4" />
      </Button>
    </>
  );
}

/**
 * Runs an async save with a synchronous re-entry guard via ref.
 * Without the ref, rapid Enter presses / double-clicks can fire multiple PATCHes
 * before React applies the `disabled`/busy state.
 */
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
      // Caller's mutation onError toast is the user-facing channel.
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return { busy, run };
}

// ---------- TEXT ----------

export function InlineEditText({
  label,
  display,
  value,
  onSave,
  testIdBase,
  placeholder,
  allowEmpty = true,
}: BaseProps & {
  value: string | null;
  onSave: (next: string | null) => SaveResult;
  placeholder?: string;
  allowEmpty?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const { busy, run } = useSaveRunner();
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value ?? "");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [editing, value]);

  if (!editing) {
    return (
      <EditTriggerRow
        display={display}
        onEdit={() => setEditing(true)}
        testIdBase={testIdBase}
        ariaLabel={`Edit ${label}`}
      />
    );
  }

  const trimmed = draft.trim();
  const next = trimmed.length === 0 ? null : trimmed;
  const dirty = next !== (value ?? null);
  const canSave = dirty && (allowEmpty || next !== null);
  const trySave = () => {
    if (!canSave || busy) return;
    run(() => onSave(next), () => setEditing(false));
  };

  return (
    <div className="flex items-center gap-1 min-w-0">
      <Input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        disabled={busy}
        data-testid={testIdBase ? `input-${testIdBase}` : undefined}
        className="h-8 text-right"
        onKeyDown={(e) => {
          if (e.key === "Enter") trySave();
          if (e.key === "Escape" && !busy) setEditing(false);
        }}
      />
      <ActionButtons
        busy={busy}
        canSave={canSave}
        onSave={trySave}
        onCancel={() => setEditing(false)}
        testIdBase={testIdBase}
        label={label}
      />
    </div>
  );
}

// ---------- CURRENCY ----------

export function InlineEditCurrency({
  label,
  display,
  value,
  onSave,
  testIdBase,
}: BaseProps & {
  value: string | null;
  onSave: (next: string | null) => SaveResult;
}) {
  const [editing, setEditing] = useState(false);
  const { busy, run } = useSaveRunner();
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value ?? "");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [editing, value]);

  if (!editing) {
    return (
      <EditTriggerRow
        display={display}
        onEdit={() => setEditing(true)}
        testIdBase={testIdBase}
        ariaLabel={`Edit ${label}`}
      />
    );
  }

  const trimmed = draft.trim();
  let next: string | null;
  let parseOk = true;
  if (trimmed.length === 0) {
    next = null;
  } else {
    const n = Number(trimmed.replace(/[,$\s]/g, ""));
    parseOk = Number.isFinite(n) && n >= 0;
    next = parseOk ? String(n) : null;
  }
  const currentStr = value === null ? null : String(Number(value));
  const dirty = next !== currentStr;
  const canSave = parseOk && dirty;
  const trySave = () => {
    if (!canSave || busy) return;
    run(() => onSave(next), () => setEditing(false));
  };

  return (
    <div className="flex items-center gap-1 min-w-0">
      <Input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        inputMode="decimal"
        aria-label={label}
        aria-invalid={!parseOk}
        disabled={busy}
        data-testid={testIdBase ? `input-${testIdBase}` : undefined}
        className="h-8 text-right"
        onKeyDown={(e) => {
          if (e.key === "Enter") trySave();
          if (e.key === "Escape" && !busy) setEditing(false);
        }}
      />
      <ActionButtons
        busy={busy}
        canSave={canSave}
        onSave={trySave}
        onCancel={() => setEditing(false)}
        testIdBase={testIdBase}
        label={label}
      />
    </div>
  );
}

// ---------- DATE ----------

export function InlineEditDate({
  label,
  display,
  value,
  onSave,
  testIdBase,
}: BaseProps & {
  value: string | null;
  onSave: (next: string | null) => SaveResult;
}) {
  const [editing, setEditing] = useState(false);
  const { busy, run } = useSaveRunner();
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => {
    if (editing) setDraft(value ?? "");
  }, [editing, value]);

  if (!editing) {
    return (
      <EditTriggerRow
        display={display}
        onEdit={() => setEditing(true)}
        testIdBase={testIdBase}
        ariaLabel={`Edit ${label}`}
      />
    );
  }

  const next = draft.trim().length === 0 ? null : draft;
  const dirty = next !== (value ?? null);
  const trySave = () => {
    if (!dirty || busy) return;
    run(() => onSave(next), () => setEditing(false));
  };

  return (
    <div className="flex items-center gap-1 min-w-0">
      <Input
        type="date"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={label}
        disabled={busy}
        data-testid={testIdBase ? `input-${testIdBase}` : undefined}
        className="h-8"
      />
      <ActionButtons
        busy={busy}
        canSave={dirty}
        onSave={trySave}
        onCancel={() => setEditing(false)}
        testIdBase={testIdBase}
        label={label}
      />
    </div>
  );
}

// ---------- SELECT ----------

export type InlineSelectOption<T extends string> = { value: T; label: string };

export function InlineEditSelect<T extends string>({
  label,
  display,
  value,
  options,
  onSave,
  testIdBase,
  nullLabel = "— None —",
  allowNull = true,
}: BaseProps & {
  value: T | null;
  options: ReadonlyArray<InlineSelectOption<T>>;
  onSave: (next: T | null) => SaveResult;
  nullLabel?: string;
  allowNull?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const { busy, run } = useSaveRunner();
  const NULL_TOKEN = "__null__";
  const fallback: string = allowNull ? NULL_TOKEN : (options[0]?.value ?? NULL_TOKEN);
  const [draft, setDraft] = useState<string>(value ?? fallback);

  useEffect(() => {
    if (editing) setDraft(value ?? fallback);
  }, [editing, value, fallback]);

  if (!editing) {
    return (
      <EditTriggerRow
        display={display}
        onEdit={() => setEditing(true)}
        testIdBase={testIdBase}
        ariaLabel={`Edit ${label}`}
      />
    );
  }

  const next: T | null = draft === NULL_TOKEN ? null : (draft as T);
  const dirty = next !== (value ?? null);
  const trySave = () => {
    if (!dirty || busy) return;
    run(() => onSave(next), () => setEditing(false));
  };

  return (
    <div className="flex items-center gap-1 min-w-0">
      <Select value={draft} onValueChange={setDraft} disabled={busy}>
        <SelectTrigger
          className="h-8"
          aria-label={label}
          data-testid={testIdBase ? `select-${testIdBase}` : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowNull ? <SelectItem value={NULL_TOKEN}>{nullLabel}</SelectItem> : null}
          {options.map((o) => (
            <SelectItem
              key={o.value}
              value={o.value}
              data-testid={testIdBase ? `option-${testIdBase}-${o.value}` : undefined}
            >
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ActionButtons
        busy={busy}
        canSave={dirty}
        onSave={trySave}
        onCancel={() => setEditing(false)}
        testIdBase={testIdBase}
        label={label}
      />
    </div>
  );
}
