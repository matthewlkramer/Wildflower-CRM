import { RefreshCw, Sparkles } from "lucide-react";
import {
  useGetOrganizationRelationshipSummary,
  getGetOrganizationRelationshipSummaryQueryKey,
  useGetPersonRelationshipSummary,
  getGetPersonRelationshipSummaryQueryKey,
  type RelationshipSummary,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";

const NO_SUMMARY = "(no summary available)";

/**
 * Shared presentational shell for the AI relationship summary that sits
 * above the activity feed on donor detail pages. The summary is computed
 * on view and never persisted, so we cache it for the session
 * (staleTime: Infinity) and offer an explicit refresh instead of
 * refetching on every focus.
 */
function SummaryShell({
  data,
  isLoading,
  isFetching,
  isError,
  error,
  onRefresh,
}: {
  data: RelationshipSummary | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  onRefresh: () => void;
}) {
  const empty = data?.summary === NO_SUMMARY;
  return (
    <div
      className="rounded-xl border bg-card p-4 shadow-sm"
      data-testid="relationship-summary"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" />
          Relationship summary
        </div>
        <div className="flex items-center gap-2">
          {data?.generatedAt ? (
            <span className="text-xs text-muted-foreground">
              {formatDate(data.generatedAt)}
            </span>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={onRefresh}
            disabled={isFetching}
            aria-label="Refresh relationship summary"
            data-testid="button-refresh-relationship-summary"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>
      <div className="mt-2">
        {isLoading ? (
          <div className="space-y-2" aria-hidden data-testid="relationship-summary-loading">
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
            <div className="h-3 w-11/12 animate-pulse rounded bg-muted" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        ) : isError ? (
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-destructive" data-testid="relationship-summary-error">
              {error instanceof Error
                ? error.message
                : "Couldn’t generate the relationship summary."}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
              Retry
            </Button>
          </div>
        ) : empty ? (
          <p className="text-sm italic text-muted-foreground">
            Not enough recent activity to summarize yet.
          </p>
        ) : (
          <p
            className="whitespace-pre-wrap text-sm leading-relaxed text-foreground"
            data-testid="relationship-summary-text"
          >
            {data?.summary}
          </p>
        )}
      </div>
    </div>
  );
}

export function OrganizationRelationshipSummaryCard({
  organizationId,
}: {
  organizationId: string;
}) {
  const q = useGetOrganizationRelationshipSummary(organizationId, {
    query: {
      queryKey: getGetOrganizationRelationshipSummaryQueryKey(organizationId),
      enabled: !!organizationId,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      retry: false,
    },
  });
  return (
    <SummaryShell
      data={q.data}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      isError={q.isError}
      error={q.error}
      onRefresh={() => void q.refetch()}
    />
  );
}

export function PersonRelationshipSummaryCard({ personId }: { personId: string }) {
  const q = useGetPersonRelationshipSummary(personId, {
    query: {
      queryKey: getGetPersonRelationshipSummaryQueryKey(personId),
      enabled: !!personId,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      retry: false,
    },
  });
  return (
    <SummaryShell
      data={q.data}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      isError={q.isError}
      error={q.error}
      onRefresh={() => void q.refetch()}
    />
  );
}
