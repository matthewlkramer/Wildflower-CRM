import { useState } from "react";
import { Bookmark, Check, Plus, Save, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { UseSavedViewsResult } from "@/hooks/use-saved-views";

// Render the row of saved-view chips + Save-as / Update affordances
// above a list page's filter controls. Designed to be a one-line drop-in
// on top of an existing list page; the actual filter state lives in the
// caller via useSavedViews.

interface Props<T extends object> {
  controller: UseSavedViewsResult<T>;
  /** When true, "Save as…" and "Update view" are hidden. Use for the
   *  default state (no filters set) where there's nothing to save. */
  canSave: boolean;
  /** Reset the page back to the default (cleared) filter state. */
  onClearAll: () => void;
}

export function SavedViewsBar<T extends object>({
  controller,
  canSave,
  onClearAll,
}: Props<T>) {
  const { views, activeId, isModified, saveAs, updateActive, remove, applyView, clearActive } =
    controller;
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");

  function commitSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    saveAs(trimmed);
    setName("");
    setSaving(false);
  }

  const noViews = views.length === 0;
  // Default chip is "active" when there's no pinned/active view at all.
  const defaultActive = activeId === null && !isModified;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="saved-views-bar">
      <button
        type="button"
        onClick={() => {
          clearActive();
          onClearAll();
        }}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
          defaultActive
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background text-muted-foreground hover:bg-muted",
        )}
        data-testid="saved-view-default"
        data-active={defaultActive ? "true" : "false"}
      >
        <Bookmark className="h-3 w-3" />
        Default
      </button>

      {views.map((v) => {
        const isActive = activeId === v.id;
        return (
          <div key={v.id} className="inline-flex">
            <button
              type="button"
              onClick={() => applyView(v.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-l-full border px-2.5 py-1 text-xs transition-colors",
                isActive
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-muted",
              )}
              data-testid={`saved-view-${v.id}`}
              data-active={isActive ? "true" : "false"}
            >
              <Bookmark className="h-3 w-3" />
              <span className="max-w-[160px] truncate">{v.name}</span>
              {isActive ? <Check className="h-3 w-3" /> : null}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Delete view "${v.name}"?`)) remove(v.id);
              }}
              className={cn(
                "inline-flex items-center justify-center rounded-r-full border border-l-0 px-1.5 py-1 transition-colors",
                isActive
                  ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
                  : "border-border bg-background text-muted-foreground hover:bg-muted",
              )}
              aria-label={`Delete view ${v.name}`}
              data-testid={`saved-view-${v.id}-delete`}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        );
      })}

      {/* Inline "Save as new view" affordance. Only shown when the user
          has filters worth saving, to avoid encouraging a 'default-named'
          view that simply represents the empty state. */}
      {canSave && !saving ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSaving(true)}
          className="h-7 px-2 text-xs"
          data-testid="saved-views-save-as"
        >
          <Plus className="h-3 w-3 mr-1" />
          Save as view
        </Button>
      ) : null}

      {saving ? (
        <form
          className="inline-flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            commitSave();
          }}
        >
          <Input
            autoFocus
            placeholder="View name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-7 w-40 text-xs"
            data-testid="saved-views-name-input"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSaving(false);
                setName("");
              }
            }}
          />
          <Button
            type="submit"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={!name.trim()}
            data-testid="saved-views-name-confirm"
          >
            Save
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-1.5"
            onClick={() => {
              setSaving(false);
              setName("");
            }}
            aria-label="Cancel"
          >
            <X className="h-3 w-3" />
          </Button>
        </form>
      ) : null}

      {/* Update-active appears when the user has applied a view and
          then changed the filters — same flow as Notion / Linear. */}
      {isModified && !saving ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={updateActive}
          data-testid="saved-views-update-active"
        >
          <Save className="h-3 w-3 mr-1" />
          Update view
        </Button>
      ) : null}

      {/* Initial-onboarding hint when there are no views yet. Keeps the
          control discoverable without being noisy. */}
      {noViews && !canSave && !saving ? (
        <span className="text-xs text-muted-foreground">
          Apply filters to save a view.
        </span>
      ) : null}
    </div>
  );
}
