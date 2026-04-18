import { useEffect, useState, ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DonorPicker, type DonorSelection } from "@/components/donor-picker";
import type { CreateGiftSoftCreditBody, GiftSoftCredit } from "@workspace/api-client-react";

const CREDIT_TYPES: CreateGiftSoftCreditBody["creditType"][] = [
  "spouse",
  "advisor",
  "introducer",
  "event_captain",
  "household_member",
  "other",
];

export function SoftCreditDialog({
  trigger,
  mode,
  existing,
  isPending,
  onSubmit,
}: {
  trigger: ReactNode;
  mode: "create" | "edit";
  existing?: GiftSoftCredit & { individualFirstName?: string | null; individualLastName?: string | null };
  isPending?: boolean;
  onSubmit: (body: CreateGiftSoftCreditBody) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [individual, setIndividual] = useState<DonorSelection | null>(null);
  const [creditType, setCreditType] = useState<CreateGiftSoftCreditBody["creditType"]>("spouse");
  const [percentage, setPercentage] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (mode === "edit" && existing) {
      const label =
        [existing.individualFirstName, existing.individualLastName]
          .filter(Boolean)
          .join(" ") || "Individual";
      setIndividual({ type: "individual", id: existing.individualId, label });
      setCreditType(existing.creditType);
      setPercentage(existing.percentage != null ? String(existing.percentage) : "");
      setNotes(existing.notes ?? "");
    } else {
      setIndividual(null);
      setCreditType("spouse");
      setPercentage("");
      setNotes("");
    }
  }, [open, mode, existing]);

  const handleSubmit = async () => {
    setError(null);
    if (!individual) {
      setError("Pick an individual.");
      return;
    }
    if (individual.type !== "individual") {
      setError("Soft credits must be assigned to an individual.");
      return;
    }
    const body: CreateGiftSoftCreditBody = {
      individualId: individual.id,
      creditType,
    };
    if (percentage.trim()) {
      const p = Number(percentage);
      if (!Number.isFinite(p) || p < 0 || p > 100) {
        setError("Percentage must be 0–100.");
        return;
      }
      body.percentage = p;
    }
    if (notes.trim()) body.notes = notes;
    try {
      await onSubmit(body);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save soft credit.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Add soft credit" : "Edit soft credit"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {mode === "create" ? (
            <div className="space-y-1">
              <Label>Individual</Label>
              <DonorPicker value={individual} onChange={setIndividual} />
            </div>
          ) : (
            <div className="text-sm">
              <span className="text-muted-foreground">Individual:</span>{" "}
              <span className="font-medium">{individual?.label ?? "—"}</span>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="sc-type">Credit type</Label>
            <select
              id="sc-type"
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={creditType}
              onChange={(e) => setCreditType(e.target.value as CreateGiftSoftCreditBody["creditType"])}
            >
              {CREDIT_TYPES.map((c) => (
                <option key={c} value={c}>
                  {c.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sc-pct">Percentage (optional)</Label>
            <Input
              id="sc-pct"
              inputMode="decimal"
              placeholder="e.g. 50"
              value={percentage}
              onChange={(e) => setPercentage(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sc-notes">Notes</Label>
            <Textarea
              id="sc-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending ? "Saving…" : mode === "create" ? "Add" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
