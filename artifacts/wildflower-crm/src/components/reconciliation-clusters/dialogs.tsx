import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, Lock, Sparkles } from "lucide-react";
import {
  listReconciliationCards,
  type ReconciliationCard,
  type StagedPaymentExclusionReason,
  type WorkbenchClusterQbRecord,
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
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { DonorFieldPicker, type DonorType } from "@/components/entity-picker";
import { useDebounce } from "@/hooks/use-debounce";
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

/** One linked evidence relationship a gift can be unlinked from. */
export interface UnlinkOption {
  /** Structurally matches rows.tsx AnchorRef (kept structural to avoid an import cycle). */
  anchor: { kind: "charge" | "staged"; id: string; label: string };
  /** e.g. "Stripe charge · Jane Donor" or "QuickBooks · Deposit 4/12" */
  source: string;
  /** Preformatted amount ("$99.10") or null when unknown. */
  amount: string | null;
  /** Preformatted date ("Dec 26, 2024") or null when unknown. */
  date: string | null;
  /**
   * Honesty warning when picking this option removes MORE than one
   * relationship (e.g. a group-reconciled QB unit group reverts together).
   * Rendered in the chooser and carried into the revert confirm copy.
   */
  note?: string | null;
  /**
   * When picking this option removes a whole group of records at once, the
   * individual member records (so the user can see exactly WHICH records are
   * removed before confirming). Rendered as an inline list under the option.
   */
  members?: UnlinkOptionMember[] | null;
}

/** One member record of a group-collapsed unlink option. */
export interface UnlinkOptionMember {
  id: string;
  /** Identifying title, e.g. the QB line description / reference / memo. */
  label: string;
  /** Preformatted amount ("$99.10") or null when unknown. */
  amount: string | null;
  /** Preformatted date ("Dec 26, 2024") or null when unknown. */
  date: string | null;
  /** Extra reference/memo when it adds info beyond the label, or null. */
  reference: string | null;
}

/**
 * Relationship chooser for unlinking a gift that has MULTIPLE linked evidence
 * records: the user picks exactly which relationship to remove. Single-link
 * gifts skip this dialog and keep the one-click revert path.
 */
export function UnlinkChooserDialog({
  open,
  onOpenChange,
  giftLabel,
  options,
  busy,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  giftLabel: string;
  options: UnlinkOption[];
  busy: boolean;
  onPick: (option: UnlinkOption) => void;
}) {
  const [pickedId, setPickedId] = useState<string | null>(null);

  useEffect(() => {
    if (open) setPickedId(null);
  }, [open]);

  const picked = options.find((o) => `${o.anchor.kind}:${o.anchor.id}` === pickedId) ?? null;

  return (
    <Dialog open={open} onOpenChange={(v) => (!busy ? onOpenChange(v) : null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Which link should be removed?</DialogTitle>
          <DialogDescription>
            {giftLabel} is linked to more than one piece of money evidence.
            Pick exactly the relationship to unlink — the others are kept.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={pickedId ?? ""}
          onValueChange={(v) => setPickedId(v)}
          className="max-h-72 overflow-y-auto pr-2 space-y-1"
        >
          {options.map((o) => {
            const key = `${o.anchor.kind}:${o.anchor.id}`;
            return (
              <label
                key={key}
                className="flex items-start gap-2 text-xs cursor-pointer rounded border px-2.5 py-2 hover:bg-muted/60"
              >
                <RadioGroupItem
                  value={key}
                  className="mt-0.5"
                  data-testid={`radio-unlink-${o.anchor.id}`}
                />
                <span className="min-w-0">
                  <span className="font-medium block">{o.source}</span>
                  <span className="text-muted-foreground block">
                    {[o.amount, o.date].filter(Boolean).join(" · ") || "no amount / date on record"}
                  </span>
                  {o.note ? (
                    <span
                      className="text-amber-700 dark:text-amber-500 block mt-0.5"
                      data-testid={`text-unlink-note-${o.anchor.id}`}
                    >
                      {o.note}
                    </span>
                  ) : null}
                  {o.members && o.members.length > 0 ? (
                    <span
                      className="block mt-1.5 space-y-1 border-l-2 border-muted pl-2"
                      data-testid={`list-unlink-members-${o.anchor.id}`}
                    >
                      {o.members.map((m) => (
                        <span
                          key={m.id}
                          className="block"
                          data-testid={`text-unlink-member-${m.id}`}
                        >
                          <span className="block truncate">{m.label}</span>
                          <span className="text-muted-foreground block">
                            {[m.amount, m.date].filter(Boolean).join(" · ") ||
                              "no amount / date on record"}
                          </span>
                          {m.reference ? (
                            <span className="text-muted-foreground block truncate">
                              {m.reference}
                            </span>
                          ) : null}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </RadioGroup>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onOpenChange(false)}
            data-testid="button-unlink-chooser-cancel"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || !picked}
            onClick={() => {
              if (picked) onPick(picked);
            }}
            data-testid="button-unlink-chooser-continue"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Unlink this relationship…
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One evidence record (Stripe charge / QB row) offered as a match target for a gift. */
export interface EvidencePickOption {
  /** Structurally matches rows.tsx AnchorRef (kept structural to avoid an import cycle). */
  anchor: { kind: "charge" | "staged"; id: string; label: string };
  /** e.g. "Stripe charge · Jane Donor" or "QuickBooks · Deposit 4/12" */
  source: string;
  amount: string | null;
  date: string | null;
  /**
   * When set, the row renders grayed-but-VISIBLE with the blocking reason
   * labeled (never hidden — a mis-derived status must stay spottable).
   */
  disabledReason?: string | null;
}

/**
 * Gift-side "Match to …" chooser: pick the evidence record IN this cluster the
 * gift is paid by. Unpickable rows stay visible with their blocking reason.
 */
export function EvidenceChooserDialog({
  open,
  onOpenChange,
  giftLabel,
  options,
  busy,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  giftLabel: string;
  options: EvidencePickOption[];
  busy: boolean;
  onPick: (option: EvidencePickOption) => void;
}) {
  const [pickedId, setPickedId] = useState<string | null>(null);

  useEffect(() => {
    if (open) setPickedId(null);
  }, [open]);

  const picked =
    options.find(
      (o) => !o.disabledReason && `${o.anchor.kind}:${o.anchor.id}` === pickedId,
    ) ?? null;

  return (
    <Dialog open={open} onOpenChange={(v) => (!busy ? onOpenChange(v) : null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Which record pays this gift?</DialogTitle>
          <DialogDescription>
            Pick the money evidence in this row that {giftLabel} is paid by.
            Records that can&apos;t be picked stay listed with the reason.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={pickedId ?? ""}
          onValueChange={(v) => setPickedId(v)}
          className="max-h-72 overflow-y-auto pr-2 space-y-1"
        >
          {options.map((o) => {
            const key = `${o.anchor.kind}:${o.anchor.id}`;
            const blocked = Boolean(o.disabledReason);
            return (
              <label
                key={key}
                className={
                  blocked
                    ? "flex items-start gap-2 text-xs rounded border px-2.5 py-2 opacity-60 cursor-not-allowed"
                    : "flex items-start gap-2 text-xs cursor-pointer rounded border px-2.5 py-2 hover:bg-muted/60"
                }
              >
                <RadioGroupItem
                  value={key}
                  disabled={blocked}
                  className="mt-0.5"
                  data-testid={`radio-evidence-${o.anchor.id}`}
                />
                <span className="min-w-0">
                  <span className="font-medium block">{o.source}</span>
                  <span className="text-muted-foreground block">
                    {[o.amount, o.date].filter(Boolean).join(" · ") ||
                      "no amount / date on record"}
                  </span>
                  {o.disabledReason ? (
                    <span
                      className="text-amber-700 dark:text-amber-500 block mt-0.5"
                      data-testid={`text-evidence-blocked-${o.anchor.id}`}
                    >
                      {o.disabledReason}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </RadioGroup>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onOpenChange(false)}
            data-testid="button-evidence-chooser-cancel"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || !picked}
            onClick={() => {
              if (picked) onPick(picked);
            }}
            data-testid="button-evidence-chooser-continue"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Link this evidence
          </Button>
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
  linkage,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  record: WorkbenchClusterQbRecord | null;
  /** Linkage word derived from coverage.state.qbCards — the one per-record QB status source. */
  linkage?: string | null;
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
            <DetailRow label="Status" value={linkage ?? null} />
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

// ─── Group QuickBooks records ─────────────────────────────────────────────────

/**
 * Pick other staged QB rows to group with `record` into ONE reconciliation
 * unit (same endpoint as the queue workbench's multi-select "Group" action).
 * Per the app-wide picker rule, unpickable rows stay visible — grayed out with
 * the blocking reason labeled — so a mis-derived status is easy to spot.
 */
export function GroupQbDialog({
  record,
  open,
  onOpenChange,
  busy,
  onSubmit,
}: {
  record: WorkbenchClusterQbRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  /** Called with the OTHER staged payment ids picked (the caller prepends the anchor's own id). */
  onSubmit: (stagedPaymentIds: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const debouncedQ = useDebounce(q.trim());
  const [results, setResults] = useState<ReconciliationCard[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Monotonic sequence so a slow earlier response can't clobber a newer search.
  const searchSeq = useRef(0);

  // Fresh state per open.
  useEffect(() => {
    if (open) {
      setQ("");
      setPicked(new Set());
    }
  }, [open, record?.stagedPaymentId]);

  useEffect(() => {
    if (!open) return;
    const seq = ++searchSeq.current;
    setSearching(true);
    listReconciliationCards({
      ...(debouncedQ ? { q: debouncedQ } : {}),
      limit: 20,
    })
      .then((res) => {
        if (seq === searchSeq.current) setResults(res.data ?? []);
      })
      .catch(() => {
        if (seq === searchSeq.current) setResults([]);
      })
      .finally(() => {
        if (seq === searchSeq.current) setSearching(false);
      });
  }, [open, debouncedQ]);

  if (!record) return null;

  /** Blocking reason for a result row, or null when pickable. */
  const blockReason = (c: ReconciliationCard): string | null => {
    if (c.stagedPaymentId === record.stagedPaymentId)
      return "This is the row being grouped";
    if (c.stripeChargeId)
      return "Stripe charge-level card — grouping applies to whole QB rows";
    if (c.status === "match_confirmed") return "Already reconciled to a gift";
    if (c.status === "excluded") return "Excluded — re-include first";
    return null;
  };

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Group QuickBooks records</DialogTitle>
          <DialogDescription>
            Pick the other staged QuickBooks rows that belong to the same money
            event as{" "}
            <span className="font-medium">
              {record.reference ?? record.memo ?? "this record"}
            </span>
            {record.amount != null ? ` (${formatCurrency(record.amount)})` : ""}.
            The group reconciles as one unit into one gift.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search payer, reference, or memo…"
            data-testid="input-group-qb-search"
          />
          {searching ? (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : null}
        </div>

        <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-1">
          {results.length === 0 && !searching ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No open staged payments match.
            </p>
          ) : (
            results.map((c) => {
              const reason = blockReason(c);
              const key = `${c.stagedPaymentId}:${c.stripeChargeId ?? ""}`;
              const checked = picked.has(c.stagedPaymentId);
              return (
                <label
                  key={key}
                  className={`flex items-start gap-2 rounded px-2 py-1.5 text-sm ${
                    reason
                      ? "cursor-not-allowed opacity-50"
                      : "cursor-pointer hover:bg-muted"
                  }`}
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={checked}
                    disabled={!!reason || busy}
                    onCheckedChange={() => toggle(c.stagedPaymentId)}
                    data-testid={`checkbox-group-qb-${c.stagedPaymentId}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-medium">
                        {c.payerName ?? c.rawReference ?? "(no payer)"}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {c.amount != null ? formatCurrency(c.amount) : "—"}
                      </span>
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[
                        c.dateReceived ? formatDateShort(c.dateReceived) : null,
                        c.qbDocNumber ?? c.rawReference,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {reason ? (
                      <span className="block text-xs italic text-muted-foreground">
                        {reason}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            onClick={() => onSubmit(Array.from(picked))}
            disabled={busy || picked.size < 1}
            data-testid="button-group-qb-submit"
          >
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Group {picked.size + 1} records
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
