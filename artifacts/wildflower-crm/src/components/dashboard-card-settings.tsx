import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";

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
    <details className="rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Customize dashboard
      </summary>
      <p className="my-3 text-xs text-muted-foreground">
        Choose your cards. Saved for your account on this browser.
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
    </details>
  );
}
