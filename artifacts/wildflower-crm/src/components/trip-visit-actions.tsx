import { useState } from "react";
import type { TripVisit } from "@workspace/api-client-react";
import { CheckCircle2, Loader2, Pencil, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

export function TripVisitActions({
  visit,
  onEdit,
  onConfirm,
  onUnavailable,
  unavailablePending,
}: {
  visit: TripVisit;
  onEdit: () => void;
  onConfirm: () => Promise<TripVisit | undefined>;
  onUnavailable: () => void;
  unavailablePending: boolean;
}) {
  const { toast } = useToast();
  const [isConfirming, setIsConfirming] = useState(false);

  const confirm = async () => {
    if (isConfirming) return;
    setIsConfirming(true);
    try {
      const refreshedVisit = await onConfirm();
      if (refreshedVisit?.scheduledAt) {
        toast({
          title: "Visit confirmed",
          description: `${visit.personName} is scheduled for ${new Date(
            refreshedVisit.scheduledAt,
          ).toLocaleString()}.`,
        });
      } else if (refreshedVisit?.outreachStatus === "responded") {
        toast({
          title: "Response found; time not found",
          description:
            "Gmail shows a reply, but no matching Calendar event has a confirmed time yet.",
        });
      } else {
        toast({
          title: "No confirmation found",
          description:
            "No matching Gmail response or Calendar event was found for this trip.",
        });
      }
    } catch (error) {
      toast({
        title: "Confirmation check failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setIsConfirming(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={confirm}
        disabled={isConfirming || unavailablePending}
        data-testid={`confirm-trip-visit-${visit.id}`}
      >
        {isConfirming ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
        )}
        {isConfirming ? "Checking…" : "Confirm"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onUnavailable}
        disabled={isConfirming || unavailablePending}
        data-testid={`unavailable-trip-visit-${visit.id}`}
      >
        <UserX className="mr-1.5 h-3.5 w-3.5" />
        {unavailablePending ? "Hiding…" : "Unavailable"}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onEdit}
        disabled={isConfirming || unavailablePending}
        aria-label={`Edit ${visit.personName}`}
      >
        <Pencil className="h-4 w-4" />
      </Button>
    </div>
  );
}
