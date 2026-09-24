import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type DashboardScope = "mine" | "team";

export function DashboardScopeToggle({
  value,
  onValueChange,
  testId,
  className,
}: {
  value: DashboardScope;
  onValueChange: (value: DashboardScope) => void;
  testId: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center rounded-md border bg-muted/30 p-0.5",
        className,
      )}
      role="group"
      aria-label="Work scope"
      data-testid={testId}
    >
      <Button
        type="button"
        size="sm"
        variant={value === "mine" ? "default" : "ghost"}
        className="h-7 px-3 text-xs"
        aria-pressed={value === "mine"}
        onClick={() => onValueChange("mine")}
      >
        My work
      </Button>
      <Button
        type="button"
        size="sm"
        variant={value === "team" ? "default" : "ghost"}
        className="h-7 px-3 text-xs"
        aria-pressed={value === "team"}
        onClick={() => onValueChange("team")}
      >
        Team
      </Button>
    </div>
  );
}
