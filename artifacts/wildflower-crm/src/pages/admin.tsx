import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListEntities,
  useCreateEntity,
  useUpdateEntity,
  useListFundableProjects,
  useCreateFundableProject,
  useUpdateFundableProject,
  useListFiscalYears,
  useListFiscalYearEntityGoals,
  useUpsertFiscalYearEntityGoal,
  useDeleteFiscalYearEntityGoal,
  useAdminListGoogleSync,
  useAdminResyncGoogleUser,
  useGetCalendarMeetingFilters,
  useUpdateCalendarMeetingFilters,
  getListEntitiesQueryKey,
  getListFundableProjectsQueryKey,
  getListFiscalYearEntityGoalsQueryKey,
  getGetDashboardSummaryQueryKey,
  getAdminListGoogleSyncQueryKey,
  getGetCalendarMeetingFiltersQueryKey,
} from "@workspace/api-client-react";
import type { Entity, FundableProject, FiscalYearEntityGoal, FiscalYear } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { partitionFiscalYears } from "@/lib/dropdownVisibility";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatMoney(s: string | null | undefined): string {
  if (s === null || s === undefined || s === "") return "—";
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

// Slug must be lowercase alphanumeric + underscore. Mirrors server validation
// so the user sees the error before round-tripping.
const SLUG_RE = /^[a-z0-9][a-z0-9_]*$/;

// Decimal string for the goal amount. We accept comma-formatted user input and
// strip commas before submit; the wire format is plain digits + optional
// decimal (numeric(14,2)).
const DECIMAL_INPUT_RE = /^-?\d+(\.\d{1,2})?$/;

function normalizeAmount(raw: string): string {
  return raw.replace(/[,\s$]/g, "").trim();
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Admin() {
  const entitiesQ = useListEntities({
    query: { queryKey: getListEntitiesQueryKey(), staleTime: 30_000 },
  });
  const projectsQ = useListFundableProjects({
    query: { queryKey: getListFundableProjectsQueryKey(), staleTime: 30_000 },
  });
  const fyListQ = useListFiscalYears();
  const goalsQ = useListFiscalYearEntityGoals(undefined, {
    query: { queryKey: getListFiscalYearEntityGoalsQueryKey(), staleTime: 30_000 },
  });

  const entities = entitiesQ.data ?? [];
  const projects = projectsQ.data ?? [];
  const fyList = fyListQ.data ?? [];
  const goals = goalsQ.data ?? [];

  return (
    <div className="space-y-8 max-w-6xl">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Admin</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage fund entities and per-fiscal-year goals. Retired entities stay
          in the database for historical attribution but are hidden from
          dropdowns by default across the rest of the app.
        </p>
      </div>

      <EntitiesSection entities={entities} loading={entitiesQ.isLoading} />
      <FundableProjectsSection projects={projects} loading={projectsQ.isLoading} />
      <GoalsSection entities={entities} fyList={fyList} goals={goals} loading={goalsQ.isLoading || fyListQ.isLoading} />
      <AdminSyncSection />
      <CalendarMeetingFiltersSection />
      <p className="text-xs text-muted-foreground">
        Looking to connect or disconnect your own Google account? That moved
        to <a className="underline" href="/settings">Settings</a>.
      </p>
    </div>
  );
}

// ── Admin: per-user sync health ──────────────────────────────────────────────
// Admin-only table showing every connected user's Gmail + Calendar sync
// state. The "Resync now" button calls the same workers the in-process
// scheduler does — useful when debugging a stuck mailbox without
// waiting 15 minutes for the next tick.

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const ageMs = Date.now() - d.getTime();
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function AdminSyncSection() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const q = useAdminListGoogleSync({
    query: {
      queryKey: getAdminListGoogleSyncQueryKey(),
      refetchInterval: 30_000,
    },
  });
  const resync = useAdminResyncGoogleUser({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getAdminListGoogleSyncQueryKey() });
        toast({ title: "Resync triggered" });
      },
      onError: (e: unknown) => {
        toast({
          title: "Resync failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  // 403 for non-admins: hide the whole card so the page doesn't render
  // a permanent error message for regular staff visiting their own
  // /admin page (Connect Gmail still works for everyone).
  const errStatus = (q.error as unknown as { status?: number } | null)?.status;
  if (errStatus === 403) return null;

  const rows = q.data?.data ?? [];

  return (
    <Card data-testid="admin-sync-section">
      <CardHeader>
        <CardTitle>Google sync health</CardTitle>
        <CardDescription>
          Per-user Gmail + Calendar sync status. The scheduler runs every
          15 minutes per connected user, jittered to spread load. Use
          "Resync now" to kick a specific user immediately.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No staff have connected their Google account yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Gmail</TableHead>
                <TableHead>Calendar</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.userId} data-testid={`sync-row-${r.userId}`}>
                  <TableCell>
                    <div className="font-medium">{r.userEmail}</div>
                    {r.googleEmail && r.googleEmail !== r.userEmail ? (
                      <div className="text-xs text-muted-foreground">
                        as {r.googleEmail}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {r.connected ? (
                      <span className="text-emerald-700 text-sm">Connected</span>
                    ) : (
                      <span className="text-muted-foreground text-sm">
                        Revoked {fmtTime(r.revokedAt)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    <div>{fmtTime(r.gmail.lastSyncedAt)}</div>
                    {r.gmail.bootstrapInProgress ? (
                      <div className="text-xs text-amber-700">
                        Initial sync in progress
                      </div>
                    ) : null}
                    {r.gmail.lastError ? (
                      <div className="text-xs text-destructive truncate max-w-xs" title={r.gmail.lastError}>
                        {r.gmail.lastError}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm">
                    <div>{fmtTime(r.calendar.lastSyncedAt)}</div>
                    {r.calendar.bootstrapInProgress ? (
                      <div className="text-xs text-amber-700">
                        Initial sync in progress
                      </div>
                    ) : null}
                    {r.calendar.lastError ? (
                      <div className="text-xs text-destructive truncate max-w-xs" title={r.calendar.lastError}>
                        {r.calendar.lastError}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!r.connected || resync.isPending}
                      onClick={() => resync.mutate({ id: r.userId })}
                      data-testid={`resync-${r.userId}`}
                    >
                      Resync now
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ── Google connection ────────────────────────────────────────────────────────
// (Moved to /settings as a per-user preference. Admin only retains the
// sync-health table below, which is admin-only.)

// ── Entities section ─────────────────────────────────────────────────────────

function EntitiesSection({ entities, loading }: { entities: Entity[]; loading: boolean }) {
  return (
    <Card data-testid="admin-entities-section">
      <CardHeader>
        <CardTitle>Entities</CardTitle>
        <CardDescription>
          Add new fund entities or mark existing ones as retired. The id is a
          permanent slug used in URLs and reports — pick carefully and use
          lowercase letters, digits, and underscores only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <NewEntityForm />
        <EntitiesTable entities={entities} loading={loading} />
      </CardContent>
    </Card>
  );
}

function NewEntityForm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [active, setActive] = useState(true);

  const create = useCreateEntity({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListEntitiesQueryKey() });
        toast({ title: "Entity created" });
        setId("");
        setName("");
        setActive(true);
      },
      onError: (err: unknown) => {
        toast({
          title: "Create failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const idError = id !== "" && !SLUG_RE.test(id)
    ? "Use lowercase letters, digits, and underscores only."
    : null;
  const canSubmit = id.trim() !== "" && name.trim() !== "" && !idError && !create.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    create.mutate({ data: { id: id.trim(), name: name.trim(), active } });
  };

  return (
    <form onSubmit={submit} className="space-y-3" data-testid="new-entity-form">
      <h3 className="text-sm font-semibold">Add entity</h3>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-3 items-end">
        <div className="space-y-1">
          <Label htmlFor="new-entity-id">Id (slug)</Label>
          <Input
            id="new-entity-id"
            data-testid="new-entity-id"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. new_fund"
            autoComplete="off"
          />
          {idError ? <p className="text-xs text-destructive">{idError}</p> : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor="new-entity-name">Name</Label>
          <Input
            id="new-entity-name"
            data-testid="new-entity-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            autoComplete="off"
          />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch
            id="new-entity-active"
            data-testid="new-entity-active"
            checked={active}
            onCheckedChange={setActive}
          />
          <Label htmlFor="new-entity-active" className="cursor-pointer">
            Active
          </Label>
        </div>
        <Button type="submit" disabled={!canSubmit} data-testid="new-entity-submit">
          {create.isPending ? "Adding…" : "Add entity"}
        </Button>
      </div>
    </form>
  );
}

function EntitiesTable({ entities, loading }: { entities: Entity[]; loading: boolean }) {
  // Active first, then retired, alphabetical within each.
  const sorted = useMemo(() => {
    const copy = [...entities];
    copy.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [entities]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading entities…</p>;
  }
  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground">No entities yet.</p>;
  }

  return (
    <Table data-testid="entities-table">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[28%]">Id</TableHead>
          <TableHead>Name</TableHead>
          <TableHead className="w-[140px] text-right">Active</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((e) => (
          <EntityRow key={e.id} entity={e} />
        ))}
      </TableBody>
    </Table>
  );
}

function EntityRow({ entity }: { entity: Entity }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(entity.name);

  const update = useUpdateEntity({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getListEntitiesQueryKey() }),
          // Dashboard tiles + retired/active partitioning derive from this list.
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }),
        ]);
        toast({ title: "Entity updated" });
        setEditingName(false);
      },
      onError: (err: unknown) => {
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed === "" || trimmed === entity.name) {
      setNameDraft(entity.name);
      setEditingName(false);
      return;
    }
    update.mutate({ id: entity.id, data: { name: trimmed } });
  };

  const toggleActive = (next: boolean) => {
    update.mutate({ id: entity.id, data: { active: next } });
  };

  return (
    <TableRow data-testid={`entity-row-${entity.id}`}>
      <TableCell className="font-mono text-xs text-muted-foreground">{entity.id}</TableCell>
      <TableCell>
        {editingName ? (
          <Input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") {
                setNameDraft(entity.name);
                setEditingName(false);
              }
            }}
            data-testid={`entity-name-input-${entity.id}`}
            className="h-8"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setNameDraft(entity.name);
              setEditingName(true);
            }}
            className="text-left hover:underline underline-offset-2"
            data-testid={`entity-name-${entity.id}`}
          >
            {entity.name}
          </button>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-2">
          <span className={`text-xs ${entity.active ? "text-muted-foreground" : "text-amber-700 font-medium"}`}>
            {entity.active ? "Active" : "Retired"}
          </span>
          <Switch
            checked={entity.active}
            onCheckedChange={toggleActive}
            disabled={update.isPending}
            data-testid={`entity-active-${entity.id}`}
            aria-label={entity.active ? "Mark retired" : "Mark active"}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

// ── Fundable projects section ────────────────────────────────────────────────

function FundableProjectsSection({ projects, loading }: { projects: FundableProject[]; loading: boolean }) {
  return (
    <Card data-testid="admin-fundable-projects-section">
      <CardHeader>
        <CardTitle>Fundable projects</CardTitle>
        <CardDescription>
          Add new fundable projects (e.g. SSJ, MDD, Charter Growth) or mark
          existing ones as retired. The id is a permanent slug saved on gift and
          pledge allocations — pick carefully and use lowercase letters, digits,
          and underscores only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <NewFundableProjectForm />
        <FundableProjectsTable projects={projects} loading={loading} />
      </CardContent>
    </Card>
  );
}

function NewFundableProjectForm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [active, setActive] = useState(true);

  const create = useCreateFundableProject({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListFundableProjectsQueryKey() });
        toast({ title: "Fundable project created" });
        setId("");
        setName("");
        setActive(true);
      },
      onError: (err: unknown) => {
        toast({
          title: "Create failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const idError = id !== "" && !SLUG_RE.test(id)
    ? "Use lowercase letters, digits, and underscores only."
    : null;
  const canSubmit = id.trim() !== "" && name.trim() !== "" && !idError && !create.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    create.mutate({ data: { id: id.trim(), name: name.trim(), active } });
  };

  return (
    <form onSubmit={submit} className="space-y-3" data-testid="new-fundable-project-form">
      <h3 className="text-sm font-semibold">Add fundable project</h3>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-3 items-end">
        <div className="space-y-1">
          <Label htmlFor="new-fundable-project-id">Id (slug)</Label>
          <Input
            id="new-fundable-project-id"
            data-testid="new-fundable-project-id"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. charter_growth"
            autoComplete="off"
          />
          {idError ? <p className="text-xs text-destructive">{idError}</p> : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor="new-fundable-project-name">Name</Label>
          <Input
            id="new-fundable-project-name"
            data-testid="new-fundable-project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            autoComplete="off"
          />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch
            id="new-fundable-project-active"
            data-testid="new-fundable-project-active"
            checked={active}
            onCheckedChange={setActive}
          />
          <Label htmlFor="new-fundable-project-active" className="cursor-pointer">
            Active
          </Label>
        </div>
        <Button type="submit" disabled={!canSubmit} data-testid="new-fundable-project-submit">
          {create.isPending ? "Adding…" : "Add project"}
        </Button>
      </div>
    </form>
  );
}

function FundableProjectsTable({ projects, loading }: { projects: FundableProject[]; loading: boolean }) {
  // Active first, then retired, alphabetical within each.
  const sorted = useMemo(() => {
    const copy = [...projects];
    copy.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [projects]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading fundable projects…</p>;
  }
  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground">No fundable projects yet.</p>;
  }

  return (
    <Table data-testid="fundable-projects-table">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[28%]">Id</TableHead>
          <TableHead>Name</TableHead>
          <TableHead className="w-[140px] text-right">Active</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((p) => (
          <FundableProjectRow key={p.id} project={p} />
        ))}
      </TableBody>
    </Table>
  );
}

function FundableProjectRow({ project }: { project: FundableProject }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(project.name);

  const update = useUpdateFundableProject({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListFundableProjectsQueryKey() });
        toast({ title: "Fundable project updated" });
        setEditingName(false);
      },
      onError: (err: unknown) => {
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed === "" || trimmed === project.name) {
      setNameDraft(project.name);
      setEditingName(false);
      return;
    }
    update.mutate({ id: project.id, data: { name: trimmed } });
  };

  const toggleActive = (next: boolean) => {
    update.mutate({ id: project.id, data: { active: next } });
  };

  return (
    <TableRow data-testid={`fundable-project-row-${project.id}`}>
      <TableCell className="font-mono text-xs text-muted-foreground">{project.id}</TableCell>
      <TableCell>
        {editingName ? (
          <Input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") {
                setNameDraft(project.name);
                setEditingName(false);
              }
            }}
            data-testid={`fundable-project-name-input-${project.id}`}
            className="h-8"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setNameDraft(project.name);
              setEditingName(true);
            }}
            className="text-left hover:underline underline-offset-2"
            data-testid={`fundable-project-name-${project.id}`}
          >
            {project.name}
          </button>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-2">
          <span className={`text-xs ${project.active ? "text-muted-foreground" : "text-amber-700 font-medium"}`}>
            {project.active ? "Active" : "Retired"}
          </span>
          <Switch
            checked={project.active}
            onCheckedChange={toggleActive}
            disabled={update.isPending}
            data-testid={`fundable-project-active-${project.id}`}
            aria-label={project.active ? "Mark retired" : "Mark active"}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

// ── Goals section ────────────────────────────────────────────────────────────

function GoalsSection({
  entities,
  fyList,
  goals,
  loading,
}: {
  entities: Entity[];
  fyList: FiscalYear[];
  goals: FiscalYearEntityGoal[];
  loading: boolean;
}) {
  const [showAllFy, setShowAllFy] = useState(false);
  const [showRetired, setShowRetired] = useState(false);

  // FY list newest-first; partition by recent vs older for the toggle.
  const sortedFy = useMemo(() => {
    const copy = [...fyList];
    copy.sort((a, b) => b.id.localeCompare(a.id));
    return copy;
  }, [fyList]);
  const { recent: recentFy, older: olderFy } = useMemo(
    () => partitionFiscalYears(sortedFy),
    [sortedFy],
  );
  const visibleFy = showAllFy ? sortedFy : recentFy;

  // Entities: active first, then retired (if shown).
  const sortedEntities = useMemo(() => {
    const copy = [...entities];
    copy.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [entities]);
  const activeEntities = sortedEntities.filter((e) => e.active);
  const retiredEntities = sortedEntities.filter((e) => !e.active);
  const visibleEntities = showRetired ? sortedEntities : activeEntities;

  // Build (fyId, entityId) -> goalAmount map for O(1) lookup.
  const goalMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of goals) m.set(`${g.fiscalYearId}|${g.entityId}`, g.goalAmount);
    return m;
  }, [goals]);

  return (
    <Card data-testid="admin-goals-section">
      <CardHeader>
        <CardTitle>Fundraising goals</CardTitle>
        <CardDescription>
          Per-fiscal-year goal for each entity. Click a cell to edit. Leave
          blank to clear. The dashboard "Goal" tile sums whatever is set for
          the current fiscal year and the entities in scope.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3 text-xs">
          {olderFy.length > 0 ? (
            <button
              type="button"
              data-testid="goals-toggle-fy"
              onClick={() => setShowAllFy((s) => !s)}
              className="text-muted-foreground hover:text-foreground hover:underline underline-offset-2"
            >
              {showAllFy ? "Show recent fiscal years only" : `Show all fiscal years (+${olderFy.length})`}
            </button>
          ) : null}
          {retiredEntities.length > 0 ? (
            <button
              type="button"
              data-testid="goals-toggle-retired"
              onClick={() => setShowRetired((s) => !s)}
              className="text-muted-foreground hover:text-foreground hover:underline underline-offset-2"
            >
              {showRetired ? "Hide retired entities" : `Show retired entities (+${retiredEntities.length})`}
            </button>
          ) : null}
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading goals…</p>
        ) : visibleEntities.length === 0 || visibleFy.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add at least one entity and one fiscal year to start setting goals.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="goals-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px] sticky left-0 bg-background">Fiscal year</TableHead>
                  {visibleEntities.map((e) => (
                    <TableHead key={e.id} className="text-right whitespace-nowrap">
                      {e.name}
                      {!e.active ? <span className="ml-1 text-[10px] text-amber-700">(retired)</span> : null}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleFy.map((fy) => (
                  <TableRow key={fy.id} data-testid={`goal-row-${fy.id}`}>
                    <TableCell className="font-medium sticky left-0 bg-background">{fy.label}</TableCell>
                    {visibleEntities.map((e) => (
                      <TableCell key={e.id} className="text-right">
                        <GoalCell
                          fyId={fy.id}
                          entityId={e.id}
                          current={goalMap.get(`${fy.id}|${e.id}`) ?? null}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GoalCell({
  fyId,
  entityId,
  current,
}: {
  fyId: string;
  entityId: string;
  current: string | null;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current ?? "");

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListFiscalYearEntityGoalsQueryKey() }),
      // Dashboard goal tile + per-FY projection are derived from this.
      queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }),
    ]);
  };

  const upsert = useUpsertFiscalYearEntityGoal({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Goal saved" });
        setEditing(false);
      },
      onError: (err: unknown) => {
        toast({
          title: "Save failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const del = useDeleteFiscalYearEntityGoal({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Goal cleared" });
        setEditing(false);
      },
      onError: (err: unknown) => {
        toast({
          title: "Clear failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const commit = () => {
    const cleaned = normalizeAmount(draft);
    if (cleaned === "") {
      // Empty = clear the goal. Only call DELETE if there's currently a row.
      if (current !== null) {
        del.mutate({ fyId, entityId });
      } else {
        setEditing(false);
      }
      return;
    }
    if (!DECIMAL_INPUT_RE.test(cleaned)) {
      toast({
        title: "Invalid amount",
        description: "Enter a number like 4000000 or 1,000,000. Up to 2 decimal places.",
        variant: "destructive",
      });
      return;
    }
    if (cleaned === current) {
      setEditing(false);
      return;
    }
    upsert.mutate({ fyId, entityId, data: { goalAmount: cleaned } });
  };

  const busy = upsert.isPending || del.isPending;
  const testId = `goal-cell-${fyId}-${entityId}`;

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(current ?? "");
            setEditing(false);
          }
        }}
        disabled={busy}
        data-testid={`${testId}-input`}
        className="h-8 text-right tabular-nums"
        placeholder="0"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(current ?? "");
        setEditing(true);
      }}
      className={`text-right tabular-nums hover:underline underline-offset-2 ${
        current === null ? "text-muted-foreground" : ""
      }`}
      data-testid={testId}
    >
      {formatMoney(current)}
    </button>
  );
}

