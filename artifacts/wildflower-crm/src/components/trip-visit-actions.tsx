import { useState } from "react";
import type { TripVisit } from "@workspace/api-client-react";
import { Loader2, Pencil, RefreshCw, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { formatTripDateTime } from "@/lib/trip-time-zone";

export function TripVisitActions({
  visit,
  onEdit,
  onUpdateEvidence,
  onUnavailable,
  unavailablePending,
  timeZone,
}: {
  visit: TripVisit;
  onEdit: () => void;
  onUpdateEvidence: () => Promise<TripVisit>;
  onUnavailable: () => void;
  unavailablePending: boolean;
  timeZone: string;
}) {
  const { toast } = useToast();
  const [isUpdating, setIsUpdating] = useState(false);

  const updateEvidence = async () => {
    if (isUpdating) return;
    setIsUpdating(true);
    try {
      const refreshedVisit = await onUpdateEvidence();
      if (refreshedVisit.evidenceStatus === "confirmed") {
        toast({
          title: "Status updated: confirmed",
          description: refreshedVisit.evidenceConfirmedAt
            ? `${visit.personName} is scheduled for ${formatTripDateTime(
                refreshedVisit.evidenceConfirmedAt,
                timeZone,
              )}.`
            : (refreshedVisit.evidenceConfirmedTime ??
              refreshedVisit.evidenceSummary ??
              "A confirmed time was found."),
        });
      } else if (refreshedVisit.evidenceStatus === "bounced") {
        toast({
          title: "Status updated: bounced",
          description:
            refreshedVisit.evidenceSummary ??
            "The invitation could not be delivered.",
          variant: "destructive",
        });
      } else if (refreshedVisit.evidenceStatus === "responded") {
        toast({
          title: "Status updated: responded",
          description:
            refreshedVisit.evidenceSummary ??
            "A reply was found, but no confirmed time.",
        });
      } else if (refreshedVisit.evidenceStatus === "invited") {
        toast({
          title: "Status updated: invitation sent",
          description:
            refreshedVisit.evidenceSummary ??
            "An invitation was found with no reply yet.",
        });
      } else {
        toast({
          title: "Status updated: not invited",
          description:
            refreshedVisit.evidenceSummary ??
            "No trip-related outreach was found.",
        });
      }
    } catch (error) {
      toast({
        title: "Confirmation check failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={updateEvidence}
        disabled={isUpdating || unavailablePending}
        data-testid={`update-trip-visit-evidence-${visit.id}`}
      >
        {isUpdating ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
        )}
        {isUpdating ? "Reviewing…" : "Update from Gmail & Calendar"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onUnavailable}
        disabled={isUpdating || unavailablePending}
        data-testid={`unavailable-trip-visit-${visit.id}`}
      >
        <UserX className="mr-1.5 h-3.5 w-3.5" />
        {unavailablePending ? "Hiding…" : "Unavailable"}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onEdit}
        disabled={isUpdating || unavailablePending}
        aria-label={`Edit ${visit.personName}`}
      >
        <Pencil className="h-4 w-4" />
      </Button>
    </div>
  );
}
