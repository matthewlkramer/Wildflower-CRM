import { useState } from "react";
import { FolderOpen, Pencil, Archive, ArchiveRestore, Trash2, Check, X, Flag } from "lucide-react";
import type { FlagForResearchBodyTargetType } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { FlagForResearchDialog } from "@/components/flag-for-research-dialog";

export type RowActionIconsProps = {
  /** Human-readable label of the row's entity, used for accessible button names. */
  entityLabel: string;
  /** Stable suffix for data-testids, e.g. `payint-<id>`. */
  testIdPrefix: string;
  onOpen?: () => void;
  onEdit?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  flagForResearch?: {
    targetType: FlagForResearchBodyTargetType;
    targetId: string;
  };
  /** When true, the archive control shows an "unarchive" affordance instead. */
  archived?: boolean;
  /** Disable the whole group (e.g. while a sibling row is saving). */
  disabled?: boolean;
};

/**
 * Always-visible inline row actions rendered as compact icon buttons. Only the
 * actions wired with a handler are shown, so a page opts into open/edit/archive/
 * delete individually. Clicks are isolated from the row so they never trigger
 * row-level navigation.
 */
export function RowActionIcons({
  entityLabel,
  testIdPrefix,
  onOpen,
  onEdit,
  onArchive,
  onDelete,
  flagForResearch,
  archived = false,
  disabled = false,
}: RowActionIconsProps) {
  const [flagOpen, setFlagOpen] = useState(false);
  const archiveLabel = archived ? "Unarchive" : "Archive";
  return (
    <>
    <div
      className="flex items-center justify-end gap-0.5"
      onClick={(e) => e.stopPropagation()}
    >
      {onOpen && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={onOpen}
          disabled={disabled}
          aria-label={`Open ${entityLabel}`}
          title="Open"
          data-testid={`button-open-${testIdPrefix}`}
        >
          <FolderOpen className="h-4 w-4" />
        </Button>
      )}
      {onEdit && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={onEdit}
          disabled={disabled}
          aria-label={`Edit ${entityLabel}`}
          title="Edit"
          data-testid={`button-edit-${testIdPrefix}`}
        >
          <Pencil className="h-4 w-4" />
        </Button>
      )}
      {onArchive && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={onArchive}
          disabled={disabled}
          aria-label={`${archiveLabel} ${entityLabel}`}
          title={archiveLabel}
          data-testid={`button-archive-${testIdPrefix}`}
        >
          {archived ? (
            <ArchiveRestore className="h-4 w-4" />
          ) : (
            <Archive className="h-4 w-4" />
          )}
        </Button>
      )}
      {flagForResearch && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={() => setFlagOpen(true)}
          disabled={disabled}
          aria-label={`Flag ${entityLabel} for research`}
          title="Flag for research"
          data-testid={`button-flag-${testIdPrefix}`}
        >
          <Flag className="h-4 w-4" />
        </Button>
      )}
      {onDelete && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          disabled={disabled}
          aria-label={`Delete ${entityLabel}`}
          title="Delete"
          data-testid={`button-delete-${testIdPrefix}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
      {flagForResearch && (
        <FlagForResearchDialog
          targetType={flagForResearch.targetType}
          targetId={flagForResearch.targetId}
          recordLabel={entityLabel}
          open={flagOpen}
          onOpenChange={setFlagOpen}
          hideTrigger
        />
      )}
    </>
  );
}

export type InlineRowSaveActionsProps = {
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
  /** Disable save (e.g. invalid draft) without disabling cancel. */
  saveDisabled?: boolean;
  testIdPrefix: string;
};

/** Save/Cancel icon controls shown in the actions cell while a row is edited inline. */
export function InlineRowSaveActions({
  onSave,
  onCancel,
  saving = false,
  saveDisabled = false,
  testIdPrefix,
}: InlineRowSaveActionsProps) {
  return (
    <div
      className="flex items-center justify-end gap-0.5"
      onClick={(e) => e.stopPropagation()}
    >
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-primary hover:text-primary"
        onClick={onSave}
        disabled={saving || saveDisabled}
        aria-label="Save"
        title="Save"
        data-testid={`button-save-${testIdPrefix}`}
      >
        <Check className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-muted-foreground"
        onClick={onCancel}
        disabled={saving}
        aria-label="Cancel"
        title="Cancel"
        data-testid={`button-cancel-${testIdPrefix}`}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
