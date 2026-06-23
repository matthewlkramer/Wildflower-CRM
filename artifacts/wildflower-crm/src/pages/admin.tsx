import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListEntities,
  useCreateEntity,
  useUpdateEntity,
  useListFiscalYears,
  useListFiscalYearEntityGoals,
  useUpsertFiscalYearEntityGoal,
  useDeleteFiscalYearEntityGoal,
  useAdminListGoogleSync,
  useAdminResyncGoogleUser,
  useAdminGetSchoolSyncStatus,
  useAdminRunSchoolSync,
  getAdminGetSchoolSyncStatusQueryKey,
  useGetCalendarMeetingFilters,
  useUpdateCalendarMeetingFilters,
  useGetInternalEmailDomains,
  useUpdateInternalEmailDomains,
  useAdminListEmailIntelPrompts,
  useAdminSaveEmailIntelPrompt,
  useAdminGenerateEmailIntelPrompt,
  useAdminActivateEmailIntelPrompt,
  useAdminRevertEmailIntelPrompt,
  useAdminDiscardEmailIntelPrompt,
  useAdminListEmailIntelFeedback,
  useAdminListQuickbooksRules,
  useAdminCreateQuickbooksRule,
  useAdminUpdateQuickbooksRule,
  useAdminReorderQuickbooksRules,
  useAdminDeleteQuickbooksRule,
  useAdminApplyQuickbooksRuleToPending,
  useAdminListEntityCodingRules,
  useAdminCreateEntityCodingRule,
  useAdminUpdateEntityCodingRule,
  useAdminDeleteEntityCodingRule,
  useListFundableProjects,
  useListUsers,
  useGetOwnedRecordCounts,
  useReassignOwner,
  getListUsersQueryKey,
  getGetOwnedRecordCountsQueryKey,
  getAdminListEntityCodingRulesQueryKey,
  getListEntitiesQueryKey,
  getListFiscalYearEntityGoalsQueryKey,
  getGetDashboardSummaryQueryKey,
  getAdminListGoogleSyncQueryKey,
  getGetCalendarMeetingFiltersQueryKey,
  getGetInternalEmailDomainsQueryKey,
  getAdminListEmailIntelPromptsQueryKey,
  getAdminListEmailIntelFeedbackQueryKey,
  getAdminListQuickbooksRulesQueryKey,
  getListFundableProjectsQueryKey,
} from "@workspace/api-client-react";
import type {
  Entity,
  FiscalYearEntityGoal,
  FundraisingCategory,
  FiscalYear,
  EmailIntelPrompt,
  EmailProposalKind,
  EmailProposalStatus,
  QuickbooksHandlingRule,
  QuickbooksRuleAction,
  QuickbooksRuleCondition,
  QuickbooksRuleConditionField,
  QuickbooksRuleConditionMode,
  QuickbooksRuleMatchLogic,
  StagedPaymentExclusionReason,
  IntendedUsage,
  CreateQuickbooksRuleBody,
  ApplyRuleToPendingResult,
  EntityCodingRule,
  CreateEntityCodingRuleBody,
} from "@workspace/api-client-react";
import { LOCATIONS } from "@workspace/api-zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EntityCombobox,
  useOrganizationSearch,
  useOrganizationName,
} from "@/components/entity-picker";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { userDisplayName, hasUsableIdentity } from "@/components/user-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { formatEnum } from "@/lib/format";

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
  const fyListQ = useListFiscalYears();
  const goalsQ = useListFiscalYearEntityGoals(undefined, {
    query: { queryKey: getListFiscalYearEntityGoalsQueryKey(), staleTime: 30_000 },
  });

  const entities = entitiesQ.data ?? [];
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
      <GoalsSection entities={entities} fyList={fyList} goals={goals} loading={goalsQ.isLoading || fyListQ.isLoading} />
      <AdminSyncSection />
      <SchoolSyncSection />
      <CalendarMeetingFiltersSection />
      <InternalEmailDomainsSection />
      <QuickbooksRulesSection />
      <EntityCodingRulesSection entities={entities} />
      <ReassignOwnerSection />
      <EmailIntelligenceSection />
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
  const stuckRows = rows.filter(
    (r) =>
      r.gmail.stuck ||
      r.gmail.bootstrapStuck ||
      r.calendar.bootstrapStuck,
  );

  return (
    <Card data-testid="admin-sync-section">
      <CardHeader>
        <CardTitle>Google sync health</CardTitle>
        <CardDescription>
          Per-user Gmail + Calendar sync status. The scheduler runs every
          15 minutes per connected user, jittered to spread load. Use
          "Sync now" to run an incremental sync immediately — or to resume
          an initial sync that hasn't finished.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {stuckRows.length > 0 ? (
          <div
            className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="sync-stuck-banner"
          >
            <span className="font-medium">
              ⚠ {stuckRows.length} user{stuckRows.length === 1 ? "" : "s"} need
              {stuckRows.length === 1 ? "s" : ""} attention
            </span>{" "}
            — sync has stalled (an initial sync that never finished, or no
            forward progress for several consecutive runs) for{" "}
            {stuckRows.map((r) => r.userEmail).join(", ")}. Try "Sync now" to
            recover; if it persists, check the server logs.
          </div>
        ) : null}
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
                    {r.gmail.bootstrapStuck ? (
                      <div
                        className="mt-1 inline-flex items-center gap-1 rounded bg-destructive px-1.5 py-0.5 text-xs font-medium text-destructive-foreground"
                        title="The initial sync never finished and has stopped progressing. Click Sync now to resume it."
                        data-testid={`gmail-bootstrap-stuck-${r.userId}`}
                      >
                        ⚠ Initial sync stuck
                      </div>
                    ) : r.gmail.bootstrapInProgress ? (
                      <div className="text-xs text-amber-700">
                        Initial sync in progress
                      </div>
                    ) : null}
                    {r.gmail.stuck ? (
                      <div
                        className="mt-1 inline-flex items-center gap-1 rounded bg-destructive px-1.5 py-0.5 text-xs font-medium text-destructive-foreground"
                        title={`No forward progress for ${r.gmail.noProgressRuns} consecutive runs — sync appears stuck.`}
                        data-testid={`gmail-stuck-${r.userId}`}
                      >
                        ⚠ Stuck — {r.gmail.noProgressRuns} runs without progress
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
                    {r.calendar.bootstrapStuck ? (
                      <div
                        className="mt-1 inline-flex items-center gap-1 rounded bg-destructive px-1.5 py-0.5 text-xs font-medium text-destructive-foreground"
                        title="The initial sync never finished and has stopped progressing. Click Sync now to resume it."
                        data-testid={`calendar-bootstrap-stuck-${r.userId}`}
                      >
                        ⚠ Initial sync stuck
                      </div>
                    ) : r.calendar.bootstrapInProgress ? (
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
                      title="Runs an incremental sync now (or resumes the initial sync if it hasn't finished)."
                    >
                      Sync now
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

// ── Admin: Airtable → schools sync health ────────────────────────────────────
// Admin-only card surfacing the singleton run-state for the nightly Airtable →
// schools sync: when it last ran, ok/error, schools fetched/upserted, and the
// count of schools present in the CRM but missing from the Airtable source
// view. "Sync now" runs the same locked code path the scheduler does.

function SchoolSyncSection() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const q = useAdminGetSchoolSyncStatus({
    query: {
      queryKey: getAdminGetSchoolSyncStatusQueryKey(),
      refetchInterval: 30_000,
    },
  });
  const run = useAdminRunSchoolSync({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getAdminGetSchoolSyncStatusQueryKey() });
        toast({ title: "School sync finished" });
      },
      onError: (e: unknown) => {
        toast({
          title: "School sync failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  // 403 for non-admins: hide the whole card so regular staff visiting /admin
  // don't see a permanent error block.
  const errStatus = (q.error as unknown as { status?: number } | null)?.status;
  if (errStatus === 403) return null;

  const s = q.data;
  const status = s?.lastStatus ?? null;

  return (
    <Card data-testid="admin-school-sync-section">
      <CardHeader>
        <CardTitle>Airtable → schools sync</CardTitle>
        <CardDescription>
          Schools are mirrored one-way from the Airtable Schools view nightly
          (off-hours, America/Chicago). The sync is non-destructive — it never
          deletes, but counts schools that fell out of the source view so you
          can reconcile them by hand. Use "Sync now" to run it immediately.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {s && !s.configured ? (
          <div
            className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-800"
            data-testid="school-sync-unconfigured"
          >
            ⚠ Airtable isn't configured on the server, so the sync is a no-op.
            Set the Airtable credentials to enable it.
          </div>
        ) : null}
        {status === "error" && s?.lastError ? (
          <div
            className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="school-sync-error"
          >
            <span className="font-medium">Last sync failed</span> — {s.lastError}
          </div>
        ) : null}
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !s ? (
          <p className="text-sm text-muted-foreground">No status available.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Last run</dt>
              <dd className="font-medium" data-testid="school-sync-last-run">
                {fmtTime(s.lastRunFinishedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Status</dt>
              <dd data-testid="school-sync-status">
                {status === "ok" ? (
                  <span className="text-emerald-700 font-medium">OK</span>
                ) : status === "error" ? (
                  <span className="text-destructive font-medium">Error</span>
                ) : status === "running" ? (
                  <span className="text-amber-700 font-medium">Running…</span>
                ) : (
                  <span className="text-muted-foreground">Never run</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Schools fetched</dt>
              <dd className="font-medium" data-testid="school-sync-fetched">
                {s.schoolsFetched ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Schools upserted</dt>
              <dd className="font-medium" data-testid="school-sync-upserted">
                {s.schoolsUpserted ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground" title="Schools in the CRM but absent from the Airtable source view (not deleted).">
                Missing from Airtable
              </dt>
              <dd className="font-medium" data-testid="school-sync-stale">
                {s.staleInDb ?? "—"}
              </dd>
            </div>
          </dl>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={run.isPending}
          onClick={() => run.mutate()}
          data-testid="school-sync-now"
          title="Runs the Airtable → schools sync immediately."
        >
          {run.isPending ? "Syncing…" : "Sync now"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Admin: reassign records / offboard a user ────────────────────────────────
// Bulk-move every record owned by one team member to another in one
// transaction (people, organizations, opportunities & pledges, gifts &
// payments, interactions, assigned tasks). Owner FKs are ON DELETE RESTRICT,
// so a departing user can't be removed until their book is reassigned; this
// card does that and can archive the source user in the same step.

function ReassignOwnerSection() {
  const isAdmin = useIsAdmin();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [fromUserId, setFromUserId] = useState("");
  const [toUserId, setToUserId] = useState("");
  const [archiveSource, setArchiveSource] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const usersQ = useListUsers({
    query: { queryKey: getListUsersQueryKey(), staleTime: 60_000 },
  });
  const users = useMemo(
    () =>
      (usersQ.data ?? [])
        .filter(hasUsableIdentity)
        .slice()
        .sort((a, b) => userDisplayName(a).localeCompare(userDisplayName(b))),
    [usersQ.data],
  );

  const countsQ = useGetOwnedRecordCounts(
    { userId: fromUserId },
    {
      query: {
        queryKey: getGetOwnedRecordCountsQueryKey({ userId: fromUserId }),
        enabled: fromUserId !== "",
      },
    },
  );
  const counts = countsQ.data;

  const reassign = useReassignOwner({
    mutation: {
      onSuccess: (res) => {
        setConfirmOpen(false);
        toast({
          title: "Records reassigned",
          description: `${res.reassigned.total} record(s) moved${
            res.archivedSource ? " and the source user was archived" : ""
          }.`,
        });
        // Ownership changed across many tables (and the users list when the
        // source was archived); refetch everything so every list/detail view
        // reflects the new owner.
        void qc.invalidateQueries();
        setFromUserId("");
        setToUserId("");
        setArchiveSource(false);
      },
      onError: (e: unknown) => {
        toast({
          title: "Reassignment failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  // Admin-only affordance; the server enforces the same rule independently.
  if (!isAdmin) return null;

  const fromUser = users.find((u) => u.id === fromUserId);
  const toUser = users.find((u) => u.id === toUserId);
  const sameUser = fromUserId !== "" && fromUserId === toUserId;
  const canSubmit =
    fromUserId !== "" && toUserId !== "" && !sameUser && !reassign.isPending;

  return (
    <Card data-testid="admin-reassign-section">
      <CardHeader>
        <CardTitle>Reassign records / offboard a user</CardTitle>
        <CardDescription>
          Move every record owned by one team member to another in a single
          step — people, organizations, opportunities &amp; pledges, gifts &amp;
          payments, interactions, assigned tasks, and grant leads. Use this when
          someone leaves the team. Task authorship history is preserved.
          Optionally archive the departing user afterward.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="reassign-from">From (departing user)</Label>
            <Select value={fromUserId} onValueChange={setFromUserId}>
              <SelectTrigger id="reassign-from" data-testid="reassign-from">
                <SelectValue placeholder="Select a user" />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {userDisplayName(u)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reassign-to">To (new owner)</Label>
            <Select value={toUserId} onValueChange={setToUserId}>
              <SelectTrigger id="reassign-to" data-testid="reassign-to">
                <SelectValue placeholder="Select a user" />
              </SelectTrigger>
              <SelectContent>
                {users
                  .filter((u) => u.id !== fromUserId)
                  .map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {userDisplayName(u)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {sameUser ? (
          <p className="text-sm text-destructive">
            Source and destination must be different users.
          </p>
        ) : null}

        {fromUserId !== "" ? (
          <div
            className="rounded-md border bg-muted/30 px-3 py-2 text-sm"
            data-testid="reassign-counts"
          >
            {countsQ.isLoading ? (
              <span className="text-muted-foreground">Counting records…</span>
            ) : counts ? (
              counts.total === 0 ? (
                <span className="text-muted-foreground">
                  This user owns no records.
                </span>
              ) : (
                <div className="space-y-1">
                  <div className="font-medium">
                    {counts.total} record{counts.total === 1 ? "" : "s"} will be
                    reassigned:
                  </div>
                  <ul className="text-muted-foreground grid grid-cols-2 gap-x-6 sm:grid-cols-3">
                    <li>People: {counts.people}</li>
                    <li>Organizations: {counts.organizations}</li>
                    <li>Opportunities: {counts.opportunities}</li>
                    <li>Gifts: {counts.gifts}</li>
                    <li>Interactions: {counts.interactions}</li>
                    <li>Tasks: {counts.tasks}</li>
                    <li>Grant leads: {counts.grantLeads}</li>
                  </ul>
                </div>
              )
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <Switch
            id="reassign-archive"
            checked={archiveSource}
            onCheckedChange={setArchiveSource}
            data-testid="reassign-archive"
          />
          <Label htmlFor="reassign-archive" className="cursor-pointer">
            Archive the departing user after reassignment
          </Label>
        </div>

        <Button
          disabled={!canSubmit}
          onClick={() => setConfirmOpen(true)}
          data-testid="reassign-submit"
        >
          Reassign records
        </Button>
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm reassignment</DialogTitle>
            <DialogDescription>
              {counts?.total ?? 0} record(s) owned by{" "}
              <span className="font-medium">
                {fromUser ? userDisplayName(fromUser) : "—"}
              </span>{" "}
              will be reassigned to{" "}
              <span className="font-medium">
                {toUser ? userDisplayName(toUser) : "—"}
              </span>
              {archiveSource
                ? ", and the departing user will be archived."
                : "."}{" "}
              This cannot be undone automatically.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={reassign.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                reassign.mutate({
                  data: { fromUserId, toUserId, archiveSource },
                })
              }
              disabled={reassign.isPending}
              data-testid="reassign-confirm"
            >
              {reassign.isPending ? "Reassigning…" : "Reassign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
          <TableHead className="w-[180px] text-right">Fiscally sponsored</TableHead>
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

  const toggleFiscallySponsored = (next: boolean) => {
    update.mutate({ id: entity.id, data: { fiscallySponsored: next } });
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
          <span className={`text-xs ${entity.fiscallySponsored ? "text-foreground font-medium" : "text-muted-foreground"}`}>
            {entity.fiscallySponsored ? "Yes" : "No"}
          </span>
          <Switch
            checked={entity.fiscallySponsored}
            onCheckedChange={toggleFiscallySponsored}
            disabled={update.isPending}
            data-testid={`entity-fiscally-sponsored-${entity.id}`}
            aria-label={entity.fiscallySponsored ? "Mark not fiscally sponsored" : "Mark fiscally sponsored"}
          />
        </div>
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
  // Loan-fund capital goals are a track parallel to revenue. The toggle
  // swaps which category's goals this grid shows + edits; the two never mix.
  const [category, setCategory] = useState<FundraisingCategory>("revenue");

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

  // Build (fyId, entityId, category) -> goalAmount map for O(1) lookup.
  const goalMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of goals) m.set(`${g.fiscalYearId}|${g.entityId}|${g.category}`, g.goalAmount);
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
        <div className="flex items-center gap-1" data-testid="goals-category-toggle">
          {(
            [
              { value: "revenue", label: "Revenue / Gifts" },
              { value: "loan_capital", label: "Loan Capital" },
            ] as { value: FundraisingCategory; label: string }[]
          ).map((c) => (
            <button
              key={c.value}
              type="button"
              data-testid={`goals-category-${c.value}`}
              onClick={() => setCategory(c.value)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                category === c.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

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
                          key={`${fy.id}|${e.id}|${category}`}
                          fyId={fy.id}
                          entityId={e.id}
                          category={category}
                          current={goalMap.get(`${fy.id}|${e.id}|${category}`) ?? null}
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
  category,
  current,
}: {
  fyId: string;
  entityId: string;
  category: FundraisingCategory;
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
        del.mutate({ fyId, entityId, category });
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
    upsert.mutate({ fyId, entityId, category, data: { goalAmount: cleaned } });
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

// ── Internal staff email-domain config ───────────────────────────────────────
// The Gmail + Calendar sync matcher drops any address on one of these domains
// so internal staff-to-staff threads never land on a donor timeline. Read is
// open to any signed-in user; the PUT is admin-only and returns 403 (surfaced
// as a toast) for non-admins.

function InternalEmailDomainsSection() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const q = useGetInternalEmailDomains({
    query: { queryKey: getGetInternalEmailDomainsQueryKey(), staleTime: 60_000 },
  });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const current = q.data;

  const update = useUpdateInternalEmailDomains({
    mutation: {
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: getGetInternalEmailDomainsQueryKey() });
        toast({ title: "Internal domains saved" });
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
    setDraft((current.domains ?? []).join("\n"));
    setEditing(true);
  };

  const commit = () => {
    const domains = draft
      .split("\n")
      .map((s) => s.trim().toLowerCase().replace(/^\*?@/, "").trim())
      .filter((s) => s.length > 0);
    update.mutate({ data: { domains } });
  };

  return (
    <Card data-testid="admin-internal-domains-section">
      <CardHeader>
        <CardTitle>Internal staff email domains</CardTitle>
        <CardDescription>
          Email + calendar sync drops any address on these domains, so internal
          staff-to-staff messages never appear on donor timelines. Add a new
          Google Workspace domain here when staff start using one — no code
          change needed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : editing ? (
          <div className="space-y-4">
            <div>
              <Label htmlFor="internal-domains">
                Domains (one per line, e.g. wildflowerschools.org)
              </Label>
              <textarea
                id="internal-domains"
                data-testid="internal-domains-input"
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[120px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={"wildflowerschools.org\nblackwildflowers.org"}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={commit}
                disabled={update.isPending}
                data-testid="internal-domains-save"
              >
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
                Configured domains
              </div>
              {(current?.domains ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">None configured.</p>
              ) : (
                <ul className="text-sm space-y-0.5">
                  {(current?.domains ?? []).map((d) => (
                    <li
                      key={d}
                      className="font-mono bg-muted rounded px-2 py-0.5 inline-block mr-1 mb-1"
                    >
                      {d}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              Last updated:{" "}
              {current?.updatedAt
                ? new Date(current.updatedAt).toLocaleString()
                : "never"}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={startEdit}
              data-testid="internal-domains-edit"
            >
              Edit
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Admin: email-intelligence console ────────────────────────────────────────
// Admin-only. Hand-edit / AI-draft / version / revert the system prompt that
// drives email-intelligence action proposals, and browse a cross-mailbox feed
// of reviewer feedback to inform those edits. Hidden entirely on 403.

const PROMPT_KIND_LABELS: Record<EmailProposalKind, string> = {
  linkedin_job_change: "Job change",
  auto_responder_move: "Moved (auto-reply)",
  bounce_invalid: "Hard bounce",
  bounce_soft: "Soft bounce",
  signature_update: "Signature update",
  grant_opportunity: "Grant opportunity",
  thank_you_acknowledgment: "Thank-you ack",
};

const ORIGIN_LABELS: Record<EmailIntelPrompt["origin"], string> = {
  hand_edited: "Hand-edited",
  ai_generated: "AI-generated",
  reverted: "Reverted",
};

/**
 * Minimal line-level diff: classify each line of `next` against `prev` as
 * added / unchanged, and each line of `prev` missing from `next` as removed.
 * Good enough to let an admin eyeball what an AI draft changed without
 * pulling in a diff library.
 */
function lineDiff(
  prev: string,
  next: string,
): { type: "added" | "removed" | "same"; text: string }[] {
  const prevLines = prev.split("\n");
  const nextLines = next.split("\n");
  const prevSet = new Set(prevLines);
  const nextSet = new Set(nextLines);
  const out: { type: "added" | "removed" | "same"; text: string }[] = [];
  for (const line of nextLines) {
    out.push({ type: prevSet.has(line) ? "same" : "added", text: line });
  }
  for (const line of prevLines) {
    if (!nextSet.has(line)) out.push({ type: "removed", text: line });
  }
  return out;
}

function EmailIntelligenceSection() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const promptsQ = useAdminListEmailIntelPrompts({
    query: { queryKey: getAdminListEmailIntelPromptsQueryKey() },
  });

  const errStatus = (promptsQ.error as unknown as { status?: number } | null)?.status;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [showDraftDiff, setShowDraftDiff] = useState(true);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getAdminListEmailIntelPromptsQueryKey() });

  const save = useAdminSaveEmailIntelPrompt({
    mutation: {
      onSuccess: () => {
        invalidate();
        setEditing(false);
        toast({ title: "Prompt saved as the new active version" });
      },
      onError: (e: unknown) =>
        toast({
          title: "Save failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const generate = useAdminGenerateEmailIntelPrompt({
    mutation: {
      onSuccess: () => {
        invalidate();
        setShowDraftDiff(true);
        toast({ title: "AI draft generated", description: "Review and approve below." });
      },
      onError: (e: unknown) => {
        const status = (e as { status?: number } | null)?.status;
        toast({
          title: status === 409 ? "No feedback yet" : "Generation failed",
          description:
            status === 409
              ? "There are no resolved proposals to learn from yet."
              : e instanceof Error
                ? e.message
                : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  const activate = useAdminActivateEmailIntelPrompt({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Version activated" });
      },
      onError: (e: unknown) =>
        toast({
          title: "Activate failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const revert = useAdminRevertEmailIntelPrompt({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Reverted", description: "A new active version was created from that version." });
      },
      onError: (e: unknown) =>
        toast({
          title: "Revert failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const discard = useAdminDiscardEmailIntelPrompt({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Draft discarded" });
      },
      onError: (e: unknown) =>
        toast({
          title: "Discard failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  // 403 → hide the whole card for non-admins.
  if (errStatus === 403) return null;

  const overview = promptsQ.data;
  const active = overview?.active ?? null;
  const aiDraft = overview?.draft ?? null;
  const history = overview?.history ?? [];
  const usingDefault = overview?.usingDefault ?? true;
  const baselineText = active?.promptText ?? overview?.default ?? "";

  const startEdit = () => {
    setDraft(baselineText);
    setEditing(true);
  };

  return (
    <Card data-testid="admin-email-intel-section">
      <CardHeader>
        <CardTitle>Email intelligence prompt</CardTitle>
        <CardDescription>
          The system prompt the AI follows when proposing CRM actions from
          incoming email. Hand-edit it, or generate an improved draft from recent
          reviewer feedback — drafts are never applied until you approve them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {promptsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {/* Active prompt + editor */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Active prompt</span>
                {usingDefault ? (
                  <Badge variant="secondary">Built-in default</Badge>
                ) : active ? (
                  <Badge variant="secondary">{ORIGIN_LABELS[active.origin]}</Badge>
                ) : null}
                {active?.updatedAt ? (
                  <span className="text-xs text-muted-foreground">
                    updated {new Date(active.updatedAt).toLocaleString()}
                    {active.authorName ? ` by ${active.authorName}` : ""}
                  </span>
                ) : null}
              </div>

              {editing ? (
                <div className="space-y-2">
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={18}
                    className="font-mono text-xs"
                    data-testid="email-intel-prompt-editor"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={save.isPending || !draft.trim()}
                      onClick={() => save.mutate({ data: { promptText: draft } })}
                      data-testid="email-intel-save"
                    >
                      {save.isPending ? "Saving…" : "Save as active"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={save.isPending}
                      onClick={() => setEditing(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap font-mono">
                    {baselineText}
                  </pre>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={startEdit} data-testid="email-intel-edit">
                      Edit prompt
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={generate.isPending}
                      onClick={() => generate.mutate()}
                      data-testid="email-intel-generate"
                    >
                      {generate.isPending ? "Generating…" : "Generate AI update"}
                    </Button>
                  </div>
                </>
              )}
            </div>

            {/* Outstanding AI draft awaiting review */}
            {aiDraft ? (
              <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3" data-testid="email-intel-draft">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge className="bg-amber-600 hover:bg-amber-600">AI draft</Badge>
                    <span className="text-xs text-muted-foreground">
                      generated {new Date(aiDraft.createdAt).toLocaleString()}
                      {aiDraft.authorName ? ` by ${aiDraft.authorName}` : ""}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowDraftDiff((v) => !v)}
                  >
                    {showDraftDiff ? "Show full text" : "Show diff"}
                  </Button>
                </div>
                {showDraftDiff ? (
                  <pre className="max-h-72 overflow-auto rounded-md bg-background p-3 text-xs whitespace-pre-wrap font-mono">
                    {lineDiff(baselineText, aiDraft.promptText).map((l, i) => (
                      <div
                        key={i}
                        className={
                          l.type === "added"
                            ? "bg-emerald-100 text-emerald-900"
                            : l.type === "removed"
                              ? "bg-red-100 text-red-900 line-through"
                              : ""
                        }
                      >
                        {l.type === "added" ? "+ " : l.type === "removed" ? "- " : "  "}
                        {l.text}
                      </div>
                    ))}
                  </pre>
                ) : (
                  <pre className="max-h-72 overflow-auto rounded-md bg-background p-3 text-xs whitespace-pre-wrap font-mono">
                    {aiDraft.promptText}
                  </pre>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={activate.isPending}
                    onClick={() => activate.mutate({ id: aiDraft.id })}
                    data-testid="email-intel-approve-draft"
                  >
                    {activate.isPending ? "Approving…" : "Approve & activate"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={discard.isPending}
                    onClick={() => discard.mutate({ id: aiDraft.id })}
                    data-testid="email-intel-discard-draft"
                  >
                    Discard
                  </Button>
                </div>
              </div>
            ) : null}

            {/* Version history */}
            {history.length > 0 ? (
              <div className="space-y-2">
                <span className="text-sm font-medium">Version history</span>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Archived</TableHead>
                      <TableHead>Origin</TableHead>
                      <TableHead>Author</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((h) => (
                      <TableRow key={h.id} data-testid={`email-intel-history-${h.id}`}>
                        <TableCell className="text-sm">
                          {new Date(h.updatedAt).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{ORIGIN_LABELS[h.origin]}</Badge>
                        </TableCell>
                        <TableCell className="text-sm">{h.authorName ?? "—"}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={revert.isPending}
                            onClick={() => revert.mutate({ id: h.id })}
                            data-testid={`email-intel-revert-${h.id}`}
                          >
                            Revert to this
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}

            <Separator />

            <EmailIntelFeedbackFeed />
          </>
        )}
      </CardContent>
    </Card>
  );
}

const FEEDBACK_PAGE_SIZE = 20;

function EmailIntelFeedbackFeed() {
  const [kind, setKind] = useState<EmailProposalKind | "all">("all");
  const [status, setStatus] = useState<EmailProposalStatus | "all">("all");
  const [page, setPage] = useState(1);

  const params = {
    ...(kind !== "all" ? { kind } : {}),
    ...(status !== "all" ? { status } : {}),
    limit: FEEDBACK_PAGE_SIZE,
    page,
  };

  const q = useAdminListEmailIntelFeedback(params, {
    query: { queryKey: getAdminListEmailIntelFeedbackQueryKey(params) },
  });

  const items = q.data?.data ?? [];
  const total = q.data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / FEEDBACK_PAGE_SIZE));

  const statusBadge = (s: EmailProposalStatus) => {
    if (s === "applied") return <Badge className="bg-emerald-600 hover:bg-emerald-600">Accepted</Badge>;
    if (s === "rejected") return <Badge variant="destructive">Rejected</Badge>;
    return <Badge variant="secondary">Ignored</Badge>;
  };

  return (
    <div className="space-y-3" data-testid="email-intel-feedback">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-sm font-medium">Reviewer feedback (all mailboxes)</span>
        <div className="flex gap-2">
          <Select
            value={kind}
            onValueChange={(v) => {
              setKind(v as EmailProposalKind | "all");
              setPage(1);
            }}
          >
            <SelectTrigger className="w-44 h-8 text-xs" data-testid="feedback-kind-filter">
              <SelectValue placeholder="All kinds" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              {(Object.keys(PROMPT_KIND_LABELS) as EmailProposalKind[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {PROMPT_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v as EmailProposalStatus | "all");
              setPage(1);
            }}
          >
            <SelectTrigger className="w-36 h-8 text-xs" data-testid="feedback-status-filter">
              <SelectValue placeholder="All verdicts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All verdicts</SelectItem>
              <SelectItem value="applied">Accepted</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="ignored">Ignored</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No resolved proposals match these filters.</p>
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <div
              key={it.id}
              className="rounded-md border p-3 space-y-1.5"
              data-testid={`feedback-item-${it.id}`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                {statusBadge(it.status)}
                <Badge variant="outline">{PROMPT_KIND_LABELS[it.kind]}</Badge>
                <span className="text-sm font-medium">
                  {it.subjectName ?? it.subjectEmail ?? "(unknown subject)"}
                </span>
                <span className="text-xs text-muted-foreground ml-auto">
                  {it.resolvedAt ? new Date(it.resolvedAt).toLocaleString() : ""}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                mailbox: {it.mailboxUserName ?? it.mailboxUserId}
                {it.resolverName ? ` · resolved by ${it.resolverName}` : ""}
              </div>
              {it.proposedActions.length > 0 ? (
                <ul className="text-xs space-y-0.5">
                  {it.proposedActions.map((a, i) => (
                    <li key={i}>
                      <span className="font-mono text-muted-foreground">{a.type}</span>
                      {a.reason ? <span> — {a.reason}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-xs text-muted-foreground italic">No actions proposed.</div>
              )}
              {it.reviewerNote ? (
                <div className="text-xs rounded bg-muted px-2 py-1">
                  <span className="font-medium">Reviewer note:</span> {it.reviewerNote}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {totalPages > 1 ? (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Page {page} of {totalPages} · {total} total
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Admin: QuickBooks auto-handling rules ────────────────────────────────────
// Admin-only. The DB-backed classifier that drives the QuickBooks INGEST path:
// each incoming payment is tested top-to-bottom (ascending priority) and the
// first enabled match wins. `exclude` drops the row into the excluded queue with
// a reason; `auto_create_approve` mints a gift to a chosen org, allocates it, and
// auto-approves it straight into the approved queue. Edits affect only NEW
// payments — already-queued rows are never reclassified. Hidden from non-admins
// (the API enforces the same rule independently).

const QB_FIELD_LABELS: Record<QuickbooksRuleConditionField, string> = {
  payer_name: "Payer name",
  line_item_name: "Line item",
  line_account_name: "Line account",
  memo_reference: "Memo / reference",
  line_description: "Line description",
  qb_class: "QB class",
  any_text: "Any text",
  amount: "Amount",
};

const QB_FIELD_ORDER: QuickbooksRuleConditionField[] = [
  "payer_name",
  "line_item_name",
  "line_account_name",
  "memo_reference",
  "line_description",
  "qb_class",
  "any_text",
  "amount",
];

const QB_MODE_LABELS: Record<QuickbooksRuleConditionMode, string> = {
  contains: "contains",
  exact: "equals",
  prefix: "starts with",
  regex: "matches regex",
  lte: "≤ (at most)",
};

// `lte` couples to the amount field, and amount only makes sense with `lte`.
const QB_TEXT_MODES: QuickbooksRuleConditionMode[] = [
  "contains",
  "exact",
  "prefix",
  "regex",
];

const QB_ACTION_LABELS: Record<QuickbooksRuleAction, string> = {
  exclude: "Exclude as noise",
  auto_create_approve: "Auto-create & approve gift",
};

const QB_EXCLUSION_REASONS: StagedPaymentExclusionReason[] = [
  "zero_amount",
  "loan",
  "membership",
  "interest",
  "government_reimbursement",
  "tax_refund",
  "other_revenue",
  "earned_income",
  "fiscally_sponsored",
  "intercompany_transfer",
  "other",
  "insurance",
  "expense_refund",
  "expensify",
  "returned_wire",
];

const QB_INTENDED_USAGES: IntendedUsage[] = [
  "gen_ops",
  "growth",
  "school_startup",
  "teacher_training",
  "project",
];

type RuleDraft = {
  id: string | null;
  name: string;
  enabled: boolean;
  action: QuickbooksRuleAction;
  exclusionReason: StagedPaymentExclusionReason | null;
  donationGuard: boolean;
  matchLogic: QuickbooksRuleMatchLogic;
  conditions: QuickbooksRuleCondition[];
  targetOrganizationId: string | null;
  targetIntendedUsage: IntendedUsage | null;
  targetFundableProjectId: string | null;
};

function emptyRuleDraft(): RuleDraft {
  return {
    id: null,
    name: "",
    enabled: true,
    action: "exclude",
    exclusionReason: "other",
    donationGuard: false,
    matchLogic: "any",
    conditions: [{ field: "payer_name", mode: "contains", value: "" }],
    targetOrganizationId: null,
    targetIntendedUsage: "gen_ops",
    targetFundableProjectId: null,
  };
}

function ruleToDraft(r: QuickbooksHandlingRule): RuleDraft {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    action: r.action,
    exclusionReason: r.exclusionReason ?? "other",
    donationGuard: r.donationGuard,
    matchLogic: r.matchLogic,
    conditions:
      r.conditions.length > 0
        ? r.conditions.map((c) => ({ ...c }))
        : [{ field: "payer_name", mode: "contains", value: "" }],
    targetOrganizationId: r.targetOrganizationId ?? null,
    targetIntendedUsage: r.targetIntendedUsage ?? "gen_ops",
    targetFundableProjectId: r.targetFundableProjectId ?? null,
  };
}

function conditionSummary(r: QuickbooksHandlingRule): string {
  if (r.conditions.length === 0) return "(no conditions)";
  const joiner = r.matchLogic === "all" ? " AND " : " OR ";
  return r.conditions
    .map((c) => {
      const field = QB_FIELD_LABELS[c.field] ?? c.field;
      const mode = QB_MODE_LABELS[c.mode] ?? c.mode;
      return `${field} ${mode} "${c.value}"`;
    })
    .join(joiner);
}

function QuickbooksRulesSection() {
  const isAdmin = useIsAdmin();
  const { toast } = useToast();
  const qc = useQueryClient();

  const rulesQ = useAdminListQuickbooksRules({
    query: {
      queryKey: getAdminListQuickbooksRulesQueryKey(),
      enabled: isAdmin,
      staleTime: 30_000,
    },
  });

  const projectsQ = useListFundableProjects(undefined, {
    query: {
      queryKey: getListFundableProjectsQueryKey(undefined),
      enabled: isAdmin,
      staleTime: 60_000,
    },
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<RuleDraft>(emptyRuleDraft);

  type ApplyStep = "idle" | "previewing" | "confirming" | "applying";
  const [applyTargetRule, setApplyTargetRule] =
    useState<QuickbooksHandlingRule | null>(null);
  const [applyStep, setApplyStep] = useState<ApplyStep>("idle");
  const [applyPreview, setApplyPreview] =
    useState<ApplyRuleToPendingResult | null>(null);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getAdminListQuickbooksRulesQueryKey() });

  const onMutError = (err: unknown) =>
    toast({
      title: "Save failed",
      description: err instanceof Error ? err.message : String(err),
      variant: "destructive",
    });

  const applyToPending = useAdminApplyQuickbooksRuleToPending({
    mutation: {
      onError: (err) =>
        toast({
          title: "Apply failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  const openApplyDialog = (r: QuickbooksHandlingRule) => {
    setApplyTargetRule(r);
    setApplyPreview(null);
    setApplyStep("previewing");
    applyToPending.mutate(
      { id: r.id, data: { dryRun: true } },
      {
        onSuccess: (data) => {
          setApplyPreview(data);
          setApplyStep("confirming");
        },
        onError: () => setApplyStep("idle"),
      },
    );
  };

  const confirmApply = () => {
    if (!applyTargetRule) return;
    setApplyStep("applying");
    applyToPending.mutate(
      { id: applyTargetRule.id, data: { dryRun: false } },
      {
        onSuccess: (data) => {
          setApplyStep("idle");
          const parts: string[] = [];
          if (data.excluded > 0) parts.push(`${data.excluded} excluded`);
          if (data.autoCreated > 0)
            parts.push(`${data.autoCreated} gift(s) created`);
          if (data.skipped > 0) parts.push(`${data.skipped} skipped`);
          toast({
            title: "Rule applied",
            description:
              parts.length > 0 ? parts.join(", ") : "No matching rows found.",
          });
          setApplyTargetRule(null);
          qc.invalidateQueries({ queryKey: ["/api/staged-payments"] });
          qc.invalidateQueries({ queryKey: ["/api/staged-payments-summary"] });
        },
        onError: () => setApplyStep("idle"),
      },
    );
  };

  const create = useAdminCreateQuickbooksRule({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Rule created" });
        setDialogOpen(false);
      },
      onError: onMutError,
    },
  });
  const update = useAdminUpdateQuickbooksRule({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        setDialogOpen(false);
      },
      onError: onMutError,
    },
  });
  const reorder = useAdminReorderQuickbooksRules({
    mutation: { onSuccess: invalidate, onError: onMutError },
  });
  const del = useAdminDeleteQuickbooksRule({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Rule deleted" });
      },
      onError: onMutError,
    },
  });

  if (!isAdmin) return null;

  const rules = rulesQ.data ?? [];
  const projects = projectsQ.data ?? [];
  const saving = create.isPending || update.isPending;

  const openCreate = () => {
    setDraft(emptyRuleDraft());
    setDialogOpen(true);
  };
  const openEdit = (r: QuickbooksHandlingRule) => {
    setDraft(ruleToDraft(r));
    setDialogOpen(true);
  };

  const toggleEnabled = (r: QuickbooksHandlingRule) =>
    update.mutate({ id: r.id, data: { enabled: !r.enabled } });

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= rules.length) return;
    const ids = rules.map((r) => r.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.mutate({ data: { ids } });
  };

  const removeRule = (r: QuickbooksHandlingRule) => {
    if (
      !window.confirm(
        `Delete rule "${r.name}"? This affects only future payments.`,
      )
    )
      return;
    del.mutate({ id: r.id });
  };

  const submit = () => {
    const conditions = draft.conditions
      .map((c) => ({ ...c, value: c.value.trim() }))
      .filter((c) => c.value !== "");
    const body: CreateQuickbooksRuleBody = {
      name: draft.name.trim(),
      enabled: draft.enabled,
      action: draft.action,
      donationGuard: draft.donationGuard,
      matchLogic: draft.matchLogic,
      conditions,
      exclusionReason:
        draft.action === "exclude" ? draft.exclusionReason : null,
      targetOrganizationId:
        draft.action === "auto_create_approve"
          ? draft.targetOrganizationId
          : null,
      targetIntendedUsage:
        draft.action === "auto_create_approve"
          ? draft.targetIntendedUsage
          : null,
      targetFundableProjectId:
        draft.action === "auto_create_approve" &&
        draft.targetIntendedUsage === "project"
          ? draft.targetFundableProjectId
          : null,
    };

    // Mirror server validation so the user sees errors before round-tripping.
    if (!body.name) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    if (conditions.length === 0) {
      toast({
        title: "At least one condition with a value is required",
        variant: "destructive",
      });
      return;
    }
    if (draft.action === "exclude" && !body.exclusionReason) {
      toast({ title: "Pick an exclusion reason", variant: "destructive" });
      return;
    }
    if (draft.action === "auto_create_approve") {
      if (!body.targetOrganizationId) {
        toast({
          title: "Pick the donor organization for the gift",
          variant: "destructive",
        });
        return;
      }
      if (
        draft.targetIntendedUsage === "project" &&
        !body.targetFundableProjectId
      ) {
        toast({ title: "Pick a fundable project", variant: "destructive" });
        return;
      }
    }

    if (draft.id) update.mutate({ id: draft.id, data: body });
    else create.mutate({ data: body });
  };

  const setCond = (i: number, patch: Partial<QuickbooksRuleCondition>) =>
    setDraft((d) => ({
      ...d,
      conditions: d.conditions.map((c, idx) =>
        idx === i ? { ...c, ...patch } : c,
      ),
    }));

  return (
    <Card data-testid="admin-quickbooks-rules-section">
      <CardHeader>
        <CardTitle>QuickBooks auto-handling rules</CardTitle>
        <CardDescription>
          As QuickBooks payments are pulled in, each row is tested against these
          rules top to bottom — the first enabled match wins. Use them to drop
          recurring noise (loans, refunds, membership dues) or to auto-create and
          approve a gift for known recurring donors. Changes apply to{" "}
          <strong>new payments only</strong>; rows already in the review queue are
          left as-is.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4">
          <Button size="sm" onClick={openCreate} data-testid="qb-rule-add">
            Add rule
          </Button>
        </div>
        {rulesQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No rules configured.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Order</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Conditions</TableHead>
                <TableHead className="w-20">Enabled</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((r, i) => (
                <TableRow key={r.id} data-testid={`qb-rule-row-${r.id}`}>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        disabled={i === 0 || reorder.isPending}
                        onClick={() => move(i, -1)}
                        aria-label="Move up"
                        data-testid={`qb-rule-up-${r.id}`}
                      >
                        ↑
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        disabled={i === rules.length - 1 || reorder.isPending}
                        onClick={() => move(i, 1)}
                        aria-label="Move down"
                        data-testid={`qb-rule-down-${r.id}`}
                      >
                        ↓
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <Badge
                        variant={
                          r.action === "exclude" ? "secondary" : "default"
                        }
                      >
                        {QB_ACTION_LABELS[r.action]}
                      </Badge>
                      {r.action === "exclude" && r.exclusionReason ? (
                        <span className="text-xs text-muted-foreground">
                          {formatEnum(r.exclusionReason)}
                        </span>
                      ) : null}
                      {r.action === "auto_create_approve" ? (
                        <span className="text-xs text-muted-foreground">
                          → {formatEnum(r.targetIntendedUsage ?? "")}
                        </span>
                      ) : null}
                      {r.donationGuard ? (
                        <span className="text-xs text-muted-foreground">
                          donation-guarded
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-md">
                    {conditionSummary(r)}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={r.enabled}
                      onCheckedChange={() => toggleEnabled(r)}
                      disabled={update.isPending}
                      data-testid={`qb-rule-toggle-${r.id}`}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openApplyDialog(r)}
                        disabled={applyToPending.isPending}
                        data-testid={`qb-rule-apply-${r.id}`}
                      >
                        Apply to pending
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openEdit(r)}
                        data-testid={`qb-rule-edit-${r.id}`}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => removeRule(r)}
                        disabled={del.isPending}
                        data-testid={`qb-rule-delete-${r.id}`}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog
        open={applyStep === "confirming" || applyStep === "applying"}
        onOpenChange={(open) => {
          if (!open && applyStep !== "applying") {
            setApplyStep("idle");
            setApplyTargetRule(null);
          }
        }}
      >
        <DialogContent data-testid="qb-rule-apply-dialog">
          <DialogHeader>
            <DialogTitle>Apply rule to pending payments</DialogTitle>
            <DialogDescription>
              This will run{" "}
              <strong>{applyTargetRule?.name ?? "this rule"}</strong> against
              all payments currently in the review queue. Only{" "}
              <strong>pending</strong> rows (not yet approved, rejected, or
              excluded) will be affected.
            </DialogDescription>
          </DialogHeader>
          {applyPreview && (
            <div className="rounded-md border border-border p-4 space-y-1 text-sm">
              <p>
                <strong>{applyPreview.matched}</strong> pending payment
                {applyPreview.matched !== 1 ? "s" : ""} match this rule.
              </p>
              {applyTargetRule?.action === "exclude" && (
                <p className="text-muted-foreground">
                  They will be marked <em>excluded</em> (
                  {applyTargetRule.exclusionReason ?? "reason unset"}).
                </p>
              )}
              {applyTargetRule?.action === "auto_create_approve" && (
                <p className="text-muted-foreground">
                  A gift will be minted and auto-approved for each matching row
                  (same fail-safe as ingest — rows where the rule can't apply
                  cleanly are left pending).
                </p>
              )}
              {applyPreview.matched === 0 && (
                <p className="text-muted-foreground">
                  Nothing to do — no pending rows match this rule right now.
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setApplyStep("idle");
                setApplyTargetRule(null);
              }}
              disabled={applyStep === "applying"}
            >
              Cancel
            </Button>
            <Button
              onClick={confirmApply}
              disabled={
                applyStep === "applying" ||
                !applyPreview ||
                applyPreview.matched === 0
              }
              data-testid="qb-rule-apply-confirm"
            >
              {applyStep === "applying" ? "Applying…" : "Apply now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{draft.id ? "Edit rule" : "Add rule"}</DialogTitle>
            <DialogDescription>
              Applies to newly synced QuickBooks payments only.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="qb-rule-name">Name</Label>
              <Input
                id="qb-rule-name"
                value={draft.name}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
                placeholder="e.g. AmazonSmile → Amazon Foundation"
                data-testid="qb-rule-name-input"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Action</Label>
                <Select
                  value={draft.action}
                  onValueChange={(v) =>
                    setDraft((d) => ({
                      ...d,
                      action: v as QuickbooksRuleAction,
                    }))
                  }
                >
                  <SelectTrigger data-testid="qb-rule-action">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      Object.keys(QB_ACTION_LABELS) as QuickbooksRuleAction[]
                    ).map((a) => (
                      <SelectItem key={a} value={a}>
                        {QB_ACTION_LABELS[a]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Match logic</Label>
                <Select
                  value={draft.matchLogic}
                  onValueChange={(v) =>
                    setDraft((d) => ({
                      ...d,
                      matchLogic: v as QuickbooksRuleMatchLogic,
                    }))
                  }
                >
                  <SelectTrigger data-testid="qb-rule-matchlogic">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Match ANY condition</SelectItem>
                    <SelectItem value="all">Match ALL conditions</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                checked={draft.donationGuard}
                onCheckedChange={(v) =>
                  setDraft((d) => ({ ...d, donationGuard: v }))
                }
                data-testid="qb-rule-donationguard"
              />
              <Label className="cursor-default">
                Skip this rule when the row carries a real donation line
              </Label>
            </div>

            {draft.action === "exclude" ? (
              <div>
                <Label>Exclusion reason</Label>
                <Select
                  value={draft.exclusionReason ?? "other"}
                  onValueChange={(v) =>
                    setDraft((d) => ({
                      ...d,
                      exclusionReason: v as StagedPaymentExclusionReason,
                    }))
                  }
                >
                  <SelectTrigger data-testid="qb-rule-exclusionreason">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QB_EXCLUSION_REASONS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {formatEnum(r)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-4 rounded-md border border-border p-3">
                <div>
                  <Label>Donor organization (gift attribution)</Label>
                  <EntityCombobox
                    useSearch={useOrganizationSearch}
                    useResolve={useOrganizationName}
                    value={draft.targetOrganizationId}
                    onChange={(id) =>
                      setDraft((d) => ({ ...d, targetOrganizationId: id }))
                    }
                    placeholder="Search organizations…"
                    allowNull={false}
                    testId="qb-rule-org"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Allocation</Label>
                    <Select
                      value={draft.targetIntendedUsage ?? "gen_ops"}
                      onValueChange={(v) =>
                        setDraft((d) => ({
                          ...d,
                          targetIntendedUsage: v as IntendedUsage,
                          targetFundableProjectId:
                            v === "project" ? d.targetFundableProjectId : null,
                        }))
                      }
                    >
                      <SelectTrigger data-testid="qb-rule-usage">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {QB_INTENDED_USAGES.map((u) => (
                          <SelectItem key={u} value={u}>
                            {formatEnum(u)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {draft.targetIntendedUsage === "project" ? (
                    <div>
                      <Label>Fundable project</Label>
                      <Select
                        value={draft.targetFundableProjectId ?? ""}
                        onValueChange={(v) =>
                          setDraft((d) => ({
                            ...d,
                            targetFundableProjectId: v,
                          }))
                        }
                      >
                        <SelectTrigger data-testid="qb-rule-project">
                          <SelectValue placeholder="Pick a project…" />
                        </SelectTrigger>
                        <SelectContent>
                          {projects.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Conditions</Label>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      conditions: [
                        ...d.conditions,
                        { field: "payer_name", mode: "contains", value: "" },
                      ],
                    }))
                  }
                  data-testid="qb-rule-add-condition"
                >
                  Add condition
                </Button>
              </div>
              <div className="space-y-2">
                {draft.conditions.map((c, i) => {
                  const isAmount = c.field === "amount";
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-2"
                      data-testid={`qb-rule-condition-${i}`}
                    >
                      <Select
                        value={c.field}
                        onValueChange={(v) => {
                          const field = v as QuickbooksRuleConditionField;
                          setCond(i, {
                            field,
                            mode:
                              field === "amount"
                                ? "lte"
                                : c.mode === "lte"
                                  ? "contains"
                                  : c.mode,
                          });
                        }}
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {QB_FIELD_ORDER.map((f) => (
                            <SelectItem key={f} value={f}>
                              {QB_FIELD_LABELS[f]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={c.mode}
                        onValueChange={(v) =>
                          setCond(i, {
                            mode: v as QuickbooksRuleConditionMode,
                          })
                        }
                        disabled={isAmount}
                      >
                        <SelectTrigger className="w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {isAmount ? (
                            <SelectItem value="lte">
                              {QB_MODE_LABELS.lte}
                            </SelectItem>
                          ) : (
                            QB_TEXT_MODES.map((m) => (
                              <SelectItem key={m} value={m}>
                                {QB_MODE_LABELS[m]}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                      <Input
                        value={c.value}
                        onChange={(e) => setCond(i, { value: e.target.value })}
                        placeholder={isAmount ? "amount, e.g. 100" : "value"}
                        className="flex-1"
                        data-testid={`qb-rule-condition-value-${i}`}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-destructive"
                        disabled={draft.conditions.length <= 1}
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            conditions: d.conditions.filter(
                              (_, idx) => idx !== i,
                            ),
                          }))
                        }
                        aria-label="Remove condition"
                      >
                        ✕
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                checked={draft.enabled}
                onCheckedChange={(v) =>
                  setDraft((d) => ({ ...d, enabled: v }))
                }
                data-testid="qb-rule-enabled"
              />
              <Label className="cursor-default">Enabled</Label>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving} data-testid="qb-rule-save">
              {saving ? "Saving…" : "Save rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ── Admin: per-entity revenue coding rules ───────────────────────────────────
// Admin-editable defaults that feed deriveRevenueCoding(): force a fund entity's
// gifts to be treated as purpose-restricted (fiscal sponsees), and/or pin a
// default Location / Class. Mirrors the code SEED_ENTITY_CODING_RULES (kept in
// lockstep by a fidelity test). Effective coding on an allocation is still
// override ?? derived — these rules only shape the derived snapshot.

const NONE_LOCATION = "__none__";

function EntityCodingRulesSection({ entities }: { entities: Entity[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const rulesQ = useAdminListEntityCodingRules({
    query: { queryKey: getAdminListEntityCodingRulesQueryKey() },
  });
  const rules = rulesQ.data ?? [];

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getAdminListEntityCodingRulesQueryKey() });

  const entityName = (id: string) =>
    entities.find((e) => e.id === id)?.name ?? id;

  const create = useAdminCreateEntityCodingRule({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Coding rule added" });
      },
      onError: (err: unknown) =>
        toast({
          title: "Create failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });
  const update = useAdminUpdateEntityCodingRule({
    mutation: {
      onSuccess: () => invalidate(),
      onError: (err: unknown) =>
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });
  const del = useAdminDeleteEntityCodingRule({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Coding rule removed" });
      },
      onError: (err: unknown) =>
        toast({
          title: "Delete failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  // New-rule form state.
  const [entityId, setEntityId] = useState("");
  const [forceRestricted, setForceRestricted] = useState(false);
  const [location, setLocation] = useState<string>(NONE_LOCATION);
  const [revenueClass, setRevenueClass] = useState("");
  const [notes, setNotes] = useState("");

  const usedEntityIds = new Set(rules.map((r) => r.entityId));
  const availableEntities = entities.filter((e) => !usedEntityIds.has(e.id));

  const canSubmit = entityId.trim() !== "" && !create.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const body: CreateEntityCodingRuleBody = {
      entityId,
      forceRestricted,
      location: location === NONE_LOCATION ? null : location,
      revenueClass: revenueClass.trim() === "" ? null : revenueClass.trim(),
      notes: notes.trim() === "" ? null : notes.trim(),
    };
    create.mutate(
      { data: body },
      {
        onSuccess: () => {
          setEntityId("");
          setForceRestricted(false);
          setLocation(NONE_LOCATION);
          setRevenueClass("");
          setNotes("");
        },
      },
    );
  };

  return (
    <Card data-testid="admin-entity-coding-rules-section">
      <CardHeader>
        <CardTitle>Revenue coding rules</CardTitle>
        <CardDescription>
          Per-entity defaults that shape the derived QuickBooks coding (Object
          Code / Location / Class) on gift &amp; pledge allocations. Forcing an
          entity restricted treats all its gifts as purpose-restricted (used for
          fiscal sponsees). Allocations can still override the derived values
          individually.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form
          onSubmit={submit}
          className="space-y-3"
          data-testid="new-coding-rule-form"
        >
          <h3 className="text-sm font-semibold">Add rule</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="coding-rule-entity">Entity</Label>
              <Select value={entityId} onValueChange={setEntityId}>
                <SelectTrigger id="coding-rule-entity" data-testid="coding-rule-entity">
                  <SelectValue placeholder="Choose an entity…" />
                </SelectTrigger>
                <SelectContent>
                  {availableEntities.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="coding-rule-location">Default Location</Label>
              <Select value={location} onValueChange={setLocation}>
                <SelectTrigger id="coding-rule-location" data-testid="coding-rule-location">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_LOCATION}>— None —</SelectItem>
                  {LOCATIONS.map((loc) => (
                    <SelectItem key={loc} value={loc}>
                      {loc}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="coding-rule-class">Default Class</Label>
              <Input
                id="coding-rule-class"
                data-testid="coding-rule-class"
                value={revenueClass}
                onChange={(e) => setRevenueClass(e.target.value)}
                placeholder="(optional)"
                autoComplete="off"
              />
            </div>
            <div className="flex items-center gap-2 pb-2 sm:pt-6">
              <Switch
                id="coding-rule-force"
                data-testid="coding-rule-force"
                checked={forceRestricted}
                onCheckedChange={setForceRestricted}
              />
              <Label htmlFor="coding-rule-force" className="cursor-pointer">
                Force restricted
              </Label>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="coding-rule-notes">Notes</Label>
            <Input
              id="coding-rule-notes"
              data-testid="coding-rule-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="(optional)"
              autoComplete="off"
            />
          </div>
          <Button type="submit" disabled={!canSubmit} data-testid="coding-rule-submit">
            {create.isPending ? "Adding…" : "Add rule"}
          </Button>
        </form>

        <EntityCodingRulesTable
          rules={rules}
          loading={rulesQ.isLoading}
          entityName={entityName}
          onToggleEnabled={(r) =>
            update.mutate({ id: r.entityId, data: { enabled: !r.enabled } })
          }
          onToggleForce={(r) =>
            update.mutate({
              id: r.entityId,
              data: { forceRestricted: !r.forceRestricted },
            })
          }
          onDelete={(r) => del.mutate({ id: r.entityId })}
        />
      </CardContent>
    </Card>
  );
}

function EntityCodingRulesTable({
  rules,
  loading,
  entityName,
  onToggleEnabled,
  onToggleForce,
  onDelete,
}: {
  rules: EntityCodingRule[];
  loading: boolean;
  entityName: (id: string) => string;
  onToggleEnabled: (r: EntityCodingRule) => void;
  onToggleForce: (r: EntityCodingRule) => void;
  onDelete: (r: EntityCodingRule) => void;
}) {
  const sorted = useMemo(() => {
    const copy = [...rules];
    copy.sort((a, b) => entityName(a.entityId).localeCompare(entityName(b.entityId)));
    return copy;
  }, [rules, entityName]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading rules…</p>;
  }
  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground">No coding rules yet.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Entity</TableHead>
          <TableHead>Force restricted</TableHead>
          <TableHead>Location</TableHead>
          <TableHead>Class</TableHead>
          <TableHead>Notes</TableHead>
          <TableHead>Enabled</TableHead>
          <TableHead className="w-0" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((r) => (
          <TableRow key={r.entityId} data-testid={`coding-rule-row-${r.entityId}`}>
            <TableCell className="font-medium">{entityName(r.entityId)}</TableCell>
            <TableCell>
              <Switch
                checked={r.forceRestricted}
                onCheckedChange={() => onToggleForce(r)}
                data-testid={`coding-rule-force-${r.entityId}`}
              />
            </TableCell>
            <TableCell>{r.location ?? "—"}</TableCell>
            <TableCell>{r.revenueClass ?? "—"}</TableCell>
            <TableCell className="max-w-[16rem] truncate text-muted-foreground">
              {r.notes ?? "—"}
            </TableCell>
            <TableCell>
              <Switch
                checked={r.enabled}
                onCheckedChange={() => onToggleEnabled(r)}
                data-testid={`coding-rule-enabled-${r.entityId}`}
              />
            </TableCell>
            <TableCell>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDelete(r)}
                data-testid={`coding-rule-delete-${r.entityId}`}
              >
                Delete
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
