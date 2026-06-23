import { Link } from "wouter";
import {
  useGetEmailProposalSummary,
  getGetEmailProposalSummaryQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Inbox } from "lucide-react";

const KIND_LABEL: Record<string, string> = {
  linkedin_job_change: "LinkedIn job changes",
  auto_responder_move: "\"I've moved\" auto-replies",
  bounce_invalid: "Hard bounces",
  bounce_soft: "Soft bounces",
  signature_update: "Signature updates",
  grant_opportunity: "Grant opportunities",
  thank_you_acknowledgment: "Thank-you acknowledgments",
  wildflower_update: "Wildflower updates",
};

const ALL_KINDS = [
  "linkedin_job_change",
  "auto_responder_move",
  "bounce_invalid",
  "bounce_soft",
  "signature_update",
  "grant_opportunity",
  "thank_you_acknowledgment",
  "wildflower_update",
] as const;

const OTHER_LABEL = "Other";

/**
 * Dashboard card: per-kind pending counts from the email-intelligence
 * pipeline. Empty kinds are still rendered (greyed-out 0) so the user
 * learns the categories that exist and what to expect once mail flows.
 *
 * Each kind is a clickable chip that drills into the review queue
 * page filtered to that kind. The whole card title also links to the
 * unfiltered queue.
 */
export default function EmailProposalsCard() {
  const { data, isLoading, isError } = useGetEmailProposalSummary({
    query: {
      queryKey: getGetEmailProposalSummaryQueryKey(),
      // Inbox-style — refetch on focus so newly-arrived signals appear
      // without a manual page refresh.
      refetchOnWindowFocus: true,
      staleTime: 30_000,
    },
  });

  const byKind = new Map<string, number>();
  for (const entry of data?.byKind ?? []) {
    byKind.set(entry.kind, entry.pending);
  }
  const totalPending = data?.totalPending ?? 0;

  // Roll any pending kinds the card doesn't render explicitly into a single
  // "Other" bucket so the per-kind boxes always sum to the top total —
  // otherwise unlisted kinds inflate the total without a matching box.
  const knownKinds = new Set<string>(ALL_KINDS);
  let otherPending = 0;
  for (const entry of data?.byKind ?? []) {
    if (!knownKinds.has(entry.kind)) {
      otherPending += entry.pending;
    }
  }

  return (
    <Card data-testid="card-email-proposals">
      <CardHeader className="pb-3 flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-lg flex items-center gap-2">
            <Inbox className="h-4 w-4 text-muted-foreground" />
            Email intelligence
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Signals extracted from your synced inbox — review and apply.
          </p>
        </div>
        <Link
          href="/email-intelligence"
          className="text-sm font-medium text-primary hover:underline"
          data-testid="link-email-proposals-all"
        >
          {isLoading ? "…" : totalPending > 0 ? `${totalPending} pending` : "Open"}
        </Link>
      </CardHeader>
      <CardContent>
        {isError ? (
          <div className="text-sm text-destructive" data-testid="email-proposals-error">
            Failed to load proposal summary.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {ALL_KINDS.map((kind) => {
              const n = byKind.get(kind) ?? 0;
              return (
                <Link
                  key={kind}
                  href={`/email-intelligence?kind=${kind}`}
                  data-testid={`chip-proposal-${kind}`}
                >
                  <Badge
                    variant={n > 0 ? "default" : "outline"}
                    className={
                      "gap-1.5 cursor-pointer " +
                      (n > 0 ? "" : "text-muted-foreground")
                    }
                  >
                    <span>{KIND_LABEL[kind]}</span>
                    <span className="font-mono text-xs">{n}</span>
                  </Badge>
                </Link>
              );
            })}
            {otherPending > 0 && (
              <Link
                href="/email-intelligence"
                data-testid="chip-proposal-other"
              >
                <Badge
                  variant="default"
                  className="gap-1.5 cursor-pointer"
                >
                  <span>{OTHER_LABEL}</span>
                  <span className="font-mono text-xs">{otherPending}</span>
                </Badge>
              </Link>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
