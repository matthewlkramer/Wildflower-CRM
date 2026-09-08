import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetNewsletterOverviewQueryKey,
  getListNewsletterEngagementQueryKey,
  useGetNewsletterOverview,
  useListNewsletterEngagement,
  type NewsletterImportResult,
  type NewsletterCampaign,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useToast } from "@/hooks/use-toast";
import {
  BarChart3,
  Check,
  Link2,
  Mail,
  MousePointerClick,
  Upload,
} from "lucide-react";

const EMPTY_CAMPAIGNS: NewsletterCampaign[] = [];

type NewsletterImportReviewResult = NewsletterImportResult & {
  operationalRecordsChanged: boolean;
  subscriptionDifferences: {
    total: number;
    examples: Array<{
      personId: string;
      personName: string;
      email: string;
      flodeskStatus: "subscribed" | "unsubscribed";
      crmStatus: "subscribed" | "unsubscribed" | "not_subscribed";
    }>;
  };
  emailDifferences: {
    total: number;
    examples: Array<{
      personId: string;
      personName: string;
      flodeskEmail: string;
      crmEmails: string[];
      matchBasis: "exact_name";
    }>;
  };
};

function statusLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "—"
    : `${Math.round(value * 100)}%`;
}

function campaignDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function recordHref(
  type: string | null | undefined,
  id: string | null | undefined,
): string | null {
  if (!type || !id) return null;
  if (type === "person") return `/individuals/${id}`;
  if (type === "organization") return `/organizations/${id}`;
  if (type === "household") return `/households/${id}`;
  if (type === "payment_intermediary") return `/payment-intermediaries/${id}`;
  return null;
}

function MetricCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof Mail;
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className="mt-1 text-2xl font-semibold">
            {value.toLocaleString()}
          </p>
        </div>
        <Icon className="h-5 w-5 text-primary" />
      </CardContent>
    </Card>
  );
}

