import { useMemo } from "react";
import {
  useListEntities,
  getListEntitiesQueryKey,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EntityMultiSelect } from "@/components/entity-filter";
import GoogleConnectSection from "@/components/google-connect-section";
import { useEntityFilter } from "@/lib/entity-filter-context";

// User-level settings. Per-user prefs and per-user connections live here;
// admin-level config (entities, goals, sync health) stays on /admin.
export default function Settings() {
  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Settings
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Personal preferences and connections for your CRM account.
        </p>
      </div>

      <DefaultEntitySection />
      <GoogleConnectSection returnTo="/settings" />
    </div>
  );
}

function DefaultEntitySection() {
  const { defaults, setDefaults, setSelected } = useEntityFilter();
  const entitiesQ = useListEntities({
    query: { queryKey: getListEntitiesQueryKey(), staleTime: 5 * 60_000 },
  });
  const options = useMemo(
    () =>
      (entitiesQ.data ?? []).map((e) => ({
        id: e.id,
        name: e.name,
        active: e.active,
      })),
    [entitiesQ.data],
  );

  return (
    <Card data-testid="settings-default-entity-section">
      <CardHeader>
        <CardTitle>Default entity filter</CardTitle>
        <CardDescription>
          Pick the entity (or entities) you most often want to focus on. This
          seeds the entity filter in the page header the first time you open
          the CRM in a browser, and the "Apply now" button below re-applies it
          to your current session. Leave empty to default to all entities.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
          <EntityMultiSelect
            options={options}
            value={defaults}
            onChange={setDefaults}
            align="start"
            triggerLabelPrefix="Default:"
            placeholder="All entities"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSelected(defaults)}
            className="h-8"
            data-testid="settings-default-entity-apply"
          >
            Apply to current session
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Saved to this browser only. Sign in on another device to set it
          there too.
        </p>
      </CardContent>
    </Card>
  );
}
