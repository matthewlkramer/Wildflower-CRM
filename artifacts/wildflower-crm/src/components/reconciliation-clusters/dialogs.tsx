import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Lock, Sparkles } from "lucide-react";
import type {
  StagedPaymentExclusionReason,
  WorkbenchClusterQbRecord,
} from "@workspace/api-client-react";
import { formatCurrency, formatDateShort } from "@/lib/format";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { DonorFieldPicker, type DonorType } from "@/components/entity-picker";
import {
  EXCLUSION_REASON_LABELS,
  MANUAL_EXCLUSION_FAMILIES,
} from "@/lib/reconciliation";

// ─── Dialogs for the cluster workbench ───────────────────────────────────────

/** Read-only preview of the evidence a gift will be minted from. */
export interface EvidencePreview {
  /** e.g. "$99.10" */
  amount: string;
  /** e.g. "Dec 26, 2024" */
  date: string;
  /** e.g. "Card · mastercard" or "QuickBooks payment" */
  method: string;
  /** e.g. "Stripe charge ch_4Unkn — linked automatically on save" */
  source: string;
  /** Statement descriptor / memo, when present. */
  memo?: string | null;
}

function PreviewField({
  label,
  value,
  locked,
  hint,
}: {
  label: string;
  value: string;
  locked?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-0.5 flex items-center gap-1">
        {label} {locked ? <Lock className="w-2.5 h-2.5" /> : null}
      </div>
      <div
        className={`rounded-md border px-2.5 py-1.5 text-xs ${
          locked ? "bg-muted/50 text-muted-foreground" : "bg-card font-medium"
        }`}
      >
        {value}
      </div>
      {hint ? (
        <div className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Donor pick over a read-only evidence preview. Two modes:
 * - "create": pick the donor, then the caller resolves the donor onto the
 *   evidence row and mints the gift from it (the gift's fields all come from
 *   the evidence — nothing here is editable by design).
 * - "identify": pick the donor only (resolve, no gift is created).
 */
export function DonorResolveDialog({
  open,
  onOpenChange,
  mode,
  recordLabel,
  preview,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "identify";
  recordLabel: string;
  preview: EvidencePreview | null;
  busy: boolean;
  onSubmit: (donorType: DonorType, donorId: string) => void;
}) {
  const [donorType, setDonorType] = useState<DonorType>("organization");
  const [donorId, setDonorId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDonorType("organization");
      setDonorId(null);
    }
  }, [open]);

  const create = mode === "create";
  return (
    <Dialog open={open} onOpenChange={(v) => (!busy ? onOpenChange(v) : null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {create ? "New donation record" : "Identify donor"}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-1">
            <Sparkles className="w-3.5 h-3.5 text-blue-500 shrink-0" />
            {create
              ? `Prefilled from ${recordLabel} — only the donor is missing.`
              : `Set the donor on ${recordLabel} without creating a gift yet.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              Donor
            </Label>
            <div className="mt-1">
              <DonorFieldPicker
                type={donorType}
                id={donorId}
                onChange={(t, id) => {
                  setDonorType(t);
                  setDonorId(id);
                }}
                testIdBase="cluster-resolve-donor"
                disabled={busy}
              />
            </div>
          </div>
          {preview ? (
            <div className="grid grid-cols-2 gap-3">
              <PreviewField label="Amount" value={preview.amount} locked />
              <PreviewField label="Date received" value={preview.date} locked />
              <PreviewField
                label="Payment method"
                value={preview.method}
                locked
              />
              <PreviewField label="Type" value="Donation" locked />
              <div className="col-span-2">
                <PreviewField
                  label="Source"
                  value={preview.source}
                  locked
                  hint={
                    create
                      ? "Created from this record, so the link is made automatically on save."
                      : undefined
                  }
                />
              </div>
              {preview.memo ? (
                <div className="col-span-2">
                  <PreviewField label="Memo" value={preview.memo} locked />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter className="items-center gap-2 sm:justify-between">
          {create ? (
            <p className="text-[10px] text-muted-foreground leading-snug max-w-[220px]">
              A starter allocation is seeded; coding derives once the donor is
              set.
            </p>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onOpenChange(false)}
              data-testid="button-cluster-resolve-cancel"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || !donorId}
              title={!donorId ? "Pick a donor first" : undefined}
              onClick={() => {
                if (donorId) onSubmit(donorType, donorId);
              }}
              data-testid="button-cluster-resolve-submit"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {create ? "Create & link" : "Set donor"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Exclude — not a donation" reason picker. Inline scrollable radio list (a
 * Select nested in a Dialog can't scroll — see the queue workbench).
 */
export function ExcludeReasonDialog({
  open,
  onOpenChange,
  recordLabel,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recordLabel: string;
  busy: boolean;
  onSubmit: (reason: StagedPaymentExclusionReason) => void;
}) {
  const [reason, setReason] = useState<StagedPaymentExclusionReason | null>(
    null,
  );

  useEffect(() => {
    if (open) setReason(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(v) => (!busy ? onOpenChange(v) : null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Exclude — not a donation</DialogTitle>
          <DialogDescription>
            File {recordLabel} under a non-gift category. It leaves the open
            lenses and can be re-included later.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={reason ?? ""}
          onValueChange={(v) => setReason(v as StagedPaymentExclusionReason)}
          className="max-h-72 overflow-y-auto pr-2 space-y-2"
        >
          {MANUAL_EXCLUSION_FAMILIES.map((group) => (
            <div key={group.family}>
              <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">
                {group.family}
              </p>
              <div className="space-y-1">
                {group.reasons.map((r) => (
                  <label
                    key={r}
                    className="flex items-center gap-2 text-xs cursor-pointer rounded px-1.5 py-1 hover:bg-muted/60"
                  >
                    <RadioGroupItem
                      value={r}
                      data-testid={`radio-cluster-exclude-${r}`}
                    />
                    {EXCLUSION_REASON_LABELS[r]}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </RadioGroup>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onOpenChange(false)}
            data-testid="button-cluster-exclude-cancel"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || !reason}
            onClick={() => {
              if (reason) onSubmit(reason);
            }}
            data-testid="button-cluster-exclude-submit"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Exclude
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── QB record detail dialog (§7.2 "View QB record") ──────────────────────

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[140px_1fr] gap-x-3 py-1 text-xs border-b last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium break-words">{value}</span>
    </div>
  );
}

const QB_ROLE_LABEL: Record<WorkbenchClusterQbRecord["role"], string> = {
  anchor: "QB record",
  deposit: "Deposit",
  fee: "Processor fee",
  charge_tie: "Charge tie",
  group_member: "Group member",
};

export function QbRecordDetailDialog({
  open,
  onOpenChange,
  record,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  record: WorkbenchClusterQbRecord | null;
}) {
  if (!record) return null;

  const title = record.lineDescription ?? record.reference ?? record.memo ?? record.stagedPaymentId;
  const qbHref =
    record.qbEntityType && record.qbEntityId
      ? `https://app.qbo.intuit.com/app/${
          { sales_receipt: "salesreceipt", payment: "recvpayment", deposit: "deposit" }[record.qbEntityType] ?? record.qbEntityType
        }?txnId=${encodeURIComponent(record.qbEntityId)}`
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold leading-snug break-words">
            {title}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {QB_ROLE_LABEL[record.role]}
            {record.amount != null ? ` · ${formatCurrency(record.amount)}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-xs py-1">
          {/* Payer / donor */}
          <section>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
              Payer
            </p>
            <DetailRow label="QB payer" value={record.payerName} />
            <DetailRow label="Identified donor" value={record.attributedDonor?.donorName ?? (record.attributedDonor ? "(unnamed)" : null)} />
          </section>

          {/* Transaction */}
          <section>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
              Transaction
            </p>
            <DetailRow
              label="Amount"
              value={record.amount != null ? formatCurrency(record.amount) : null}
            />
            <DetailRow
              label="Date received"
              value={record.dateReceived ? formatDateShort(record.dateReceived) : null}
            />
            <DetailRow label="Payment method" value={record.paymentMethod} />
            <DetailRow label="QB entity type" value={record.qbEntityType} />
            <DetailRow label="QB entity ID" value={record.qbEntityId} />
            <DetailRow label="Status" value={record.status} />
            <DetailRow label="Role" value={QB_ROLE_LABEL[record.role]} />
          </section>

          {/* Descriptions */}
          <section>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
              Descriptions
            </p>
            <DetailRow label="Reference" value={record.reference} />
            <DetailRow label="Line description" value={record.lineDescription} />
            <DetailRow label="Memo" value={record.memo} />
          </section>

          {/* IDs */}
          <section>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
              Record
            </p>
            <DetailRow label="Staged payment ID" value={record.stagedPaymentId} />
            {record.linkedChargeId ? (
              <DetailRow label="Linked charge" value={record.linkedChargeId} />
            ) : null}
          </section>
        </div>

        <DialogFooter className="gap-2">
          {qbHref ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => window.open(qbHref, "_blank", "noopener")}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open in QuickBooks
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
