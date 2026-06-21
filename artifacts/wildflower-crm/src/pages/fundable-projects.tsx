import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFundableProjects,
  useCreateFundableProject,
  useUpdateFundableProject,
  useArchiveFundableProject,
  useUnarchiveFundableProject,
  useGetFundableProjectsProgress,
  getListFundableProjectsQueryKey,
  getGetFundableProjectsProgressQueryKey,
} from "@workspace/api-client-react";
import type {
  FundableProject,
  ListFundableProjectsParams,
} from "@workspace/api-client-react";
import { RowActionIcons } from "@/components/row-action-icons";
import { ShowArchivedToggle } from "@/components/show-archived-toggle";
import { ListPageHeader } from "@/components/list-page-header";
import { AddIconButton } from "@/components/add-icon-button";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

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

function formatDate(s: string | null | undefined): string {
  if (!s) return "—";
  // Date-only strings (YYYY-MM-DD) — parse as UTC noon to avoid tz day-shift.
  const d = new Date(`${s}T12:00:00`);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// "start – end", with an open-ended end shown as "ongoing" and a fully-missing
// timeframe shown as a dash.
function formatTimeframe(start: string | null | undefined, end: string | null | undefined): string {
  if (!start && !end) return "—";
  const startLabel = start ? formatDate(start) : "—";
  const endLabel = end ? formatDate(end) : "ongoing";
  return `${startLabel} – ${endLabel}`;
}

// Slug must be lowercase alphanumeric + underscore. Mirrors server validation.
const SLUG_RE = /^[a-z0-9][a-z0-9_]*$/;

// Decimal string for the goal amount. Accept comma-formatted input; strip
// before submit. Wire format is plain digits + optional decimal (numeric(14,2)).
const DECIMAL_INPUT_RE = /^\d+(\.\d{1,2})?$/;

function normalizeAmount(raw: string): string {
  return raw.replace(/[,\s$]/g, "").trim();
}

// "" → null (so we send SQL NULL, not an invalid empty date string).
function blankToNull(s: string): string | null {
  return s.trim() === "" ? null : s.trim();
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function FundableProjects() {
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showArchived, setShowArchived] = usePersistedState<boolean>(
    "wf.list.fundable-projects.showArchived",
    false,
  );
  // Retired (active === false) projects are hidden by default for everyone;
  // this toggle reveals them. Distinct from the admin-only "show archived".
  const [showRetired, setShowRetired] = usePersistedState<boolean>(
    "wf.list.fundable-projects.showRetired",
    false,
  );

  const listParams: ListFundableProjectsParams | undefined =
    isAdmin && showArchived ? { includeArchived: true } : undefined;
  const projectsQ = useListFundableProjects(listParams, {
    query: {
      queryKey: getListFundableProjectsQueryKey(listParams),
      staleTime: 30_000,
    },
  });
  const progressQ = useGetFundableProjectsProgress({
    query: { queryKey: getGetFundableProjectsProgressQueryKey(), staleTime: 30_000 },
  });

  const projects = projectsQ.data ?? [];
  const progress = progressQ.data ?? [];

  const archiveMut = useArchiveFundableProject();
  const unarchiveMut = useUnarchiveFundableProject();

  // Invalidate the base list key (no params) so both the active-only and
  // include-archived variants refetch after an archive/unarchive.
  const refreshList = () =>
    queryClient.invalidateQueries({
      queryKey: getListFundableProjectsQueryKey(),
    });

  const archiveProject = (p: FundableProject) =>
    archiveMut.mutate(
      { id: p.id },
      {
        onSuccess: async () => {
          await refreshList();
          toast({ title: "Project archived" });
        },
        onError: (err: unknown) =>
          toast({
            title: "Archive failed",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );

  const unarchiveProject = (p: FundableProject) =>
    unarchiveMut.mutate(
      { id: p.id },
      {
        onSuccess: async () => {
          await refreshList();
          toast({ title: "Project unarchived" });
        },
        onError: (err: unknown) =>
          toast({
            title: "Unarchive failed",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );

  const raisedMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of progress) m.set(p.fundableProjectId, p.raised);
    return m;
  }, [progress]);

  // Hide retired (active === false) projects unless the toggle is on. Archived
  // rows stay governed solely by the admin "show archived" control.
  const visible = useMemo(
    () => (showRetired ? projects : projects.filter((p) => p.active || p.archivedAt)),
    [projects, showRetired],
  );

  // Active first, then retired, then archived, alphabetical within each group.
  const sorted = useMemo(() => {
    const copy = [...visible];
    copy.sort((a, b) => {
      const aArch = a.archivedAt ? 1 : 0;
      const bArch = b.archivedAt ? 1 : 0;
      if (aArch !== bArch) return aArch - bArch;
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [visible]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FundableProject | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (project: FundableProject) => {
    setEditing(project);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-8 max-w-6xl">
      <ListPageHeader
        title="Fundable projects"
        subtitle={
          <>
            Plan and track each fundable project (e.g. SSJ, MDD, Charter Growth):
            fundraising &amp; spending timeframes, a fundraising goal, and progress
            toward that goal. The id is a permanent slug saved on gift and pledge
            allocations — pick it carefully.
          </>
        }
        addAction={
          <AddIconButton
            label="Add project"
            onClick={openCreate}
            data-testid="add-fundable-project"
          />
        }
        controls={
          <>
            <div className="flex items-center gap-2">
              <Switch
                id="toggle-show-retired-fundable-projects"
                checked={showRetired}
                onCheckedChange={setShowRetired}
                data-testid="toggle-show-retired-fundable-projects"
              />
              <Label
                htmlFor="toggle-show-retired-fundable-projects"
                className="cursor-pointer text-sm text-muted-foreground"
              >
                Show retired
              </Label>
            </div>
            <ShowArchivedToggle
              value={showArchived}
              onChange={setShowArchived}
              testId="toggle-show-archived-fundable-projects"
            />
          </>
        }
      />

      <Card data-testid="fundable-projects-card">
        <CardHeader>
          <CardTitle>All projects</CardTitle>
          <CardDescription>
            Click a project to edit its details. Retired projects stay for
            historical attribution but are sorted to the bottom.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProjectsTable
            projects={sorted}
            raisedMap={raisedMap}
            loading={projectsQ.isLoading}
            isAdmin={isAdmin}
            onEdit={openEdit}
            onArchive={archiveProject}
            onUnarchive={unarchiveProject}
          />
        </CardContent>
      </Card>

      <FundableProjectFormDialog
        key={editing ? `edit-${editing.id}` : "create"}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        project={editing}
      />
    </div>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────

function ProjectsTable({
  projects,
  raisedMap,
  loading,
  isAdmin,
  onEdit,
  onArchive,
  onUnarchive,
}: {
  projects: FundableProject[];
  raisedMap: Map<string, string>;
  loading: boolean;
  isAdmin: boolean;
  onEdit: (project: FundableProject) => void;
  onArchive: (project: FundableProject) => void;
  onUnarchive: (project: FundableProject) => void;
}) {
  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading fundable projects…</p>;
  }
  if (projects.length === 0) {
    return <p className="text-sm text-muted-foreground">No fundable projects yet. Add one to get started.</p>;
  }

  return (
    <Table data-testid="fundable-projects-table">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Fundraising</TableHead>
          <TableHead>Spending</TableHead>
          <TableHead className="text-right">Goal</TableHead>
          <TableHead className="w-[220px]">Progress</TableHead>
          <TableHead className="w-[80px] text-right">Status</TableHead>
          <TableHead className="w-[100px] text-right">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {projects.map((p) => (
          <ProjectRow
            key={p.id}
            project={p}
            raised={raisedMap.get(p.id) ?? "0"}
            isAdmin={isAdmin}
            onEdit={onEdit}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function ProjectRow({
  project,
  raised,
  isAdmin,
  onEdit,
  onArchive,
  onUnarchive,
}: {
  project: FundableProject;
  raised: string;
  isAdmin: boolean;
  onEdit: (project: FundableProject) => void;
  onArchive: (project: FundableProject) => void;
  onUnarchive: (project: FundableProject) => void;
}) {
  const goal = project.fundraisingGoal;
  const goalNum = goal ? Number(goal) : 0;
  const raisedNum = Number(raised) || 0;
  const pct = goalNum > 0 ? Math.round((raisedNum / goalNum) * 100) : 0;
  const needsSetup = !project.fundraisingStart || !project.fundraisingGoal;

  return (
    <TableRow data-testid={`fundable-project-row-${project.id}`}>
      <TableCell>
        <button
          type="button"
          onClick={() => onEdit(project)}
          className="text-left font-medium hover:underline underline-offset-2"
          data-testid={`fundable-project-name-${project.id}`}
        >
          {project.name}
        </button>
        <div className="font-mono text-xs text-muted-foreground">{project.id}</div>
        {needsSetup ? (
          <Badge variant="outline" className="mt-1 border-amber-300 text-amber-700">
            Needs setup
          </Badge>
        ) : null}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
        {formatTimeframe(project.fundraisingStart, project.fundraisingEnd)}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
        {formatTimeframe(project.spendingStart, project.spendingEnd)}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatMoney(goal)}</TableCell>
      <TableCell>
        {goalNum > 0 ? (
          <div className="space-y-1" data-testid={`fundable-project-progress-${project.id}`}>
            <Progress value={Math.min(pct, 100)} />
            <div className="text-xs text-muted-foreground">
              {formatMoney(raised)} of {formatMoney(goal)}, {pct}%
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            {raisedNum > 0 ? `${formatMoney(raised)} raised (no goal set)` : "No goal set"}
          </div>
        )}
      </TableCell>
      <TableCell className="text-right">
        {project.archivedAt ? (
          <span className="text-xs text-destructive font-medium">Archived</span>
        ) : (
          <span className={`text-xs ${project.active ? "text-muted-foreground" : "text-amber-700 font-medium"}`}>
            {project.active ? "Active" : "Retired"}
          </span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <RowActionIcons
          entityLabel={project.name}
          testIdPrefix={`fundable-project-${project.id}`}
          archived={!!project.archivedAt}
          onEdit={() => onEdit(project)}
          onArchive={
            project.archivedAt
              ? isAdmin
                ? () => onUnarchive(project)
                : undefined
              : () => onArchive(project)
          }
        />
      </TableCell>
    </TableRow>
  );
}

// ── Create / edit dialog ─────────────────────────────────────────────────────

function FundableProjectFormDialog({
  open,
  onOpenChange,
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: FundableProject | null;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isEdit = project !== null;

  const [id, setId] = useState(project?.id ?? "");
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [active, setActive] = useState(project?.active ?? true);
  const [fundraisingStart, setFundraisingStart] = useState(project?.fundraisingStart ?? "");
  const [fundraisingEnd, setFundraisingEnd] = useState(project?.fundraisingEnd ?? "");
  const [spendingStart, setSpendingStart] = useState(project?.spendingStart ?? "");
  const [spendingEnd, setSpendingEnd] = useState(project?.spendingEnd ?? "");
  const [goal, setGoal] = useState(project?.fundraisingGoal ?? "");

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: getListFundableProjectsQueryKey() });
    await queryClient.invalidateQueries({ queryKey: getGetFundableProjectsProgressQueryKey() });
  };

  const create = useCreateFundableProject({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Fundable project created" });
        onOpenChange(false);
      },
      onError: (err: unknown) =>
        toast({
          title: "Create failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  const update = useUpdateFundableProject({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Fundable project updated" });
        onOpenChange(false);
      },
      onError: (err: unknown) =>
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  const idError = !isEdit && id !== "" && !SLUG_RE.test(id)
    ? "Use lowercase letters, digits, and underscores only."
    : null;
  const normalizedGoal = normalizeAmount(goal);
  const goalError = normalizedGoal !== "" && !DECIMAL_INPUT_RE.test(normalizedGoal)
    ? "Enter a dollar amount (digits, optional cents)."
    : null;

  const pending = create.isPending || update.isPending;
  const canSubmit =
    name.trim() !== "" &&
    !goalError &&
    (isEdit || (id.trim() !== "" && !idError)) &&
    !pending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const shared = {
      name: name.trim(),
      description: description.trim() === "" ? null : description.trim(),
      active,
      fundraisingStart: blankToNull(fundraisingStart),
      fundraisingEnd: blankToNull(fundraisingEnd),
      spendingStart: blankToNull(spendingStart),
      spendingEnd: blankToNull(spendingEnd),
      fundraisingGoal: normalizedGoal === "" ? null : normalizedGoal,
    };
    if (isEdit) {
      update.mutate({ id: project.id, data: shared });
    } else {
      create.mutate({ data: { id: id.trim(), ...shared } });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="fundable-project-dialog">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${project.name}` : "Add fundable project"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this project's details, timeframes, and fundraising goal."
              : "Create a new fundable project. The id is a permanent slug used on allocations."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4" data-testid="fundable-project-form">
          {isEdit ? null : (
            <div className="space-y-1">
              <Label htmlFor="fp-id">Id (slug)</Label>
              <Input
                id="fp-id"
                data-testid="fp-id"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="e.g. charter_growth"
                autoComplete="off"
              />
              {idError ? <p className="text-xs text-destructive">{idError}</p> : null}
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="fp-name">Name</Label>
            <Input
              id="fp-name"
              data-testid="fp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name"
              autoComplete="off"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="fp-description">Description</Label>
            <Textarea
              id="fp-description"
              data-testid="fp-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="fp-fundraising-start">Fundraising start</Label>
              <Input
                id="fp-fundraising-start"
                data-testid="fp-fundraising-start"
                type="date"
                value={fundraisingStart}
                onChange={(e) => setFundraisingStart(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fp-fundraising-end">Fundraising end</Label>
              <Input
                id="fp-fundraising-end"
                data-testid="fp-fundraising-end"
                type="date"
                value={fundraisingEnd}
                onChange={(e) => setFundraisingEnd(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fp-spending-start">Spending start</Label>
              <Input
                id="fp-spending-start"
                data-testid="fp-spending-start"
                type="date"
                value={spendingStart}
                onChange={(e) => setSpendingStart(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fp-spending-end">Spending end</Label>
              <Input
                id="fp-spending-end"
                data-testid="fp-spending-end"
                type="date"
                value={spendingEnd}
                onChange={(e) => setSpendingEnd(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="fp-goal">Fundraising goal</Label>
            <Input
              id="fp-goal"
              data-testid="fp-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="e.g. 500000"
              inputMode="decimal"
              autoComplete="off"
            />
            {goalError ? <p className="text-xs text-destructive">{goalError}</p> : null}
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="fp-active"
              data-testid="fp-active"
              checked={active}
              onCheckedChange={setActive}
            />
            <Label htmlFor="fp-active" className="cursor-pointer">
              {active ? "Active" : "Retired"}
            </Label>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} data-testid="fp-submit">
              {pending ? "Saving…" : isEdit ? "Save changes" : "Add project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
