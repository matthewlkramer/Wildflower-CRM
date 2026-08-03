import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import {
  getGetDonorRoutingQueryKey,
  useGetCurrentUser,
  useGetDonorRouting,
  type DonorRecordKind,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { CreateOpportunityDialog } from "@/components/create-opportunity-dialog";
import { PendingGiftDialog } from "@/components/pending-gift-dialog";
import type { PaymentEvidenceDonor } from "@/components/payment-evidence-picker-dialog";
import type { LinkedRecordsScope } from "@/components/linked-records";
import type { DonorType } from "@/components/entity-picker";
import { RecordReceivedGiftDialog } from "@/components/record-received-gift-dialog";

function donorType(kind: DonorRecordKind): DonorType {
  return kind === "individual" ? "individual" : kind;
}

function scopeFor(kind: DonorRecordKind, id: string): LinkedRecordsScope {
  if (kind === "organization") return { organizationId: id };
  if (kind === "household") return { householdId: id };
  return { individualGiverPersonId: id };
}

export function DonorRecordActions({
  sourceKind,
  sourceId,
  sourceName,
  onEditName,
  onFlagResearch,
  onArchive,
  archiveLabel = "Archive",
  additionalItems,
  busy = false,
  archived = false,
  onRestore,
}: {
  sourceKind: DonorRecordKind;
  sourceId: string;
  sourceName: string;
  onEditName?: () => void;
  onFlagResearch: () => void;
  onArchive: () => void;
  archiveLabel?: string;
  additionalItems?: ReactNode;
  busy?: boolean;
  archived?: boolean;
  onRestore?: () => void;
}) {
  const [, navigate] = useLocation();
  const viewerIsAdmin = useGetCurrentUser().data?.role === "admin";
  const [receivedOpen, setReceivedOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [pledgeSetupOpen, setPledgeSetupOpen] = useState(false);

  const routing = useGetDonorRouting(sourceKind, sourceId, {
    query: {
      queryKey: getGetDonorRoutingQueryKey(sourceKind, sourceId),
    },
  });
  const resolved = routing.data?.resolved ?? routing.data?.source ?? null;
  const actionKind = resolved?.kind ?? sourceKind;
  const actionId = resolved?.id ?? sourceId;
  const actionName = resolved?.name ?? sourceName;
  const donor: PaymentEvidenceDonor = {
    type: donorType(actionKind),
    id: actionId,
    name: actionName,
  };
  const scope = scopeFor(actionKind, actionId);

  return (
    <>
      <CreateOpportunityDialog
        scope={scope}
        mode="opportunity"
        trigger={
          <Button
            size="sm"
            disabled={archived || busy}
            data-testid="button-donor-new-opportunity"
          >
            New opportunity
          </Button>
        }
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || routing.isLoading}
            data-testid="button-donor-actions"
          >
            Actions
            <ChevronDown className="ml-1 h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          {archived ? (
            <DropdownMenuItem onSelect={onRestore} disabled={!onRestore}>
              Restore record
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem
                onSelect={() => setReceivedOpen(true)}
                data-testid="action-record-received-gift"
              >
                Record received gift…
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setPendingOpen(true)}
                data-testid="action-record-pending-gift"
              >
                Record pending gift…
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setPledgeSetupOpen(true)}
                data-testid="action-record-existing-pledge"
              >
                Record existing pledge…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {onEditName ? (
                <DropdownMenuItem onSelect={onEditName}>
                  Edit name
                </DropdownMenuItem>
              ) : null}
              {additionalItems}
              <DropdownMenuItem onSelect={onFlagResearch}>
                Flag for research
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!viewerIsAdmin}
                onSelect={() =>
                  navigate(
                    `/audit-log?entityType=${sourceKind === "individual" ? "person" : sourceKind}&entityId=${sourceId}`,
                  )
                }
              >
                View change history
                {!viewerIsAdmin ? " (admin role required)" : ""}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onArchive}>
                {archiveLabel}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <RecordReceivedGiftDialog
        scope={scopeFor(sourceKind, sourceId)}
        open={receivedOpen}
        onOpenChange={setReceivedOpen}
      />
      <PendingGiftDialog
        open={pendingOpen}
        onOpenChange={setPendingOpen}
        donor={donor}
        onComplete={(opportunityId) =>
          navigate(`/opportunities/${opportunityId}`)
        }
      />
      <CreateOpportunityDialog
        scope={scope}
        mode="pledge"
        open={pledgeSetupOpen}
        onOpenChange={setPledgeSetupOpen}
      />
    </>
  );
}