// ── Calendar meeting-filter config ───────────────────────────────────────────

function CalendarMeetingFiltersSection() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const q = useGetCalendarMeetingFilters({
    query: { queryKey: getGetCalendarMeetingFiltersQueryKey(), staleTime: 60_000 },
  });

  const [editing, setEditing] = useState(false);
  const [patternsDraft, setPatternsDraft] = useState("");
  const [cutoffDraft, setCutoffDraft] = useState("");

  const current = q.data;

  const update = useUpdateCalendarMeetingFilters({
    mutation: {
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: getGetCalendarMeetingFiltersQueryKey() });
        toast({ title: "Meeting filter config saved" });
        setEditing(false);
      },
      onError: (err: unknown) => {
        toast({
          title: "Save failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const startEdit = () => {
    if (!current) return;
    setPatternsDraft((current.titlePatterns ?? []).join("\n"));
    setCutoffDraft(String(current.attendeeCountCutoff ?? 20));
    setEditing(true);
  };

  const commit = () => {
    const patterns = patternsDraft
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const cutoffNum = parseInt(cutoffDraft, 10);
    if (!Number.isFinite(cutoffNum) || cutoffNum < 2) {
      toast({
        title: "Invalid cutoff",
        description: "Attendee cutoff must be a whole number ≥ 2.",
        variant: "destructive",
      });
      return;
    }
    update.mutate({ data: { titlePatterns: patterns, attendeeCountCutoff: cutoffNum } });
  };

  // 403 → non-admin; hide the card
  const errStatus = (q.error as unknown as { status?: number } | null)?.status;
  if (errStatus === 403) return null;

  return (
    <Card data-testid="admin-meeting-filters-section">
      <CardHeader>
        <CardTitle>Group-meeting suppression</CardTitle>
        <CardDescription>
          Calendar events matching these title keywords, or with ≥ the attendee
          cutoff, are skipped during calendar sync — they won't appear on donor
          timelines.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : editing ? (
          <div className="space-y-4">
            <div>
              <Label htmlFor="title-patterns">
                Title keywords (one per line, case-insensitive substring match)
              </Label>
              <textarea
                id="title-patterns"
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[140px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={patternsDraft}
                onChange={(e) => setPatternsDraft(e.target.value)}
                placeholder={"all hands\nstaff meeting\nboard meeting"}
              />
            </div>
            <div>
              <Label htmlFor="attendee-cutoff">Attendee count cutoff (≥ this → suppressed)</Label>
              <Input
                id="attendee-cutoff"
                className="mt-1 w-32"
                type="number"
                min={2}
                value={cutoffDraft}
                onChange={(e) => setCutoffDraft(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={commit} disabled={update.isPending}>
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing(false)}
                disabled={update.isPending}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Title keywords
              </div>
              {(current?.titlePatterns ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">None configured.</p>
              ) : (
                <ul className="text-sm space-y-0.5">
                  {(current?.titlePatterns ?? []).map((p) => (
                    <li key={p} className="font-mono bg-muted rounded px-2 py-0.5 inline-block mr-1 mb-1">
                      {p}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <span className="text-xs font-medium text-muted-foreground">Attendee cutoff: </span>
              <span className="text-sm">{current?.attendeeCountCutoff ?? "—"}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Last updated:{" "}
              {current?.updatedAt
                ? new Date(current.updatedAt).toLocaleString()
                : "never"}
            </div>
            <Button size="sm" variant="outline" onClick={startEdit}>
              Edit
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
