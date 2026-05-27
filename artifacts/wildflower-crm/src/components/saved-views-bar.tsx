import { useState } from "react";
import { Bookmark, Check, Plus, Save, Trash2, User, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type {
  SavedView,
  SavedViewVisibility,
  UseSavedViewsResult,
} from "@/hooks/use-saved-views";

// Renders the row of saved-view chips + Save-as / Update affordances
// above a list page's filter controls. One-line drop-in: pass the
// controller from useSavedViews, plus canSave (false on the empty
// default state) and onClearAll (the page's own "reset all" function).

interface Props<T extends object> {
  controller: UseSavedViewsResult<T>;
  /** When true, "Save as…" and "Update view" are hidden. */
  canSave: boolean;
  /** Reset the page back to the default (cleared) filter+sort state. */
  onClearAll: () => void;
}

function VisibilityIcon({ visibility }: { visibility: SavedViewVisibility }) {
  return visibility === "team" ? (
    <Users className="h-3 w-3" aria-label="Team view" />
  ) : (
    <User className="h-3 w-3" aria-label="Individual view" />
  );
}

export function SavedViewsBar<T extends object>({
  controller,
  canSave,
  onClearAll,
}: Props<T>) {
  const {
    views,
    activeId,
    pinnedId,
    isModified,
    currentUserId,
    saveAs,
    updateActive,
    remove,
    applyView,
    clearActive,
  } = controller;
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<SavedViewVisibility>("individual");
  const [submitting, setSubmitting] = useState(false);

  async function commitSave() {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await saveAs(trimmed, visibility);
      setName("");
      setSaving(false);
    } finally {
      setSubmitting(false);
    }
  }

  const noViews = views.length === 0;
  const defaultActive = activeId === null && !isModified;

  // "Update view" needs to find the user's last-pinned view even when
  // the current filters have been edited away from it (`isModified`
  // ⇒ activeId === null). Use the controller's pinnedId for ownership
  // — activeId would always be null in the "modified" case.
  const pinned: SavedView<T> | undefined = pinnedId
    ? views.find((v) => v.id === pinnedId)
    : undefined;
  const pinnedOwnedByMe = !!pinned && pinned.creatorUserId === currentUserId;

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
        const ownedByMe = v.creatorUserId === currentUserId;
        return (
          <div key={v.id} className="inline-flex">
            <button
              type="button"
              onClick={() => applyView(v.id)}
              className={cn(
                "inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs transition-colors",
                ownedByMe ? "rounded-l-full" : "rounded-full",
                isActive
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-muted",
              )}
              data-testid={`saved-view-${v.id}`}
              data-active={isActive ? "true" : "false"}
              data-visibility={v.visibility}
              title={
                v.visibility === "team"
                  ? `Team view${ownedByMe ? " (you)" : ""}`
                  : "Individual view (only you can see this)"
              }
            >
              <VisibilityIcon visibility={v.visibility} />
              <span className="max-w-[160px] truncate">{v.name}</span>
              {isActive ? <Check className="h-3 w-3" /> : null}
            </button>
            {/* Delete is creator-only — non-owners can apply team views
                but never delete them. Hiding the button (rather than
                disabling) keeps the chip compact in the common case. */}
            {ownedByMe ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Delete view "${v.name}"?`)) {
                    void remove(v.id);
                  }
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
            ) : null}
          </div>
        );
      })}

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
          className="inline-flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void commitSave();
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
          {/* Compact visibility toggle — two buttons rather than a
              radio so the click target is finger-sized and the
              selected state is obvious. */}
          <div className="inline-flex rounded-md border border-border bg-background overflow-hidden">
            <button
              type="button"
              onClick={() => setVisibility("individual")}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 text-xs transition-colors",
                visibility === "individual"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
              data-testid="saved-views-visibility-individual"
              aria-pressed={visibility === "individual"}
              title="Only visible to you"
            >
              <User className="h-3 w-3" />
              Just me
            </button>
            <button
              type="button"
              onClick={() => setVisibility("team")}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 text-xs border-l border-border transition-colors",
                visibility === "team"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
              data-testid="saved-views-visibility-team"
              aria-pressed={visibility === "team"}
              title="Visible to everyone (only you can edit/delete)"
            >
              <Users className="h-3 w-3" />
              Team
            </button>
          </div>
          <Button
            type="submit"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={!name.trim() || submitting}
            data-testid="saved-views-name-confirm"
          >
            {submitting ? "Saving…" : "Save"}
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

      {/* Update-active: only offered when the user has applied a view
          they own and then changed filters. Non-owners can't update
          team views (server returns 403), so we hide the button. */}
      {isModified && !saving && pinnedOwnedByMe ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => void updateActive()}
          data-testid="saved-views-update-active"
        >
          <Save className="h-3 w-3 mr-1" />
          Update view
        </Button>
      ) : null}

      {noViews && !canSave && !saving ? (
        <span className="text-xs text-muted-foreground">
          Apply filters to save a view.
        </span>
      ) : null}
    </div>
  );
}
