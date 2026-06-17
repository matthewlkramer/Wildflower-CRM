import { useCallback, useState } from "react";

/**
 * Standardizes the inline single-row edit pattern shared by the list pages
 * (payment-intermediaries was the original hand-rolled version). Manages which
 * row is currently being edited, a typed draft for the editable cells, and an
 * in-flight save guard. Pages supply how to seed a draft from a row, how to
 * persist it, and (optionally) whether a draft is currently valid.
 *
 * `onSave` should reject on failure (e.g. a rejected `mutateAsync`); the hook
 * swallows the rejection and leaves the row in edit mode so the caller's own
 * error surface (a toast) is the single source of truth.
 */
export function useInlineRowEdit<TRow, TDraft>(opts: {
  /** Stable id for a row. */
  getId: (row: TRow) => string;
  /** Seed the editable draft when a row enters edit mode. */
  toDraft: (row: TRow) => TDraft;
  /** Persist the draft. Reject on failure so the row stays open. */
  onSave: (id: string, draft: TDraft) => Promise<unknown>;
  /** Optional gate; `save` is a no-op while this returns false. */
  isValid?: (draft: TDraft) => boolean;
}) {
  const { getId, toDraft, onSave, isValid } = opts;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const start = useCallback(
    (row: TRow) => {
      setEditingId(getId(row));
      setDraft(toDraft(row));
    },
    [getId, toDraft],
  );

  const cancel = useCallback(() => {
    setEditingId(null);
    setDraft(null);
  }, []);

  /** Shallow-merge a partial change into the current draft. */
  const patch = useCallback((partial: Partial<TDraft>) => {
    setDraft((d) => (d ? { ...d, ...partial } : d));
  }, []);

  const valid = draft != null && (isValid ? isValid(draft) : true);

  const save = useCallback(async () => {
    if (!editingId || draft == null) return;
    if (isValid && !isValid(draft)) return;
    setSaving(true);
    try {
      await onSave(editingId, draft);
      setEditingId(null);
      setDraft(null);
    } catch {
      // Leave the row open; the caller surfaces the error via a toast.
    } finally {
      setSaving(false);
    }
  }, [editingId, draft, isValid, onSave]);

  const isEditing = useCallback((id: string) => editingId === id, [editingId]);

  return { editingId, draft, saving, valid, start, cancel, patch, save, isEditing };
}
