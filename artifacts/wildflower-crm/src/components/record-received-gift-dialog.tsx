import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import {
  getGetDonorRoutingQueryKey,
  useGetDonorRouting,
  type DonorRecordKind,
} from "@workspace/api-client-react";
import type { LinkedRecordsScope } from "@/components/linked-records";
import { DonorFieldPicker, type DonorType } from "@/components/entity-picker";
import {
  PaymentEvidencePickerDialog,
  type PaymentEvidenceDonor,
} from "@/components/payment-evidence-picker-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AddIconButton } from "@/components/add-icon-button";
import { Label } from "@/components/ui/label";

function donorFromScope(
  scope: LinkedRecordsScope | undefined,
): { type: DonorType; id: string } | null {
  if (!scope) return null;
  if ("organizationId" in scope) {
    return { type: "organization", id: scope.organizationId };
  }
  if ("householdId" in scope) {
    return { type: "household", id: scope.householdId };
  }
  return { type: "individual", id: scope.individualGiverPersonId };
}

function routingKind(type: DonorType): DonorRecordKind {
  return type === "individual" ? "individual" : type;
}

/**
 * Standard entry point for recording a received gift. A user chooses the donor
 * first (unless the page already supplies one), then must choose actual received
 * payment evidence. No gift row is created from typed amount/date fields.
 */
export function RecordReceivedGiftDialog({
  scope,
  trigger,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: {
  scope?: LinkedRecordsScope;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const initial = donorFromScope(scope);
  const [, navigate] = useLocation();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const donorOpen = isControlled ? controlledOpen : uncontrolledOpen;
  const setDonorOpen = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next);
    controlledOnOpenChange?.(next);
  };
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [donorType, setDonorType] = useState<DonorType>(
    initial?.type ?? "organization",
  );
  const [donorId, setDonorId] = useState<string | null>(initial?.id ?? null);

  useEffect(() => {
    if (!donorOpen) return;
    const next = donorFromScope(scope);
    setDonorType(next?.type ?? "organization");
    setDonorId(next?.id ?? null);
  }, [donorOpen, scope]);

  const sourceKind = routingKind(donorType);
  const routing = useGetDonorRouting(sourceKind, donorId ?? "", {
    query: {
      enabled: donorOpen && !!donorId,
      queryKey: getGetDonorRoutingQueryKey(sourceKind, donorId ?? ""),
    },
  });
  const resolved = routing.data?.resolved ?? null;
  const requiresDecision = routing.data?.requiresDecision === true;
  const paymentDonor: PaymentEvidenceDonor | null = resolved
    ? {
        type: resolved.kind === "individual" ? "individual" : resolved.kind,
        id: resolved.id,
        name: resolved.name,
      }
    : donorId && !routing.isLoading && !requiresDecision
      ? { type: donorType, id: donorId }
      : null;

  const continueToEvidence = () => {
    if (!paymentDonor || requiresDecision) return;
    setDonorOpen(false);
    setEvidenceOpen(true);
  };

  return (
    <>
      <Dialog open={donorOpen} onOpenChange={setDonorOpen}>
        {trigger ? (
          <DialogTrigger asChild>{trigger}</DialogTrigger>
        ) : !isControlled ? (
          <DialogTrigger asChild>
            {scope ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                data-testid="button-record-received-gift"
              >
                Add
              </Button>
            ) : (
              <AddIconButton
                label="Record received gift"
                data-testid="button-record-received-gift"
              />
            )}
          </DialogTrigger>
        ) : null}
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record received gift</DialogTitle>
            <DialogDescription>
              Choose the donor first. The next step requires selecting the
              actual QuickBooks payment or Stripe charge that was received.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Donor</Label>
              <DonorFieldPicker
                type={donorType}
                id={donorId}
                onChange={(type, id) => {
                  setDonorType(type);
                  setDonorId(id);
                }}
                testIdBase="received-gift-donor"
              />
            </div>
            {donorId && routing.isLoading ? (
              <p className="text-xs text-muted-foreground">
                Resolving the preferred donor pathway…
              </p>
            ) : requiresDecision ? (
              <p className="text-xs text-destructive">
                This donor is set to ask each time. Choose the intended donor of
                record directly before continuing.
              </p>
            ) : resolved &&
              (resolved.id !== donorId || resolved.kind !== sourceKind) ? (
              <p className="text-xs text-muted-foreground">
                The preferred donor pathway records this gift under{" "}
                {resolved.name}.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDonorOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={continueToEvidence}
              disabled={!paymentDonor || routing.isLoading || requiresDecision}
              data-testid="button-continue-to-payment-evidence"
            >
              Select received payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {paymentDonor ? (
        <PaymentEvidencePickerDialog
          open={evidenceOpen}
          onOpenChange={setEvidenceOpen}
          donor={paymentDonor}
          action={{ kind: "create-standalone-gift" }}
          onComplete={(giftId) => navigate(`/gifts/${giftId}`)}
        />
      ) : null}
    </>
  );
}
