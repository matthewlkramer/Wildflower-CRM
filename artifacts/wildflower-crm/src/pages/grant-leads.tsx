import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListGrantLeads,
  useClaimGrantLead,
  useAssignGrantLead,
  useArchiveGrantLead,
  useConvertGrantLead,
  getListGrantLeadsQueryKey,
} from "@workspace/api-client-react";
import { useUser } from "@clerk/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  EntityCombobox,
  useOrganizationSearch,
  usePersonSearch,
  useHouseholdSearch,
  useOrganizationName,
  usePersonName,
  useHouseholdName,
} from "@/components/entity-picker";
import { Lightbulb, MoreHorizontal, ExternalLink, Inbox, UserCheck, ClipboardList, ChevronDown, ChevronUp } from "lucide-react";
import type { GrantLead } from "@workspace/api-client-react";
import { TasksPanel, AddTaskDialog } from "@/components/tasks-panel";

type StatusFilter = "active" | "all" | "archived" | "converted";

const STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  new: { label: "New", variant: "secondary" },
  claimed: { label: "Claimed", variant: "default" },
  converted: { label: "Converted", variant: "outline" },
  archived: { label: "Archived", variant: "outline" },
};

function ConvertDialog({
  lead,
  open,
  onClose,
  onConverted,
}: {
  lead: GrantLead;
  open: boolean;
  onClose: () => void;
  onConverted: (opportunityId: string) => void;
}) {
  const { toast } = useToast();
  const convert = useConvertGrantLead();

  const [orgId, setOrgId] = useState<string | null>(lead.targetOrganizationId ?? null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [donorType, setDonorType] = useState<"organization" | "person" | "household">("organization");
  const [oppName, setOppName] = useState(lead.title);
  const [askAmount, setAskAmount] = useState(lead.amount ?? "");
  const [deadline, setDeadline] = useState(lead.deadline ?? "");

  const handleConvert = () => {
    const donorId = donorType === "organization" ? orgId : donorType === "person" ? personId : householdId;
    if (!donorId) {
      toast({ title: "Select a donor", variant: "destructive" });
      return;
    }
    convert.mutate(
      {
        id: lead.id,
        data: {
          organizationId: donorType === "organization" ? (orgId ?? undefined) : undefined,
          individualGiverPersonId: donorType === "person" ? (personId ?? undefined) : undefined,
          householdId: donorType === "household" ? (householdId ?? undefined) : undefined,
          name: oppName || undefined,
          askAmount: askAmount || undefined,
          applicationDeadline: deadline || undefined,
        },
      },
      {
        onSuccess: (data) => {
          toast({ title: "Opportunity created" });
          onConverted(data.opportunity.id as string);
          onClose();
        },
        onError: () => {
          toast({ title: "Failed to convert lead", variant: "destructive" });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Convert to Opportunity</DialogTitle>
          <DialogDescription>
            Create a cold-lead opportunity from "{lead.title}".
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Opportunity name</Label>
            <Input value={oppName} onChange={(e) => setOppName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Donor type</Label>
            <div className="flex gap-2">
              {(["organization", "person", "household"] as const).map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={donorType === t ? "default" : "outline"}
                  onClick={() => setDonorType(t)}
                  type="button"
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Donor</Label>
            {donorType === "organization" && (
              <EntityCombobox
                value={orgId}
                onChange={setOrgId}
                placeholder="Search organizations…"
                useSearch={useOrganizationSearch}
                useResolve={useOrganizationName}
                allowNull
              />
            )}
            {donorType === "person" && (
              <EntityCombobox
                value={personId}
                onChange={setPersonId}
                placeholder="Search people…"
                useSearch={usePersonSearch}
                useResolve={usePersonName}
                allowNull
              />
            )}
            {donorType === "household" && (
              <EntityCombobox
                value={householdId}
                onChange={setHouseholdId}
                placeholder="Search households…"
                useSearch={useHouseholdSearch}
                useResolve={useHouseholdName}
                allowNull
              />
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Ask amount</Label>
              <Input
                value={askAmount}
                onChange={(e) => setAskAmount(e.target.value)}
                placeholder="e.g. 50000"
              />
            </div>
            <div className="space-y-2">
              <Label>Deadline</Label>
              <Input
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                placeholder="YYYY-MM-DD"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleConvert} disabled={convert.isPending}>
            {convert.isPending ? "Creating…" : "Create opportunity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GrantLeadRow({ lead, onRefresh }: { lead: GrantLead; onRefresh: () => void }) {
  const { user } = useUser();
  const { toast } = useToast();
  const qc = useQueryClient();

  const claim = useClaimGrantLead();
  const archive = useArchiveGrantLead();
  const [convertOpen, setConvertOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);

  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ["/api/grant-leads"] });

  const handleClaim = () => {
    claim.mutate(
      { id: lead.id },
      {
        onSuccess: () => { toast({ title: "Lead claimed" }); invalidate(); onRefresh(); },
        onError: () => toast({ title: "Failed to claim lead", variant: "destructive" }),
      },
    );
  };

  const handleArchive = () => {
    archive.mutate(
      { id: lead.id },
      {
        onSuccess: () => { toast({ title: "Lead archived" }); invalidate(); onRefresh(); },
        onError: () => toast({ title: "Failed to archive lead", variant: "destructive" }),
      },
    );
  };

  const isActive = lead.status === "new" || lead.status === "claimed";
  const statusInfo = STATUS_LABELS[lead.status] ?? { label: lead.status, variant: "outline" as const };

  return (
    <>
      <div className="flex items-start gap-3 rounded-lg border bg-card p-4 hover:bg-muted/30 transition-colors">
        <Lightbulb className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />

        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-0.5">
              <p className="font-medium text-sm leading-snug">{lead.title}</p>
              {lead.funderName && (
                <p className="text-xs text-muted-foreground">{lead.funderName}</p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge variant={statusInfo.variant} className="text-xs">
                {statusInfo.label}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs text-muted-foreground"
                onClick={() => setTasksOpen((v) => !v)}
              >
                <ClipboardList className="h-3.5 w-3.5" />
                Tasks
                {tasksOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </Button>
              {isActive && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {lead.status === "new" && (
                      <DropdownMenuItem onClick={handleClaim} disabled={claim.isPending}>
                        <UserCheck className="h-4 w-4 mr-2" />
                        Claim
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => setConvertOpen(true)}>
                      Convert to opportunity
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setTasksOpen(true)}>
                      <ClipboardList className="h-4 w-4 mr-2" />
                      Add task
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={handleArchive}
                      disabled={archive.isPending}
                      className="text-destructive focus:text-destructive"
                    >
                      Archive
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {lead.deadline && <span>Due {lead.deadline}</span>}
            {lead.amount && <span>{lead.amount}</span>}
            {lead.targetOrganizationName && (
              <Link
                href={`/organizations/${lead.targetOrganizationId}`}
                className="text-primary hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {lead.targetOrganizationName}
              </Link>
            )}
            {lead.url && (
              <a
                href={lead.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3 w-3" />
                Link
              </a>
            )}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {(lead.sightingCount ?? 0) > 0 && (
              <span>
                {lead.sightingCount === 1 ? "1 inbox" : `${lead.sightingCount} inboxes`}
              </span>
            )}
            {lead.assigneeUserId && (
              <span className="flex items-center gap-1">
                <UserCheck className="h-3 w-3" />
                {lead.assigneeUserName ?? lead.assigneeUserId}
              </span>
            )}
            {lead.convertedOpportunityId && (
              <Link
                href={`/opportunities/${lead.convertedOpportunityId}`}
                className="text-primary hover:underline"
              >
                View opportunity →
              </Link>
            )}
          </div>

          {lead.snippet && (
            <p className="text-xs italic text-muted-foreground border-l-2 pl-2 mt-1 line-clamp-2">
              "{lead.snippet}"
            </p>
          )}

          {tasksOpen && (
            <div className="mt-3 pt-3 border-t">
              <TasksPanel grantLeadId={lead.id} />
            </div>
          )}
        </div>
      </div>

      {convertOpen && (
        <ConvertDialog
          lead={lead}
          open={convertOpen}
          onClose={() => setConvertOpen(false)}
          onConverted={() => { invalidate(); onRefresh(); }}
        />
      )}
    </>
  );
}

export default function GrantLeadsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [search, setSearch] = useState("");

  const params = {
    ...(statusFilter === "active" ? {} : statusFilter === "all" ? { includeArchived: true } : { status: statusFilter }),
    ...(search ? { search } : {}),
    limit: 100,
  };

  const { data, isLoading, isError } = useListGrantLeads(params, {
    query: {
      queryKey: getListGrantLeadsQueryKey(params),
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ["/api/grant-leads"] });

  const leads = data?.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Lightbulb className="h-6 w-6 text-amber-500" />
          Grant Leads
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Team-shared grant opportunity signals detected across all inboxes, deduped.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <TabsList>
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="converted">Converted</TabsTrigger>
            <TabsTrigger value="archived">Archived</TabsTrigger>
          </TabsList>
        </Tabs>
        <Input
          className="max-w-xs"
          placeholder="Search by title or funder…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {isLoading ? "Loading…" : `${leads.length} lead${leads.length === 1 ? "" : "s"}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isError ? (
            <div className="text-sm text-destructive">Failed to load grant leads.</div>
          ) : isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : leads.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
              <Inbox className="h-8 w-8" />
              <p className="text-sm">
                {statusFilter === "active"
                  ? "No active grant leads. Grant signals detected from team inboxes will appear here."
                  : "No grant leads found."}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {leads.map((lead) => (
                <GrantLeadRow key={lead.id} lead={lead} onRefresh={refresh} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
