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
import { FUND_LABELS, formatCurrency } from "@/lib/format";
import type {
  CreateGiftBody,
  CreateGiftAllocationBody,
  GiftDetail,
} from "@workspace/api-client-react";
import { Trash2, Plus } from "lucide-react";

const FUND_OPTIONS = Object.keys(FUND_LABELS);
const FISCAL_YEARS = ["FY23", "FY24", "FY25", "FY26", "FY27", "FY28", "FY29", "FY30"];
const PAYMENT_METHODS = [
  "check",
  "wire",
  "ach",
  "credit_card",
  "stock",
  "daf_grant",
  "in_kind",
  "other",
];

type AllocationDraft = {
  fund: string;
  amount: string;
  fiscalYear: string;
  notes: string;
};

type FormState = {
  donor: DonorSelection | null;
  amount: string;
  cashReceivedDate: string;
  paymentMethod: string;
  checkNumber: string;
  acknowledgmentSentDate: string;
  taxReceiptSent: boolean;
  notes: string;
  allocations: AllocationDraft[];
};

function emptyState(): FormState {
  const today = new Date().toISOString().slice(0, 10);
  return {
    donor: null,
    amount: "",
    cashReceivedDate: today,
    paymentMethod: "",
    checkNumber: "",
    acknowledgmentSentDate: "",
    taxReceiptSent: false,
    notes: "",
    allocations: [{ fund: "general_operating", amount: "", fiscalYear: "", notes: "" }],
  };
}

function fromGift(gift: GiftDetail): FormState {
  const donor: DonorSelection | null = gift.individualId
    ? { type: "individual", id: gift.individualId, label: "" }
    : gift.householdId
    ? { type: "household", id: gift.householdId, label: "" }
    : gift.fundingEntityId
    ? { type: "funding_entity", id: gift.fundingEntityId, label: "" }
    : null;
  return {
    donor: donor && { ...donor, label: (gift as GiftDetail & { donorName?: string }).donorName ?? "Donor" },
    amount: String(gift.amount ?? ""),
    cashReceivedDate: gift.cashReceivedDate?.slice(0, 10) ?? "",
    paymentMethod: gift.paymentMethod ?? "",
    checkNumber: gift.checkNumber ?? "",
    acknowledgmentSentDate: gift.acknowledgmentSentDate?.slice(0, 10) ?? "",
    taxReceiptSent: !!gift.taxReceiptSent,
    notes: gift.notes ?? "",
    allocations:
      (gift.allocations ?? []).map((a) => ({
        fund: a.fund,
        amount: String(a.amount ?? ""),
        fiscalYear: a.fiscalYear ?? "",
        notes: a.notes ?? "",
      })) || [],
  };
}

