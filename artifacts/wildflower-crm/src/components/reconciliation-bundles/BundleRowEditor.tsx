import { useState } from "react";
import { RotateCcw } from "lucide-react";
import type {
  BundleChargeRow,
  BundleNewDonorDraftKind,
  BundleRowOverride,
  ReconciliationCandidate,
  StagedPaymentExclusionReason,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DonorFieldPicker } from "@/components/entity-picker";
import { ReconciliationNodeTypeahead } from "@/components/reconciliation-node-typeahead";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  CANDIDATE_SOURCE_LABEL,
  EXCLUSION_REASON_LABELS,
  MANUAL_EXCLUSION_FAMILIES,
} from "@/lib/reconciliation";
import {
  CONFIDENCE_TIER_LABEL,
  confidenceTierClass,
  donorTypeToRecordKind,
  recordKindToDonorType,
  warningSeverityClass,
} from "./bundle-ui";

const DONOR_MODES = [
  { id: "existing", label: "Existing" },
  { id: "new", label: "New" },
  { id: "unresolved", label: "Unresolved" },
] as const;

const GIFT_MODES = [
  { id: "match", label: "Match" },
  { id: "mint", label: "Mint" },
  { id: "research", label: "Research" },
  { id: "exclude", label: "Exclude" },
] as const;

const NEW_DONOR_KINDS: { id: BundleNewDonorDraftKind; label: string }[] = [
  { id: "organization", label: "Organization" },
  { id: "person", label: "Person" },
  { id: "household", label: "Household" },
];

/**
 * One editable charge row in a settlement bundle. Every edit emits a single
 * {@link BundleRowOverride}; the server re-derives the rest of the bundle and
 * the parent re-renders this row from the fresh proposal. Text fields commit on
 * blur (predictable, no derive feedback loop); selects/pickers commit instantly.
 */
