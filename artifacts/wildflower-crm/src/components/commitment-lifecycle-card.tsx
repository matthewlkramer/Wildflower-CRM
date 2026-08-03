import type {
  OpportunityCommitmentPath,
  OpportunityOrPledgeDetail,
} from "@workspace/api-client-react";
import { RelatedCard } from "@/components/record-layout";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";

const PATH_LABEL: Record<OpportunityCommitmentPath, string> = {
  gift: "Gift",
  written_pledge: "Written pledge",
  verbal_pledge: "Informal verbal pledge",
};

export function CommitmentLifecycleCard({
  opp,
}: {
  opp: OpportunityOrPledgeDetail;
}) {
  const pendingPledge =
    !opp.pledgeCommittedAt &&
    (opp.commitmentPath === "written_pledge" ||
      opp.commitmentPath === "verbal_pledge");
  const awaitingGift =
    !opp.pledgeCommittedAt &&
    opp.commitmentPath === "gift" &&
    Number(opp.paidAmount ?? 0) <= 0;

  const summary = opp.pledgeCommittedAt
    ? `${PATH_LABEL[opp.commitmentPath as OpportunityCommitmentPath] ?? "Pledge"} finalized ${formatDate(opp.pledgeCommittedAt)}`
    : awaitingGift
      ? "Verbally committed stand-alone gift; waiting for actual payment."
      : pendingPledge
        ? `${PATH_LABEL[opp.commitmentPath as OpportunityCommitmentPath]} anticipated; complete the pledge requirements and finalize it.`
        : Number(opp.paidAmount ?? 0) > 0
          ? "Completed as a stand-alone gift when the money arrived."
          : "No positive commitment recorded yet.";

  return (
    <RelatedCard title="Commitment lifecycle">
      <div className="space-y-3 px-2 py-1 text-sm">
        <p>{summary}</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div>
            <div className="text-muted-foreground">Expected path</div>
            <div>
              {opp.commitmentPath ? PATH_LABEL[opp.commitmentPath] : "—"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Verbal confirmation</div>
            <div>{formatDate(opp.verbalCommitmentAt)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Actual outcome</div>
            <div>
              {opp.outcomeType ? (
                <Badge variant="outline">{formatEnum(opp.outcomeType)}</Badge>
              ) : (
                "—"
              )}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Confirmed amount</div>
            <div>{formatCurrency(opp.awardedAmount)}</div>
          </div>
        </div>
        {pendingPledge ? (
          <p className="text-xs text-muted-foreground">
            Written pledges require a pledge document. Fixed commitments require
            allocations and an expected-payment schedule totaling the confirmed
            amount. Conditional allocations require condition text.
          </p>
        ) : null}
      </div>
    </RelatedCard>
  );
}