export default function NewsletterPage() {
  const isAdmin = useIsAdmin();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [search, setSearch] = useState("");
  const [engagementFilter, setEngagementFilter] = useState("all");
  const [linkFilter, setLinkFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [lastImport, setLastImport] =
    useState<NewsletterImportReviewResult | null>(null);

  const overview = useGetNewsletterOverview();
  const campaigns = overview.data?.campaigns ?? EMPTY_CAMPAIGNS;
  const deferredSearch = useDeferredValue(search);
  useEffect(() => {
    if (!selectedCampaignId && campaigns.length > 0) {
      setSelectedCampaignId(
        campaigns.find((campaign) => campaign.trackedRecipientCount > 0)?.id ??
          campaigns[0].id,
      );
    }
  }, [campaigns, selectedCampaignId]);

  const selectedCampaign = useMemo(
    () =>
      campaigns.find((campaign) => campaign.id === selectedCampaignId) ?? null,
    [campaigns, selectedCampaignId],
  );
  const engagementParams = {
    search: deferredSearch.trim() || undefined,
    opened:
      engagementFilter === "opened"
        ? true
        : engagementFilter === "not-opened"
          ? false
          : undefined,
    clicked:
      engagementFilter === "clicked"
        ? true
        : engagementFilter === "not-clicked"
          ? false
          : undefined,
    linked:
      linkFilter === "linked"
        ? true
        : linkFilter === "unmatched"
          ? false
          : undefined,
    limit: 100,
    page,
  };
  const engagement = useListNewsletterEngagement(
    selectedCampaignId,
    engagementParams,
    {
      query: {
        enabled: !!selectedCampaignId,
        queryKey: getListNewsletterEngagementQueryKey(
          selectedCampaignId,
          engagementParams,
        ),
      },
    },
  );

  async function uploadWorkbook(file: File | null | undefined) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      toast({ title: "Choose an .xlsx workbook", variant: "destructive" });
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      toast({
        title: "Workbook is too large",
        description: "The maximum size is 25 MB.",
        variant: "destructive",
      });
      return;
    }
    setUploading(true);
    try {
      const response = await fetch("/api/newsletter-imports/spreadsheet", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
        body: file,
      });
      const body = (await response.json()) as
        | NewsletterImportReviewResult
        | { message?: string };
      if (!response.ok) {
        throw new Error(
          "message" in body && body.message
            ? body.message
            : "The workbook could not be imported.",
        );
      }
      const result = body as NewsletterImportReviewResult;
      setLastImport(result);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getGetNewsletterOverviewQueryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: getListNewsletterEngagementQueryKey(selectedCampaignId),
        }),
      ]);
      toast({
        title: "Newsletter engagement history imported",
        description: `${result.engagementRecords.toLocaleString()} engagement records are now available. CRM subscription and email fields were not changed.`,
      });
    } catch (error) {
      toast({
        title: "Import failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const audience = overview.data?.audience;
  const totalPages = Math.max(
    1,
    Math.ceil((engagement.data?.pagination.total ?? 0) / 100),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Mail className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-3xl font-serif font-bold">
              Newsletter engagement
            </h1>
            <p className="text-sm text-muted-foreground">
              Flodesk audience history, campaign performance, opens, and clicks.
            </p>
          </div>
        </div>
        {isAdmin ? (
          <>
            <Button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              <Upload className="mr-2 h-4 w-4" />
              {uploading ? "Importing…" : "Import Flodesk workbook"}
            </Button>
            <input
              ref={fileRef}
              className="hidden"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => void uploadWorkbook(event.target.files?.[0])}
              data-testid="input-newsletter-workbook"
            />
          </>
        ) : null}
      </div>

      {overview.isLoading ? (
        <p className="text-sm text-muted-foreground">
          Loading newsletter history…
        </p>
      ) : overview.isError ? (
        <Card>
          <CardContent className="p-5 text-sm text-destructive">
            Newsletter history could not be loaded.
          </CardContent>
        </Card>
      ) : !audience ? null : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Current subscribers"
            value={audience.currentSubscribers}
            icon={Mail}
          />
          <MetricCard
            label="Linked to CRM"
            value={audience.linkedCurrentSubscribers}
            icon={Link2}
          />
          <MetricCard
            label="Unmatched subscribers"
            value={audience.unmatchedCurrentSubscribers}
            icon={BarChart3}
          />
          <MetricCard
            label="Unsubscribe evidence"
            value={audience.unsubscribeEvidence}
            icon={MousePointerClick}
          />
        </div>
      )}

      {lastImport ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Review CRM differences</CardTitle>
            <p className="text-sm text-muted-foreground">
              The engagement history was imported. No CRM subscription status,
              email address, or email validity was changed.
            </p>
          </CardHeader>
          <CardContent className="grid gap-6 xl:grid-cols-2">
            <div className="space-y-3">
              <div>
                <h2 className="font-medium">Subscription status differences</h2>
                <p className="text-sm text-muted-foreground">
                  {lastImport.subscriptionDifferences.total.toLocaleString()}{" "}
                  exact email matches have different Flodesk and CRM statuses.
                </p>
              </div>
              {lastImport.subscriptionDifferences.examples.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No differences found.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Person</TableHead>
                        <TableHead>Flodesk</TableHead>
                        <TableHead>CRM</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lastImport.subscriptionDifferences.examples.map(
                        (row) => (
                          <TableRow key={`${row.personId}-${row.email}`}>
                            <TableCell>
                              <Link
                                href={`/individuals/${row.personId}`}
                                className="font-medium text-primary hover:underline"
                              >
                                {row.personName}
                              </Link>
                              <div className="text-xs text-muted-foreground">
                                {row.email}
                              </div>
                            </TableCell>
                            <TableCell className="capitalize">
                              {statusLabel(row.flodeskStatus)}
                            </TableCell>
                            <TableCell className="capitalize">
                              {statusLabel(row.crmStatus)}
                            </TableCell>
                          </TableRow>
                        ),
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div>
                <h2 className="font-medium">Possible email differences</h2>
                <p className="text-sm text-muted-foreground">
                  {lastImport.emailDifferences.total.toLocaleString()} unmatched
                  Flodesk addresses have one unambiguous exact-name CRM match.
                </p>
              </div>
              {lastImport.emailDifferences.examples.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No likely differences found.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Person</TableHead>
                        <TableHead>Flodesk email</TableHead>
                        <TableHead>CRM email</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lastImport.emailDifferences.examples.map((row) => (
                        <TableRow key={`${row.personId}-${row.flodeskEmail}`}>
                          <TableCell>
                            <Link
                              href={`/individuals/${row.personId}`}
                              className="font-medium text-primary hover:underline"
                            >
                              {row.personName}
                            </Link>
                          </TableCell>
                          <TableCell>{row.flodeskEmail}</TableCell>
                          <TableCell>{row.crmEmails.join(", ")}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[330px_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Campaign history</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {campaigns.map((campaign) => (
              <button
                key={campaign.id}
                type="button"
                onClick={() => {
                  setSelectedCampaignId(campaign.id);
                  setPage(1);
                }}
                aria-pressed={campaign.id === selectedCampaignId}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                  campaign.id === selectedCampaignId
                    ? "border-primary bg-primary/5"
                    : "hover:bg-muted/60"
                }`}
              >
                <div className="text-xs text-muted-foreground">
                  {campaignDate(campaign.sentAt)}
                </div>
                <div className="mt-1 text-sm font-medium leading-snug">
                  {campaign.subject}
                </div>
                <div className="mt-2 flex gap-2 text-xs text-muted-foreground">
                  <span>{percent(campaign.openRate)} opened</span>
                  <span>·</span>
                  <span>{percent(campaign.clickRate)} clicked</span>
                </div>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="space-y-4">
            <div>
              <CardTitle className="text-lg">
                {selectedCampaign?.subject ?? "Recipient engagement"}
              </CardTitle>
              {selectedCampaign ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  {campaignDate(selectedCampaign.sentAt)} ·{" "}
                  {selectedCampaign.trackedRecipientCount.toLocaleString()}{" "}
                  imported recipient records ·{" "}
                  {selectedCampaign.linkedCount.toLocaleString()} linked to the
                  CRM
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                placeholder="Search name or email…"
                className="min-w-[220px] flex-1"
              />
              <Select
                value={engagementFilter}
                onValueChange={(value) => {
                  setEngagementFilter(value);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All activity</SelectItem>
                  <SelectItem value="opened">Opened</SelectItem>
                  <SelectItem value="not-opened">Not opened</SelectItem>
                  <SelectItem value="clicked">Clicked</SelectItem>
                  <SelectItem value="not-clicked">Not clicked</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={linkFilter}
                onValueChange={(value) => {
                  setLinkFilter(value);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-[155px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All matches</SelectItem>
                  <SelectItem value="linked">Linked to CRM</SelectItem>
                  <SelectItem value="unmatched">Unmatched</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {!selectedCampaignId || engagement.isLoading ? (
              <p className="text-sm text-muted-foreground">
                Loading recipients…
              </p>
            ) : engagement.isError ? (
              <p className="text-sm text-destructive">
                Recipient history could not be loaded.
              </p>
            ) : (engagement.data?.data.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">
                No recipient-level rows were included for this campaign. The
                aggregate campaign rates are still preserved.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Recipient</TableHead>
                        <TableHead>CRM match</TableHead>
                        <TableHead>Opened</TableHead>
                        <TableHead>Clicked</TableHead>
                        <TableHead>Last activity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {engagement.data?.data.map((row) => {
                        const href = recordHref(
                          row.linkedRecordType,
                          row.linkedRecordId,
                        );
                        const lastActivity =
                          row.lastClickedAt ?? row.lastOpenedAt;
                        return (
                          <TableRow key={`${row.campaignId}-${row.email}`}>
                            <TableCell>
                              <div className="font-medium">
                                {[row.firstName, row.lastName]
                                  .filter(Boolean)
                                  .join(" ") || "—"}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {row.email}
                              </div>
                            </TableCell>
                            <TableCell>
                              {href ? (
                                <Link
                                  href={href}
                                  className="text-sm text-primary hover:underline"
                                >
                                  {row.linkedRecordName || "Open CRM record"}
                                </Link>
                              ) : (
                                <Badge variant="outline">Unmatched</Badge>
                              )}
                            </TableCell>
                            <TableCell>
                              {row.opened ? (
                                <Badge className="gap-1">
                                  <Check className="h-3 w-3" />{" "}
                                  {row.totalOpens || 1}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              {row.clicked ? (
                                <Badge variant="secondary">
                                  {row.totalClicks || 1}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {lastActivity
                                ? new Date(lastActivity).toLocaleString()
                                : "—"}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                <div className="mt-3 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {(engagement.data?.pagination.total ?? 0).toLocaleString()}{" "}
                    results
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => setPage((value) => value - 1)}
                    >
                      Previous
                    </Button>
                    <span>
                      Page {page} of {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages}
                      onClick={() => setPage((value) => value + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
