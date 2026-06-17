import { Link } from "wouter";
import {
  useListGrantLeads,
  getListGrantLeadsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Lightbulb } from "lucide-react";

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  claimed: "Claimed",
};

const ALL_STATUSES = ["new", "claimed"] as const;

/**
 * Dashboard card: grant-lead counts by status (new, claimed).
 * Clicking the card header navigates to /grant-leads; individual
 * status chips navigate there pre-filtered.
 */
export default function GrantLeadsCard() {
  const newParams = { status: "new" as const, limit: 1 };
  const claimedParams = { status: "claimed" as const, limit: 1 };

  const {
    data: newData,
    isLoading: newLoading,
    isError: newError,
  } = useListGrantLeads(newParams, {
    query: {
      queryKey: getListGrantLeadsQueryKey(newParams),
      refetchOnWindowFocus: true,
      staleTime: 30_000,
    },
  });

  const {
    data: claimedData,
    isLoading: claimedLoading,
    isError: claimedError,
  } = useListGrantLeads(claimedParams, {
    query: {
      queryKey: getListGrantLeadsQueryKey(claimedParams),
      refetchOnWindowFocus: true,
      staleTime: 30_000,
    },
  });

  const isLoading = newLoading || claimedLoading;
  const isError = newError || claimedError;

  const counts: Record<string, number> = {
    new: newData?.pagination.total ?? 0,
    claimed: claimedData?.pagination.total ?? 0,
  };

  const total = counts.new + counts.claimed;

  return (
    <Card data-testid="card-grant-leads">
      <CardHeader className="pb-3 flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-lg flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-muted-foreground" />
            Grant leads
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            AI-detected grant opportunities from your inbox — review and act.
          </p>
        </div>
        <Link
          href="/grant-leads"
          className="text-sm font-medium text-primary hover:underline"
          data-testid="link-grant-leads-all"
        >
          {isLoading ? "…" : total > 0 ? `${total} active` : "Open"}
        </Link>
      </CardHeader>
      <CardContent>
        {isError ? (
          <div className="text-sm text-destructive" data-testid="grant-leads-error">
            Failed to load grant lead counts.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {ALL_STATUSES.map((status) => {
              const n = counts[status] ?? 0;
              return (
                <Link
                  key={status}
                  href={`/grant-leads?status=${status}`}
                  data-testid={`chip-grant-lead-${status}`}
                >
                  <Badge
                    variant={n > 0 ? "default" : "outline"}
                    className={
                      "gap-1.5 cursor-pointer " +
                      (n > 0 ? "" : "text-muted-foreground")
                    }
                  >
                    <span>{STATUS_LABEL[status]}</span>
                    <span className="font-mono text-xs">
                      {isLoading ? "…" : n}
                    </span>
                  </Badge>
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
