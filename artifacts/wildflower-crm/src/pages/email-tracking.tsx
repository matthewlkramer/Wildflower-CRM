import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useListTrackedEmails,
  useGetTrackedEmail,
  getGetTrackedEmailQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Eye, EyeOff, MailOpen, Send, Users } from "lucide-react";
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

function todayStartUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
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
          <DialogTitle>{data?.subject ?? "Tracked email"}</DialogTitle>
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
              data.recipientFunderIds.length > 0 ||
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
                  {data.recipientFunderIds.map((fid) => (
                    <Link key={fid} href={`/funding-entities/${fid}`}>
                      <Badge variant="secondary" className="cursor-pointer">
                        Funder
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
  const { data, isLoading } = useListTrackedEmails({ limit: 200 });
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = data?.data ?? [];

  const kpis = useMemo(() => {
    const todayStart = todayStartUtc().getTime();
    const sentToday = rows.filter(
      (r) => new Date(r.createdAt).getTime() >= todayStart,
    ).length;
    const opensToday = rows.filter(
      (r) =>
        r.lastView && new Date(r.lastView).getTime() >= todayStart,
    ).length;
    const totalOpens = rows.reduce((acc, r) => acc + (r.totalViews ?? 0), 0);
    return { sentToday, opensToday, totalOpens };
  }, [rows]);

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Email tracking</h1>
          <p className="text-sm text-muted-foreground">
            Open events from the Wildflower Tracking browser extension.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Send className="h-4 w-4" /> Tracked sends today
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">{kpis.sentToday}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <MailOpen className="h-4 w-4" /> Emails opened today
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">{kpis.opensToday}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="h-4 w-4" /> Total opens (last 200)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">{kpis.totalOpens}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent tracked sends</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No tracked emails yet. Install the Wildflower Tracking
              extension and send a message from Gmail to see it here.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead className="text-right">Opens</TableHead>
                  <TableHead>Last open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => setOpenId(r.id)}
                  >
                    <TableCell className="font-medium max-w-xs truncate">
                      {r.subject}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                      {r.recipient}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.sender}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {formatDistanceToNow(new Date(r.createdAt), {
                        addSuffix: true,
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant={
                          (r.totalViews ?? 0) > 0 ? "default" : "secondary"
                        }
                        className="gap-1"
                      >
                        {(r.totalViews ?? 0) > 0 ? (
                          <Eye className="h-3 w-3" />
                        ) : (
                          <EyeOff className="h-3 w-3" />
                        )}
                        {r.totalViews ?? 0}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {r.lastView
                        ? formatDistanceToNow(new Date(r.lastView), {
                            addSuffix: true,
                          })
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {rows.length > 0 && (
            <div className="mt-3">
              <Button variant="link" onClick={() => setOpenId(rows[0].id)}>
                Open most recent
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <EmailDetailDialog id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
