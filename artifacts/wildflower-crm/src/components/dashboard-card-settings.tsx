import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { SlidersHorizontal } from "lucide-react";

export const DASHBOARD_CARDS = {
  goals: "Progress to goal",
  cleanup: "Data cleanup and integrity",
  upcoming: "Upcoming meetings",
  past: "Past meeting follow-ups",
  thanks: "Gifts needing thank-yous",
  priorities: "Top priorities",
  tasks: "Open tasks",
  email: "Email proposals",
  grants: "Grant leads",
  projections: "Projections",
  deadlines: "Application/close deadlines",
  moves: "Moves",
} as const;
export type DashboardCardId = keyof typeof DASHBOARD_CARDS;

function readHiddenCards(userId: string): DashboardCardId[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`wf-dashboard-cards:${userId}`) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter(
          (id): id is DashboardCardId =>
            typeof id === "string" && Object.hasOwn(DASHBOARD_CARDS, id),
        )
      : [];
  } catch {
    return [];
  }
}

export function useDashboardCards(userId: string | undefined) {
  const [preferences, setPreferences] = useState<{
    userId?: string;
    hidden: DashboardCardId[];
  }>({ hidden: [] });
  useEffect(() => {
    setPreferences({ userId, hidden: userId ? readHiddenCards(userId) : [] });
  }, [userId]);
  const hidden = preferences.userId === userId ? preferences.hidden : [];
  function toggle(id: DashboardCardId, visible: boolean) {
    if (!userId) return;
    const next = visible
      ? hidden.filter((item) => item !== id)
      : [...new Set([...hidden, id])];
    setPreferences({ userId, hidden: next });
    try {
      localStorage.setItem(
        `wf-dashboard-cards:${userId}`,
        JSON.stringify(next),
      );
    } catch {
      /* Keep the current session usable if storage is unavailable. */
    }
  }
  return { hidden, toggle };
}

export function DashboardCardSettings({
  userId,
  hidden,
  toggle,
}: {
  userId?: string;
  hidden: DashboardCardId[];
  toggle: (id: DashboardCardId, visible: boolean) => void;
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="outline" size="sm">
          <SlidersHorizontal className="mr-2 h-4 w-4" />
          Customize dashboard
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 rounded-md border p-3">
        <p className="mb-3 text-xs text-muted-foreground">
          Choose which cards to show. Your choices are saved in this browser.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.entries(DASHBOARD_CARDS) as [DashboardCardId, string][]).map(
            ([id, label]) => (
              <label
                key={id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                {label}
                <Switch
                  aria-label={`Show ${label}`}
                  checked={!hidden.includes(id)}
                  disabled={!userId}
                  onCheckedChange={(visible) => toggle(id, visible)}
                />
              </label>
            ),
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
