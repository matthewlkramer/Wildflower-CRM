import {
  useGetGoogleSyncStatus,
  getGetGoogleSyncStatusQueryKey,
  type GoogleSyncStatusGmailCounts,
  type GoogleSyncStatusCalendarCounts,
  type GoogleSyncDateRange,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

// Read-only sync health panel for the caller's own mailbox/calendar. Surfaces
// the coverage window, matched/skipped/reviewed counts (this calendar year),
// and last-sync timestamp so users can troubleshoot gaps in their feed.
export default function GoogleSyncStatusSection() {
  const statusQ = useGetGoogleSyncStatus({
    query: {
      queryKey: getGetGoogleSyncStatusQueryKey(),
      refetchOnWindowFocus: true,
    },
  });

  const data = statusQ.data;

  return (
    <Card data-testid="google-sync-status-section">
      <CardHeader>
        <CardTitle>Sync status</CardTitle>
        <CardDescription>
          A read-only health check of your Gmail &amp; Calendar sync. Counts and
          the synced date range below reflect your full inbox history. Use this
          to spot gaps if emails or meetings stop appearing on contact pages.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {statusQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : statusQ.isError ? (
          <p className="text-sm text-red-700">
            Couldn't load sync status. Try refreshing the page.
          </p>
        ) : !data?.gmail && !data?.calendar ? (
          <p className="text-sm text-muted-foreground">
            No sync has run yet. Connect your Google account above — sync starts
            on the next cycle and stats will appear here.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <SourcePanel
              title="Gmail"
              testId="sync-status-gmail"
              lastSyncedAt={data?.gmail?.lastSyncedAt ?? null}
              lastError={data?.gmail?.lastError ?? null}
              bootstrapInProgress={data?.gmail?.bootstrapInProgress ?? false}
              counts={data?.gmail?.counts}
              dateRange={data?.gmail?.dateRange}
              reviewedLabel="emails reviewed"
              emptyText="No emails synced yet."
            />
            <SourcePanel
              title="Calendar"
              testId="sync-status-calendar"
              lastSyncedAt={data?.calendar?.lastSyncedAt ?? null}
              lastError={data?.calendar?.lastError ?? null}
              bootstrapInProgress={data?.calendar?.bootstrapInProgress ?? false}
              counts={data?.calendar?.counts}
              dateRange={data?.calendar?.dateRange}
              reviewedLabel="meetings reviewed"
              emptyText="No meetings synced yet."
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SourcePanel({
  title,
  testId,
  lastSyncedAt,
  lastError,
  bootstrapInProgress,
  counts,
  dateRange,
  reviewedLabel,
  emptyText,
}: {
  title: string;
  testId: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  bootstrapInProgress: boolean;
  counts?: GoogleSyncStatusGmailCounts | GoogleSyncStatusCalendarCounts;
  dateRange?: GoogleSyncDateRange;
  reviewedLabel: string;
  emptyText: string;
}) {
  const connected = lastSyncedAt != null || counts != null;
  return (
    <div
      className="rounded-md border p-4 space-y-3"
      data-testid={testId}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        {bootstrapInProgress ? (
          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
            Initial sync in progress
          </span>
        ) : null}
      </div>

      {!connected ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Reviewed" value={counts?.reviewed} />
            <Stat label="Matched" value={counts?.matched} />
            <Stat
              label="Skipped"
              value={counts?.skipped}
              fallback="N/A"
            />
          </div>

          <dl className="space-y-1 text-sm">
            <Row label="Synced date range">
              {fmtRange(dateRange?.earliest, dateRange?.latest)}
            </Row>
            <Row label="Last sync">
              {lastSyncedAt ? fmtDateTime(lastSyncedAt) : "—"}
            </Row>
          </dl>

          <p className="text-xs text-muted-foreground">
            {reviewedLabel} total.
          </p>

          {lastError ? (
            <p className="text-xs text-red-700">Last error: {lastError}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  fallback = "0",
}: {
  label: string;
  value: number | null | undefined;
  fallback?: string;
}) {
  return (
    <div className="rounded-md bg-muted/40 px-2 py-2">
      <div className="text-lg font-semibold tabular-nums">
        {value == null ? fallback : value.toLocaleString()}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtRange(
  earliest: string | null | undefined,
  latest: string | null | undefined,
): string {
  if (!earliest || !latest) return "—";
  const a = fmtDate(earliest);
  const b = fmtDate(latest);
  return a === b ? a : `${a} – ${b}`;
}
