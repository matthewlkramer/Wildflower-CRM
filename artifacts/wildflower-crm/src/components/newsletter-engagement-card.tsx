import {
  useListPersonNewsletterEngagement,
  type PersonNewsletterEngagement,
} from "@workspace/api-client-react";
import { RelatedCard } from "@/components/record-layout";
import { formatDateShort } from "@/lib/format";
import { MailOpen, MousePointerClick } from "lucide-react";

export function NewsletterEngagementCard({ personId }: { personId: string }) {
  const query = useListPersonNewsletterEngagement(personId, {
    limit: 100,
    page: 1,
  });
  const rows = query.data?.data ?? [];
  const total = query.data?.pagination.total ?? 0;

  return (
    <RelatedCard
      title="Newsletter history"
      count={query.isLoading ? undefined : total}
    >
      {query.isLoading ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
      ) : query.isError ? (
        <p className="px-2 py-2 text-sm text-destructive">
          Newsletter history could not be loaded.
        </p>
      ) : rows.length === 0 ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">
          No imported campaign history is linked to this person.
        </p>
      ) : (
        <div data-testid={`newsletter-history-${personId}`}>
          {rows.map((row) => (
            <CampaignRow
              key={`${row.campaignId}-${row.email}`}
              engagement={row}
            />
          ))}
          {total > rows.length ? (
            <p className="px-2 pt-2 text-xs text-muted-foreground">
              Showing the 100 most recent deliveries.
            </p>
          ) : null}
        </div>
      )}
    </RelatedCard>
  );
}

function CampaignRow({
  engagement,
}: {
  engagement: PersonNewsletterEngagement;
}) {
  const title = engagement.previewUrl ? (
    <a
      href={engagement.previewUrl}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-primary hover:underline"
    >
      {engagement.campaignSubject}
    </a>
  ) : (
    <span className="font-medium">{engagement.campaignSubject}</span>
  );

  return (
    <div className="border-b px-2 py-2.5 last:border-b-0">
      <div className="text-sm leading-snug">{title}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {formatDateShort(engagement.sentAt)} · {engagement.email}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <MailOpen className="h-3.5 w-3.5" />
          {engagement.opened
            ? `${engagement.totalOpens || 1} ${engagement.totalOpens === 1 ? "open" : "opens"}`
            : "Not opened"}
        </span>
        <span className="inline-flex items-center gap-1">
          <MousePointerClick className="h-3.5 w-3.5" />
          {engagement.clicked
            ? `${engagement.totalClicks || 1} ${engagement.totalClicks === 1 ? "click" : "clicks"}`
            : "No clicks"}
        </span>
      </div>
    </div>
  );
}
