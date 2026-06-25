import { useMemo } from "react";
import {
  useListEntities,
  getListEntitiesQueryKey,
  useGetCurrentUser,
  useUpdateCurrentUser,
  getGetCurrentUserQueryKey,
  type EmailSyncMode,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { EntityMultiSelect } from "@/components/entity-filter";
import GoogleConnectSection from "@/components/google-connect-section";
import GoogleSyncStatusSection from "@/components/google-sync-status-section";
import ExtensionTokenSection from "@/components/extension-token-section";
import { useEntityFilter } from "@/lib/entity-filter-context";

// User-level settings. Per-user prefs and per-user connections live here;
// admin-level config (entities, goals, sync health, org-wide integrations like
// QuickBooks) stays on /admin.
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

      <Tabs defaultValue="general" className="space-y-6">
        <TabsList className="flex h-auto flex-wrap justify-start gap-1">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="email">Email</TabsTrigger>
          <TabsTrigger value="connections">Connections</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-8">
          <DefaultEntitySection />
        </TabsContent>

        <TabsContent value="email" className="space-y-8">
          <EmailPrivacySection />
          <GoogleSyncStatusSection />
        </TabsContent>

        <TabsContent value="connections" className="space-y-8">
          <GoogleConnectSection returnTo="/settings" />
          <ExtensionTokenSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EmailPrivacySection() {
  const qc = useQueryClient();
  const { data: me } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });
  const updateMe = useUpdateCurrentUser({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
      },
    },
  });
  const current: EmailSyncMode = me?.emailSyncMode ?? "full";
  const set = (mode: EmailSyncMode) => {
    if (mode === current) return;
    updateMe.mutate({ data: { emailSyncMode: mode } });
  };
  return (
    <Card data-testid="settings-email-privacy-section">
      <CardHeader>
        <CardTitle>Email sync privacy</CardTitle>
        <CardDescription>
          Controls what's stored when your Gmail is synced into the CRM.
          The setting applies to NEW emails synced from this point on —
          emails already in the CRM are not changed retroactively. Your
          choice wins for everyone: if you pick summary-only, no
          teammate ever sees the body of your synced emails, because the
          body is never persisted in the first place.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <PrivacyChoice
          checked={current === "full"}
          onSelect={() => set("full")}
          disabled={updateMe.isPending}
          testId="email-privacy-full"
          title="Full sync (default)"
          desc="Store the subject, body, and attachments of every synced email. Anyone on your team viewing the contact can read the full message."
        />
        <PrivacyChoice
          checked={current === "summary_only"}
          onSelect={() => set("summary_only")}
          disabled={updateMe.isPending}
          testId="email-privacy-summary"
          title="Summary only"
          desc="Store ONLY a one-line AI summary of each email — body and attachments are summarized in flight and then discarded. They are never written to our database and cannot be retrieved later. AI-generated proposals and intelligence are also skipped for your mailbox."
        />
      </CardContent>
    </Card>
  );
}

function PrivacyChoice({
  checked, onSelect, disabled, testId, title, desc,
}: {
  checked: boolean;
  onSelect: () => void;
  disabled: boolean;
  testId: string;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      data-testid={testId}
      aria-pressed={checked}
      className={`w-full text-left rounded-md border p-3 transition-colors ${
        checked ? "border-primary bg-primary/5" : "hover:bg-muted/40"
      } ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-1 h-4 w-4 rounded-full border ${
            checked ? "border-primary bg-primary" : "border-muted-foreground/40"
          }`}
        />
        <div className="space-y-1">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{desc}</div>
        </div>
      </div>
    </button>
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
