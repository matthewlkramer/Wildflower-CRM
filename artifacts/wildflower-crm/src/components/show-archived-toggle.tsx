import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useIsAdmin } from "@/hooks/use-is-admin";

/**
 * Admin-only "Show archived" switch. Renders nothing for non-admins — the
 * server also refuses to return archived rows to them, so the toggle would be
 * a no-op. Pages own the boolean state and pass it (plus the list query's
 * `includeArchived` param) down.
 */
export function ShowArchivedToggle({
  value,
  onChange,
  testId = "toggle-show-archived",
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}) {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return null;
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={testId}
        checked={value}
        onCheckedChange={onChange}
        data-testid={testId}
      />
      <Label
        htmlFor={testId}
        className="cursor-pointer text-sm text-muted-foreground"
      >
        Show archived
      </Label>
    </div>
  );
}