export function GiftFormDialog({
  trigger,
  mode,
  gift,
  isPending,
  onSubmit,
}: {
  trigger: ReactNode;
  mode: "create" | "edit";
  gift?: GiftDetail;
  isPending?: boolean;
  onSubmit: (body: CreateGiftBody) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FormState>(() => emptyState());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setState(mode === "edit" && gift ? fromGift(gift) : emptyState());
  }, [open, mode, gift]);

  const updateAlloc = (i: number, patch: Partial<AllocationDraft>) =>
    setState((s) => ({
      ...s,
      allocations: s.allocations.map((a, idx) => (idx === i ? { ...a, ...patch } : a)),
    }));

  const addAlloc = () =>
    setState((s) => ({
      ...s,
      allocations: [
        ...s.allocations,
        { fund: "general_operating", amount: "", fiscalYear: "", notes: "" },
      ],
    }));

  const removeAlloc = (i: number) =>
    setState((s) => ({
      ...s,
      allocations: s.allocations.filter((_, idx) => idx !== i),
    }));

  const allocSum = state.allocations.reduce((sum, a) => {
    const n = Number(a.amount);
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);
  const totalNum = Number(state.amount);
  const sumOk = Number.isFinite(totalNum) && Math.abs(allocSum - totalNum) < 0.001;

  const handleSubmit = async () => {
    setError(null);
    if (!state.donor) {
      setError("Pick a donor.");
      return;
    }
    const amountNum = Number(state.amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setError("Amount must be a positive number.");
      return;
    }
    if (!state.cashReceivedDate) {
      setError("Cash received date is required.");
      return;
    }
    if (state.allocations.length === 0) {
      setError("Add at least one allocation.");
      return;
    }
    const allocBodies: CreateGiftAllocationBody[] = [];
    for (const a of state.allocations) {
      const n = Number(a.amount);
      if (!Number.isFinite(n) || n <= 0) {
        setError("Each allocation needs a positive amount.");
        return;
      }
      if (!a.fund) {
        setError("Each allocation needs a fund.");
        return;
      }
      allocBodies.push({
        fund: a.fund as CreateGiftAllocationBody["fund"],
        amount: n,
        ...(a.fiscalYear
          ? { fiscalYear: a.fiscalYear as CreateGiftAllocationBody["fiscalYear"] }
          : {}),
        ...(a.notes ? { notes: a.notes } : {}),
      });
    }
    if (Math.abs(allocSum - amountNum) > 0.001) {
      setError(`Allocations (${allocSum}) must equal the gift amount (${amountNum}).`);
      return;
    }

    const body: CreateGiftBody = {
      amount: amountNum,
      cashReceivedDate: state.cashReceivedDate,
      allocations: allocBodies,
    };
    if (state.donor.type === "individual") body.individualId = state.donor.id;
    if (state.donor.type === "household") body.householdId = state.donor.id;
    if (state.donor.type === "funding_entity") body.fundingEntityId = state.donor.id;
    if (state.paymentMethod)
      body.paymentMethod = state.paymentMethod as CreateGiftBody["paymentMethod"];
    if (state.checkNumber) body.checkNumber = state.checkNumber;
    if (state.acknowledgmentSentDate)
      body.acknowledgmentSentDate = state.acknowledgmentSentDate;
    if (state.taxReceiptSent) body.taxReceiptSent = true;
    if (state.notes) body.notes = state.notes;

    try {
      await onSubmit(body);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save gift.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Record a new gift" : "Edit gift"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label>Donor</Label>
            <DonorPicker value={state.donor} onChange={(d) => setState((s) => ({ ...s, donor: d }))} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="gift-amount">Amount (USD)</Label>
              <Input
                id="gift-amount"
                inputMode="decimal"
                value={state.amount}
                onChange={(e) => setState((s) => ({ ...s, amount: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gift-date">Cash received date</Label>
              <Input
                id="gift-date"
                type="date"
                value={state.cashReceivedDate}
                onChange={(e) => setState((s) => ({ ...s, cashReceivedDate: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gift-method">Payment method</Label>
              <select
                id="gift-method"
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={state.paymentMethod}
                onChange={(e) => setState((s) => ({ ...s, paymentMethod: e.target.value }))}
              >
                <option value="">—</option>
                {PAYMENT_METHODS.map((p) => (
                  <option key={p} value={p}>
                    {p.replace("_", " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="gift-check">Check number</Label>
              <Input
                id="gift-check"
                value={state.checkNumber}
                onChange={(e) => setState((s) => ({ ...s, checkNumber: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gift-ack">Acknowledgment sent</Label>
              <Input
                id="gift-ack"
                type="date"
                value={state.acknowledgmentSentDate}
                onChange={(e) =>
                  setState((s) => ({ ...s, acknowledgmentSentDate: e.target.value }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label className="block">Tax receipt</Label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={state.taxReceiptSent}
                  onChange={(e) => setState((s) => ({ ...s, taxReceiptSent: e.target.checked }))}
                />
                Sent
              </label>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Allocations</Label>
              <span
                className={`text-xs ${
                  sumOk ? "text-muted-foreground" : "text-destructive"
                }`}
              >
                Sum {formatCurrency(allocSum)}
                {state.amount ? ` of ${formatCurrency(totalNum)}` : ""}
              </span>
            </div>
            <div className="space-y-2">
              {state.allocations.map((a, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-start">
                  <select
                    className="col-span-4 h-9 rounded-md border border-input bg-background px-2 text-sm"
                    value={a.fund}
                    onChange={(e) => updateAlloc(i, { fund: e.target.value })}
                  >
                    {FUND_OPTIONS.map((f) => (
                      <option key={f} value={f}>
                        {FUND_LABELS[f]}
                      </option>
                    ))}
                  </select>
                  <Input
                    className="col-span-3"
                    inputMode="decimal"
                    placeholder="Amount"
                    value={a.amount}
                    onChange={(e) => updateAlloc(i, { amount: e.target.value })}
                  />
                  <select
                    className="col-span-2 h-9 rounded-md border border-input bg-background px-2 text-sm"
                    value={a.fiscalYear}
                    onChange={(e) => updateAlloc(i, { fiscalYear: e.target.value })}
                  >
                    <option value="">FY—</option>
                    {FISCAL_YEARS.map((fy) => (
                      <option key={fy} value={fy}>
                        {fy}
                      </option>
                    ))}
                  </select>
                  <Input
                    className="col-span-2"
                    placeholder="Notes"
                    value={a.notes}
                    onChange={(e) => updateAlloc(i, { notes: e.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="col-span-1"
                    onClick={() => removeAlloc(i)}
                    disabled={state.allocations.length <= 1}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addAlloc}>
              <Plus className="h-4 w-4 mr-1" /> Add allocation
            </Button>
          </div>

          <div className="space-y-1">
            <Label htmlFor="gift-notes">Notes</Label>
            <Textarea
              id="gift-notes"
              rows={3}
              value={state.notes}
              onChange={(e) => setState((s) => ({ ...s, notes: e.target.value }))}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending ? "Saving…" : mode === "create" ? "Record gift" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
