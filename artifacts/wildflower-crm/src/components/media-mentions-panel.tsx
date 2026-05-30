import {
  useUpdateMediaMention,
  useListMediaMentions,
  getListMediaMentionsQueryKey,
  type MediaMention,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ExternalLink, Newspaper, Pin } from "lucide-react";

/** Format a `YYYY-MM-DD` (or ISO) publication date without timezone drift. */
function formatPubDate(value?: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * Clickable pin toggle — outline when unpinned, amber-filled when pinned.
 * Mirrors the priority-star affordance but is interactive: it PATCHes the
 * mention's `pinned` flag and invalidates every media-mention list so the
 * activity feed and the "Pinned media" card stay in sync.
 */
export function MediaPinButton({
  id,
  pinned,
  size = "md",
}: {
  id: string;
  pinned: boolean;
  size?: "sm" | "md";
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateMediaMention({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getListMediaMentionsQueryKey(),
        });
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
  const dimensions = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  return (
    <button
      type="button"
      onClick={() => update.mutate({ id, data: { pinned: !pinned } })}
      disabled={update.isPending}
      aria-label={pinned ? "Unpin media mention" : "Pin media mention"}
      aria-pressed={pinned}
      title={pinned ? "Pinned — click to unpin" : "Pin this media mention"}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded p-0.5 transition-colors disabled:opacity-50",
        pinned
          ? "text-amber-500 hover:text-amber-600"
          : "text-muted-foreground hover:text-foreground",
      )}
      data-testid={`button-pin-media-${id}`}
    >
      <Pin className={cn(dimensions, pinned && "fill-amber-400")} />
    </button>
  );
}

/** Single media mention, reused by the activity feed and the pinned card. */
export function MediaMentionRow({ row }: { row: MediaMention }) {
  const pubDate = formatPubDate(row.publicationDate);
  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Newspaper className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Badge variant="secondary">Media</Badge>
          <span className="truncate font-medium">{row.publicationName}</span>
        </div>
        <MediaPinButton id={row.id} pinned={row.pinned} size="sm" />
      </div>
      <div className="text-xs text-muted-foreground">
        {[row.author, pubDate].filter(Boolean).join(" · ") || "—"}
      </div>
      {row.aiSummary ? (
        <p className="whitespace-pre-wrap text-sm">{row.aiSummary}</p>
      ) : null}
      <a
        href={row.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        data-testid={`link-media-${row.id}`}
      >
        Read story <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

/**
 * Lists every pinned media mention for a person or funder. Renders nothing
 * when there are no pinned mentions, so it can be dropped into a detail page
 * layout unconditionally.
 */
export function PinnedMediaCard({
  personId,
  funderId,
}: {
  personId?: string;
  funderId?: string;
}) {
  const params = { personId, funderId, pinned: true, limit: 50 };
  const { data, isLoading } = useListMediaMentions(params, {
    query: {
      enabled: !!(personId || funderId),
      queryKey: getListMediaMentionsQueryKey(params),
    },
  });
  const rows: MediaMention[] = data?.data ?? [];
  if (isLoading || rows.length === 0) return null;
  return (
    <Card data-testid="pinned-media-card">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">Pinned media</CardTitle>
        <Pin className="h-4 w-4 fill-amber-400 text-amber-500" />
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {rows.map((r) => (
            <li
              key={r.id}
              className="rounded-md border p-3"
              data-testid={`pinned-media-row-${r.id}`}
            >
              <MediaMentionRow row={r} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
