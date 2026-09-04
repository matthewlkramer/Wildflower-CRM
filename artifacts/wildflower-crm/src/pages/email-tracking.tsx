import { useState } from "react";
import { Link } from "wouter";
import {
  useGetTrackedEmail,
  getGetTrackedEmailQueryKey,
  useGetCurrentUser,
  useListTrackedOutboundQueue,
  getListTrackedOutboundQueueQueryKey,
  useListTrackedInboundQueue,
  getListTrackedInboundQueueQueryKey,
  useResolveEmailTrackingQueueItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { decodeHtmlEntities } from "@/lib/format";
import { EmailDetailDialog as SyncedEmailDetailDialog } from "@/components/email-detail-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  CheckCircle2,
  Clock3,
  Eye,
  EyeOff,
  Inbox,
  MailOpen,
  Reply,
  Send,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";

/**
 * Lightweight UA parser — we don't enrich server-side (no ipinfo
 * lookup), so do the minimum needed to make the views log readable.
 */
function parseUA(ua: string | null | undefined): { browser: string; os: string } {
  if (!ua) return { browser: "Unknown", os: "Unknown" };
  let browser = "Unknown";
  if (ua.includes("Edg/")) browser = "Edge";
  else if (ua.includes("Firefox/")) browser = "Firefox";
  else if (ua.includes("Chrome/")) browser = "Chrome";
  else if (ua.includes("Safari/")) browser = "Safari";
  else if (ua.includes("GoogleImageProxy")) browser = "Gmail proxy";

  let os = "Unknown";
  if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("Mac OS")) os = "macOS";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";
  else if (ua.includes("Linux")) os = "Linux";
  return { browser, os };
}

