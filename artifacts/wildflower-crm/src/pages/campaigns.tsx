import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFundraisingCampaigns,
  useCreateFundraisingCampaign,
  useUpdateFundraisingCampaign,
  useArchiveFundraisingCampaign,
  useUnarchiveFundraisingCampaign,
  getListFundraisingCampaignsQueryKey,
} from "@workspace/api-client-react";
import type {
  FundraisingCampaign,
  ListFundraisingCampaignsParams,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// Campaign slug: lowercase letters, digits, hyphens; must start with letter/digit.
// Mirrors server-side CAMPAIGN_SLUG_RE.
const CAMPAIGN_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Campaigns() {
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showArchived, setShowArchived] = usePersistedState<boolean>(
    "wf.list.campaigns.showArchived",
    false,
  );

  const listParams: ListFundraisingCampaignsParams | undefined =
    isAdmin && showArchived ? { includeArchived: true } : undefined;

  const campaignsQ = useListFundraisingCampaigns(listParams, {
    query: {
      queryKey: getListFundraisingCampaignsQueryKey(listParams),
      staleTime: 30_000,
    },
  });

  const campaigns = campaignsQ.data ?? [];

  const archiveMut = useArchiveFundraisingCampaign();
  const unarchiveMut = useUnarchiveFundraisingCampaign();

  const refreshList = () =>
    queryClient.invalidateQueries({ queryKey: getListFundraisingCampaignsQueryKey() });

  const archiveCampaign = (c: FundraisingCampaign) =>
    archiveMut.mutate(
      { slug: c.slug },
      {
        onSuccess: async () => {
          await refreshList();
          toast({ title: "Campaign archived" });
        },
        onError: (err: unknown) =>
          toast({
            title: "Archive failed",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );

  const unarchiveCampaign = (c: FundraisingCampaign) =>
    unarchiveMut.mutate(
      { slug: c.slug },
      {
        onSuccess: async () => {
          await refreshList();
          toast({ title: "Campaign unarchived" });
        },
        onError: (err: unknown) =>
          toast({
            title: "Unarchive failed",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );

  const sorted = [...campaigns].sort((a, b) => {
    const aArch = a.archivedAt ? 1 : 0;
    const bArch = b.archivedAt ? 1 : 0;
    if (aArch !== bArch) return aArch - bArch;
    return a.name.localeCompare(b.name);
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FundraisingCampaign | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (campaign: FundraisingCampaign) => {
    setEditing(campaign);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-8 max-w-6xl">
      <ListPageHeader
        title="Campaigns"
        subtitle="Fundraising campaigns link gifts to structured Donorbox or email campaign records."
        addAction={
          isAdmin ? (
            <AddIconButton
              label="Add campaign"
              onClick={openCreate}
              data-testid="add-campaign"
            />
          ) : undefined
        }
        controls={
          isAdmin ? (
            <ShowArchivedToggle
              value={showArchived}
              onChange={setShowArchived}
              testId="toggle-show-archived-campaigns"
            />
          ) : undefined
        }
      />

      <Card data-testid="campaigns-card">
        <CardHeader>
          <CardTitle>All campaigns</CardTitle>
          <CardDescription>
            Click a campaign to edit its details. Archived campaigns remain for
            historical gift attribution but are hidden from pickers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CampaignsTable
            campaigns={sorted}
            loading={campaignsQ.isLoading}
            isAdmin={isAdmin}
            onEdit={openEdit}
            onArchive={archiveCampaign}
            onUnarchive={unarchiveCampaign}
          />
        </CardContent>
      </Card>

      {isAdmin && (
        <CampaignFormDialog
          key={editing ? `edit-${editing.slug}` : "create"}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          campaign={editing}
        />
      )}
    </div>
  );
}

// ── Table ─────────────────────────────────────────────────────────────────────

function CampaignsTable({
  campaigns,
  loading,
  isAdmin,
  onEdit,
  onArchive,
  onUnarchive,
}: {
  campaigns: FundraisingCampaign[];
  loading: boolean;
  isAdmin: boolean;
  onEdit: (campaign: FundraisingCampaign) => void;
  onArchive: (campaign: FundraisingCampaign) => void;
  onUnarchive: (campaign: FundraisingCampaign) => void;
}) {
  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading campaigns…</p>;
  }
  if (campaigns.length === 0) {
    return <p className="text-sm text-muted-foreground">No campaigns yet. Add one to get started.</p>;
  }

  return (
    <Table data-testid="campaigns-table">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Slug</TableHead>
          <TableHead>Donorbox ID</TableHead>
          <TableHead>Email sent</TableHead>
          <TableHead className="w-[80px] text-right">Status</TableHead>
          <TableHead className="w-[100px] text-right">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {campaigns.map((c) => (
          <TableRow
            key={c.slug}
            data-testid={`campaign-row-${c.slug}`}
            className={c.archivedAt ? "opacity-60" : undefined}
          >
            <TableCell>
              {isAdmin ? (
                <button
                  type="button"
                  onClick={() => onEdit(c)}
                  className="text-left font-medium hover:underline underline-offset-2"
                  data-testid={`campaign-name-${c.slug}`}
                >
                  {c.name}
                </button>
              ) : (
                <span className="font-medium">{c.name}</span>
              )}
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {c.slug}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {c.donorboxCampaignId ?? "—"}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
              {formatDateTime(c.emailSentAt)}
            </TableCell>
            <TableCell className="text-right">
              {c.archivedAt ? (
                <Badge variant="outline" className="border-destructive/40 text-destructive text-xs">
                  Archived
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs">Active</Badge>
              )}
            </TableCell>
            <TableCell className="text-right">
              {isAdmin && (
                <RowActionIcons
                  entityLabel={c.name}
                  testIdPrefix={`campaign-${c.slug}`}
                  archived={!!c.archivedAt}
                  onEdit={() => onEdit(c)}
                  onArchive={
                    c.archivedAt
                      ? () => onUnarchive(c)
                      : () => onArchive(c)
                  }
                />
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── Create / edit dialog ──────────────────────────────────────────────────────

function CampaignFormDialog({
  open,
  onOpenChange,
  campaign,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaign: FundraisingCampaign | null;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isEdit = campaign !== null;

  const [slug, setSlug] = useState(campaign?.slug ?? "");
  const [name, setName] = useState(campaign?.name ?? "");
  const [donorboxCampaignId, setDonorboxCampaignId] = useState(
    campaign?.donorboxCampaignId ?? "",
  );
  const [emailSentAt, setEmailSentAt] = useState(
    campaign?.emailSentAt ? campaign.emailSentAt.slice(0, 10) : "",
  );

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: getListFundraisingCampaignsQueryKey() });
  };

  const create = useCreateFundraisingCampaign({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Campaign created" });
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

  const update = useUpdateFundraisingCampaign({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: "Campaign updated" });
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

  const slugError =
    !isEdit && slug !== "" && !CAMPAIGN_SLUG_RE.test(slug)
      ? "Use lowercase letters, digits, and hyphens only (e.g. spring-2024)."
      : null;

  const pending = create.isPending || update.isPending;
  const canSubmit =
    name.trim() !== "" &&
    (isEdit || (slug.trim() !== "" && !slugError)) &&
    !pending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const emailSentAtValue = emailSentAt.trim()
      ? new Date(`${emailSentAt}T12:00:00`).toISOString()
      : null;
    const donorboxValue = donorboxCampaignId.trim() === "" ? null : donorboxCampaignId.trim();

    if (isEdit) {
      update.mutate({
        slug: campaign.slug,
        data: {
          name: name.trim(),
          donorboxCampaignId: donorboxValue,
          emailSentAt: emailSentAtValue,
        },
      });
    } else {
      create.mutate({
        data: {
          slug: slug.trim(),
          name: name.trim(),
          donorboxCampaignId: donorboxValue,
          emailSentAt: emailSentAtValue,
        },
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="campaign-dialog">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit "${campaign.name}"` : "Add campaign"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this campaign's name and metadata."
              : "Create a new fundraising campaign. The slug is permanent and used on gift records."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4" data-testid="campaign-form">
          {!isEdit && (
            <div className="space-y-1">
              <Label htmlFor="campaign-slug">Slug</Label>
              <Input
                id="campaign-slug"
                data-testid="campaign-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="e.g. spring-2024"
                autoComplete="off"
                autoFocus
              />
              {slugError ? (
                <p className="text-xs text-destructive">{slugError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Lowercase letters, digits, and hyphens only. Permanent — choose carefully.
                </p>
              )}
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="campaign-name">Name</Label>
            <Input
              id="campaign-name"
              data-testid="campaign-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name"
              autoComplete="off"
              autoFocus={isEdit}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="campaign-donorbox-id">Donorbox campaign ID</Label>
            <Input
              id="campaign-donorbox-id"
              data-testid="campaign-donorbox-id"
              value={donorboxCampaignId}
              onChange={(e) => setDonorboxCampaignId(e.target.value)}
              placeholder="Numeric ID from Donorbox (optional)"
              autoComplete="off"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="campaign-email-sent-at">Email sent date</Label>
            <Input
              id="campaign-email-sent-at"
              data-testid="campaign-email-sent-at"
              type="date"
              value={emailSentAt}
              onChange={(e) => setEmailSentAt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Date the campaign fundraising email was sent (optional).
            </p>
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
            <Button type="submit" disabled={!canSubmit} data-testid="campaign-submit">
              {pending ? "Saving…" : isEdit ? "Save changes" : "Add campaign"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