export function BundleRowEditor({
  row,
  disabled,
  onOverride,
}: {
  row: BundleChargeRow;
  disabled: boolean;
  onOverride: (override: BundleRowOverride) => void;
}) {
  const donor = row.donor;
  const gift = row.gift;

  // Local seed for the new-donor draft (committed on blur / kind change).
  const [newName, setNewName] = useState(donor.newDonor?.name ?? "");
  const [newEmail, setNewEmail] = useState(donor.newDonor?.email ?? "");
  const newKind: BundleNewDonorDraftKind = donor.newDonor?.kind ?? "organization";

  const commitNewDonor = (overrides?: Partial<{ kind: BundleNewDonorDraftKind; name: string; email: string }>) => {
    const kind = overrides?.kind ?? newKind;
    const name = overrides?.name ?? newName;
    const email = overrides?.email ?? newEmail;
    onOverride({
      rowKey: row.rowKey,
      donorKind: "new",
      newDonor: { kind, name, email: email || null },
    });
  };

  const matchedAsCandidate: ReconciliationCandidate | null =
    gift.kind === "match" && gift.giftId
      ? {
          nodeType: "gift",
          id: gift.giftId,
          label: gift.giftName ?? gift.giftId,
          sublabel: gift.giftDonorName ?? null,
          amount: gift.giftAmount ?? null,
        }
      : null;

  return (
    <div className="rounded-lg border bg-card p-3 text-sm">
      {/* Source facts */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">
            {row.amount != null ? formatCurrency(row.amount) : "—"}
          </span>
          {row.feeAmount != null && (
            <span className="text-xs text-muted-foreground">
              fee {formatCurrency(row.feeAmount)}
            </span>
          )}
          {row.netAmount != null && (
            <span className="text-xs text-muted-foreground">
              net {formatCurrency(row.netAmount)}
            </span>
          )}
          {row.dateReceived && (
            <span className="text-xs text-muted-foreground">
              {formatDate(row.dateReceived)}
            </span>
          )}
          {row.payerName && (
            <span className="text-xs text-muted-foreground">
              · {row.payerName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {row.ready ? (
            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
              Ready
            </Badge>
          ) : (
            <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
              Needs review
            </Badge>
          )}
          {row.provenance === "override" && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              disabled={disabled}
              onClick={() => onOverride({ rowKey: row.rowKey, clear: true })}
              data-testid={`button-bundle-row-reset-${row.rowKey}`}
            >
              <RotateCcw className="h-3 w-3" /> Reset
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {/* Donor side */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Donor
            </span>
            <Badge
              variant="outline"
              className={confidenceTierClass(donor.confidenceTier)}
            >
              {CONFIDENCE_TIER_LABEL[donor.confidenceTier]}
              {donor.confidence != null ? ` · ${donor.confidence}` : ""}
            </Badge>
          </div>
          <div className="flex gap-1">
            {DONOR_MODES.map((m) => (
              <Button
                key={m.id}
                type="button"
                size="sm"
                variant={donor.kind === m.id ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                disabled={disabled}
                onClick={() => {
                  if (donor.kind !== m.id) {
                    if (m.id === "new") commitNewDonor();
                    else onOverride({ rowKey: row.rowKey, donorKind: m.id });
                  }
                }}
                data-testid={`button-bundle-donor-${m.id}-${row.rowKey}`}
              >
                {m.label}
              </Button>
            ))}
          </div>

          {donor.kind === "existing" && (
            <DonorFieldPicker
              type={recordKindToDonorType(donor.donorKind ?? null)}
              id={donor.donorId ?? null}
              disabled={disabled}
              testIdBase={`bundle-donor-${row.rowKey}`}
              onChange={(type, id) =>
                onOverride({
                  rowKey: row.rowKey,
                  donorKind: "existing",
                  donorRecordKind: donorTypeToRecordKind(type),
                  donorId: id,
                })
              }
            />
          )}

          {donor.kind === "new" && (
            <div className="space-y-2">
              <div className="flex gap-1">
                {NEW_DONOR_KINDS.map((k) => (
                  <Button
                    key={k.id}
                    type="button"
                    size="sm"
                    variant={newKind === k.id ? "default" : "outline"}
                    className="h-7 px-2 text-xs"
                    disabled={disabled}
                    onClick={() => commitNewDonor({ kind: k.id })}
                  >
                    {k.label}
                  </Button>
                ))}
              </div>
              <Input
                value={newName}
                disabled={disabled}
                placeholder="Name"
                className="h-8"
                onChange={(e) => setNewName(e.target.value)}
                onBlur={() => commitNewDonor()}
                data-testid={`input-bundle-newdonor-name-${row.rowKey}`}
              />
              <Input
                value={newEmail}
                disabled={disabled}
                placeholder="Email (optional)"
                className="h-8"
                onChange={(e) => setNewEmail(e.target.value)}
                onBlur={() => commitNewDonor()}
                data-testid={`input-bundle-newdonor-email-${row.rowKey}`}
              />
            </div>
          )}

          {donor.kind === "unresolved" && (
            <p className="text-xs text-muted-foreground">
              No confident donor match — pick an existing record or mint a new one.
            </p>
          )}

          {/* Donor candidate suggestions */}
          {donor.candidates.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {donor.candidates
                .filter((c) => c.donorKind)
                .slice(0, 4)
                .map((c) => (
                  <Button
                    key={`${c.id}-${c.donorKind}`}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={disabled}
                    onClick={() =>
                      onOverride({
                        rowKey: row.rowKey,
                        donorKind: "existing",
                        donorRecordKind: c.donorKind,
                        donorId: c.id,
                      })
                    }
                    title={c.source ? CANDIDATE_SOURCE_LABEL[c.source] : undefined}
                  >
                    {c.label}
                    {c.confidence != null ? ` · ${c.confidence}` : ""}
                  </Button>
                ))}
            </div>
          )}
        </div>

        {/* Gift side */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Gift
            </span>
            <Badge
              variant="outline"
              className={confidenceTierClass(gift.confidenceTier)}
            >
              {CONFIDENCE_TIER_LABEL[gift.confidenceTier]}
              {gift.confidence != null ? ` · ${gift.confidence}` : ""}
            </Badge>
          </div>
          <div className="flex gap-1">
            {GIFT_MODES.map((m) => (
              <Button
                key={m.id}
                type="button"
                size="sm"
                variant={gift.kind === m.id ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                disabled={disabled}
                onClick={() => {
                  if (gift.kind !== m.id)
                    onOverride({ rowKey: row.rowKey, giftKind: m.id });
                }}
                data-testid={`button-bundle-gift-${m.id}-${row.rowKey}`}
              >
                {m.label}
              </Button>
            ))}
          </div>

          {gift.kind === "match" &&
            (row.stagedPaymentId ? (
              <ReconciliationNodeTypeahead
                nodeType="gift"
                stagedPaymentId={row.stagedPaymentId}
                donorId={donor.donorId ?? undefined}
                value={matchedAsCandidate}
                disabled={disabled}
                placeholder="Search gifts…"
                testId={`bundle-gift-match-${row.rowKey}`}
                onChange={(c) =>
                  onOverride({
                    rowKey: row.rowKey,
                    giftKind: "match",
                    giftId: c?.id ?? null,
                  })
                }
              />
            ) : gift.candidates.length > 0 ? (
              <div className="space-y-1">
                {gift.candidates.slice(0, 5).map((c) => {
                  const linked = Boolean(c.alreadyLinkedStagedPaymentId);
                  const selected = gift.giftId === c.id;
                  return (
                    <Button
                      key={c.id}
                      type="button"
                      size="sm"
                      variant={selected ? "default" : "outline"}
                      className="h-auto w-full justify-start whitespace-normal px-2 py-1 text-left text-xs"
                      disabled={disabled || (linked && !selected)}
                      onClick={() =>
                        onOverride({
                          rowKey: row.rowKey,
                          giftKind: "match",
                          giftId: c.id,
                        })
                      }
                    >
                      <span className="font-medium">{c.label}</span>
                      {c.amount != null && (
                        <span className="ml-1 text-muted-foreground">
                          {formatCurrency(c.amount)}
                        </span>
                      )}
                      {linked && (
                        <span className="ml-1 text-destructive">
                          (already linked)
                        </span>
                      )}
                    </Button>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No matching gift found — mint a new gift or park for research.
              </p>
            ))}

          {gift.kind === "match" && gift.giftDonorName && (
            <p className="text-xs text-muted-foreground">
              Recorded under {gift.giftDonorName}
              {gift.giftAmount != null
                ? ` · ${formatCurrency(gift.giftAmount)}`
                : ""}
            </p>
          )}

          {gift.kind === "mint" && (
            <div className="space-y-1">
              <Input
                defaultValue={gift.mintDraft?.amount ?? row.amount ?? ""}
                disabled={disabled}
                placeholder="Amount"
                className="h-8"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (gift.mintDraft?.amount ?? row.amount ?? ""))
                    onOverride({
                      rowKey: row.rowKey,
                      giftKind: "mint",
                      mintAmount: v || null,
                    });
                }}
                data-testid={`input-bundle-mint-amount-${row.rowKey}`}
              />
              <p className="text-xs text-muted-foreground">
                New gift
                {gift.mintDraft?.dateReceived
                  ? ` · ${formatDate(gift.mintDraft.dateReceived)}`
                  : ""}
                {gift.mintDraft?.finalAmountSource
                  ? ` · ${gift.mintDraft.finalAmountSource}`
                  : ""}
              </p>
            </div>
          )}

          {gift.kind === "research" && (
            <p className="text-xs text-muted-foreground">
              Parked for research — no gift will be created on confirm.
            </p>
          )}

          {gift.kind === "exclude" && (
            <Select
              value={gift.exclusionReason ?? undefined}
              disabled={disabled}
              onValueChange={(v) =>
                onOverride({
                  rowKey: row.rowKey,
                  giftKind: "exclude",
                  exclusionReason: v as StagedPaymentExclusionReason,
                })
              }
            >
              <SelectTrigger
                className="h-8"
                data-testid={`select-bundle-exclude-${row.rowKey}`}
              >
                <SelectValue placeholder="Exclude as…" />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_EXCLUSION_FAMILIES.map((fam) => (
                  <SelectGroup key={fam.family}>
                    <SelectLabel>{fam.family}</SelectLabel>
                    {fam.reasons.map((r) => (
                      <SelectItem key={r} value={r}>
                        {EXCLUSION_REASON_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* Warnings */}
      {row.warnings.length > 0 && (
        <div className="mt-3 space-y-1">
          {row.warnings.map((w, i) => (
            <div
              key={`${w.code}-${i}`}
              className={`flex items-start gap-2 rounded-md border px-2 py-1 text-xs ${warningSeverityClass(w.severity)}`}
            >
              <span className="font-medium uppercase">{w.severity}</span>
              <span>{w.message}</span>
            </div>
          ))}
          {row.warnings.some((w) => w.code === "amount_mismatch") && (
            <AmountMismatchAck
              rowKey={row.rowKey}
              disabled={disabled}
              onOverride={onOverride}
            />
          )}
        </div>
      )}
    </div>
  );
}

function AmountMismatchAck({
  rowKey,
  disabled,
  onOverride,
}: {
  rowKey: string;
  disabled: boolean;
  onOverride: (override: BundleRowOverride) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="flex items-center gap-2">
      <Input
        value={reason}
        disabled={disabled}
        placeholder="Reason to accept the amount difference"
        className="h-8"
        onChange={(e) => setReason(e.target.value)}
        data-testid={`input-bundle-amount-ack-${rowKey}`}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 px-2 text-xs"
        disabled={disabled || !reason.trim()}
        onClick={() =>
          onOverride({ rowKey, overrideAmountMismatchReason: reason.trim() })
        }
      >
        Accept
      </Button>
    </div>
  );
}