function EmailDetailDialog({
  id,
  onClose,
}: {
  id: string | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useGetTrackedEmail(id ?? "", {
    query: {
      queryKey: getGetTrackedEmailQueryKey(id ?? ""),
      enabled: !!id,
    },
  });
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{data?.subject ? decodeHtmlEntities(data.subject) : "Tracked email"}</DialogTitle>
          <DialogDescription>
            {data
              ? `${data.totalViews} view${data.totalViews === 1 ? "" : "s"} · ${data.uniqueIps} unique IP${data.uniqueIps === 1 ? "" : "s"} · sent ${format(new Date(data.createdAt), "PPp")}`
              : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : !data ? (
          <div className="text-sm text-muted-foreground">Not found</div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs uppercase text-muted-foreground">
                  From
                </div>
                <div className="font-medium">{data.sender}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-muted-foreground">
                  To
                </div>
                <div className="font-medium break-all">{data.recipient}</div>
              </div>
            </div>

            {(data.recipientPersonIds.length > 0 ||
              data.recipientOrganizationIds.length > 0 ||
              data.recipientHouseholdIds.length > 0) && (
              <div>
                <div className="text-xs uppercase text-muted-foreground mb-1">
                  Linked CRM contacts
                </div>
                <div className="flex flex-wrap gap-2">
                  {data.recipientPersonIds.map((pid) => (
                    <Link key={pid} href={`/individuals/${pid}`}>
                      <Badge variant="secondary" className="cursor-pointer">
                        Person
                      </Badge>
                    </Link>
                  ))}
                  {data.recipientOrganizationIds.map((fid) => (
                    <Link key={fid} href={`/organizations/${fid}`}>
                      <Badge variant="secondary" className="cursor-pointer">
                        Organization
                      </Badge>
                    </Link>
                  ))}
                  {data.recipientHouseholdIds.map((hid) => (
                    <Link key={hid} href={`/households/${hid}`}>
                      <Badge variant="secondary" className="cursor-pointer">
                        Household
                      </Badge>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="text-xs uppercase text-muted-foreground mb-1">
                Open history ({data.views.length})
              </div>
              {data.views.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No opens yet.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Browser / OS</TableHead>
                      <TableHead>IP</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.views.map((v) => {
                      const ua = parseUA(v.userAgent);
                      return (
                        <TableRow key={v.id}>
                          <TableCell className="whitespace-nowrap">
                            {format(new Date(v.viewedAt), "PPp")}
                          </TableCell>
                          <TableCell>
                            {ua.browser} · {ua.os}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {v.ipAddress ?? "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function EmailTrackingPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useGetCurrentUser();
  const [allMailboxes, setAllMailboxes] = useState(false);
  const [openTrackedId, setOpenTrackedId] = useState<string | null>(null);
  const [openMessageId, setOpenMessageId] = useState<string | null>(null);
  const params = { allMailboxes };
  const outbound = useListTrackedOutboundQueue(params, {
    query: {
      queryKey: getListTrackedOutboundQueueQueryKey(params),
      refetchInterval: 15_000,
    },
  });
  const inbound = useListTrackedInboundQueue(params, {
    query: {
      queryKey: getListTrackedInboundQueueQueryKey(params),
      refetchInterval: 15_000,
    },
  });
  const resolveItem = useResolveEmailTrackingQueueItem({
    mutation: {
      onSuccess: (_data, variables) => {
        qc.invalidateQueries({
          queryKey:
            variables.queueType === "outbound"
              ? getListTrackedOutboundQueueQueryKey(params)
              : getListTrackedInboundQueueQueryKey(params),
        });
        toast({ title: "Marked resolved" });
      },
      onError: () => {
        toast({
          title: "Could not resolve email",
          description: "Please try again.",
          variant: "destructive",
        });
      },
    },
  });
  const outboundRows = outbound.data?.data ?? [];
  const inboundRows = inbound.data?.data ?? [];
  const isAdmin = me?.role === "admin";
  const showMailbox = isAdmin && allMailboxes;

  const resolve = (
    queueType: "outbound" | "inbound",
    id: string,
  ) => {
    resolveItem.mutate({ queueType, id });
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Email tracking</h1>
          <p className="text-sm text-muted-foreground">
            Follow up on recent outreach and messages waiting for a reply.
          </p>
        </div>
        {isAdmin ? (
          <div className="flex items-center gap-2 rounded-md border px-3 py-2">
            <Switch
              id="all-mailboxes"
              checked={allMailboxes}
              onCheckedChange={setAllMailboxes}
            />
            <Label htmlFor="all-mailboxes">All mailboxes</Label>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Send className="h-4 w-4" /> Recent outbound
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">{outboundRows.length}</div>
            <p className="text-xs text-muted-foreground">last 14 days</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Inbox className="h-4 w-4" /> Waiting for reply
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">{inboundRows.length}</div>
            <p className="text-xs text-muted-foreground">at least 24 hours old</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <MailOpen className="h-4 w-4" /> Observed opens
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">
              {outboundRows.reduce((sum, row) => sum + row.totalViews, 0)}
            </div>
            <p className="text-xs text-muted-foreground">across recent outbound</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" /> Outbound
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Tracked messages sent to CRM contacts in the last 14 days.
          </p>
        </CardHeader>
        <CardContent>
          {outbound.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : outbound.isError ? (
            <div className="text-sm text-destructive">
              Could not load outbound email.
            </div>
          ) : outboundRows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No unresolved tracked messages from the last 14 days.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Open status</TableHead>
                  <TableHead>Reply</TableHead>
                  {showMailbox ? <TableHead>Mailbox</TableHead> : null}
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outboundRows.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => setOpenTrackedId(r.id)}
                  >
                    <TableCell className="font-medium max-w-xs truncate">
                      {decodeHtmlEntities(r.subject)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                      {r.recipient}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {formatDistanceToNow(new Date(r.sentAt), {
                        addSuffix: true,
                      })}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          r.totalViews > 0 ? "default" : "secondary"
                        }
                        className="gap-1"
                      >
                        {r.totalViews > 0 ? (
                          <Eye className="h-3 w-3" />
                        ) : (
                          <EyeOff className="h-3 w-3" />
                        )}
                        {r.totalViews > 0
                          ? `Opened ${r.totalViews}×`
                          : "Not observed"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.laterReply ? "default" : "outline"}>
                        {r.laterReply ? (
                          <Reply className="mr-1 h-3 w-3" />
                        ) : (
                          <Clock3 className="mr-1 h-3 w-3" />
                        )}
                        {r.laterReply ? "Replied" : "No reply"}
                      </Badge>
                    </TableCell>
                    {showMailbox ? (
                      <TableCell className="text-sm">
                        {r.mailboxUserName ?? r.sender}
                      </TableCell>
                    ) : null}
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={
                          resolveItem.isPending &&
                          resolveItem.variables?.id === r.id
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          resolve("outbound", r.id);
                        }}
                      >
                        <CheckCircle2 className="mr-1 h-4 w-4" />
                        Resolve
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Inbox className="h-5 w-5" /> Inbound
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Messages from an email address on a CRM contact, at least 24 hours
            old without a later sent reply in the same Gmail thread. Automatic
            replies and bulk or computer-generated messages are excluded.
          </p>
        </CardHeader>
        <CardContent>
          {inbound.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : inbound.isError ? (
            <div className="text-sm text-destructive">
              Could not load inbound email.
            </div>
          ) : inboundRows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No unresolved incoming messages are waiting for a reply.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Received</TableHead>
                  {showMailbox ? <TableHead>Mailbox</TableHead> : null}
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inboundRows.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => setOpenMessageId(r.id)}
                  >
                    <TableCell className="max-w-md">
                      <div className="font-medium truncate">
                        {r.subject
                          ? decodeHtmlEntities(r.subject)
                          : "(no subject)"}
                      </div>
                      {r.snippet ? (
                        <div className="text-xs text-muted-foreground truncate">
                          {decodeHtmlEntities(r.snippet)}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.fromEmail ?? "Unknown sender"}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {formatDistanceToNow(new Date(r.receivedAt), {
                        addSuffix: true,
                      })}
                    </TableCell>
                    {showMailbox ? (
                      <TableCell className="text-sm">
                        {r.mailboxUserName ?? "Unknown mailbox"}
                      </TableCell>
                    ) : null}
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={
                          resolveItem.isPending &&
                          resolveItem.variables?.id === r.id
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          resolve("inbound", r.id);
                        }}
                      >
                        <CheckCircle2 className="mr-1 h-4 w-4" />
                        Resolve
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <EmailDetailDialog
        id={openTrackedId}
        onClose={() => setOpenTrackedId(null)}
      />
      <SyncedEmailDetailDialog
        emailId={openMessageId}
        onClose={() => setOpenMessageId(null)}
      />
    </div>
  );
}
