import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  useListEntities,
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  type GiftOrPayment,
  type OpportunityOrPledge,
  type MintGiftOverridesBody,
  type ListGiftsAndPaymentsParams,
  type ListOpportunitiesAndPledgesParams,
} from "@workspace/api-client-react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { DonorFieldPicker, type DonorType } from "@/components/entity-picker";
import {
  PreviewField,
  type EvidencePreview,
} from "@/components/reconciliation-clusters/dialogs";
import type { CreateGiftPrefill } from "@/components/reconciliation-clusters/actions";
import { giftDonorName } from "@/components/gift-search-dialog";
import { OppStatusBadge } from "@/components/opp-combobox";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateShort, formatEnum } from "@/lib/format";

// ─── Gifts-column dialogs for the deposit workbench ──────────────────────────
//
// CreateStandaloneGiftDialog: mint a NEW gift from a payment-evidence row
// (Stripe charge or QB staged payment). The amount is locked to the evidence;
// name / date received / entity / counts-toward-goal are overridable. Only
// fields the user actually changes are sent — omitted fields keep the server's
// evidence-derived defaults (so an untouched entity keeps the QuickBooks
// attribution instead of clearing it).
//
// LinkEvidenceSearchDialog: unified search across existing gifts AND
// opportunities/pledges to link the evidence row to. Picks are handed back to
// the page, which owns the mutation (link-gift vs approve-with-outcome).

const EVIDENCE_DEFAULT = "__evidence_default__";
const NO_ENTITY = "__none__";

export function pledgePaymentBlockedReason(
  opp: OpportunityOrPledge,
  pledgeOnly: boolean,
): string | null {
  if (opp.archivedAt) return "Archived — restore it before recording money.";
  if (opp.lossType === "lost")
    return "Marked lost — payments can't be recorded on a lost record.";
  if (opp.lossType === "dormant")
    return "Marked dormant — reactivate the pledge to record a payment.";
  const finalized =
    opp.pledgeCommittedAt != null ||
    (opp.commitmentPath == null && opp.writtenPledge === true);
  if (pledgeOnly && !finalized)
    return "Still an open opportunity — finalize it as a written or verbal pledge before recording a payment.";
  return null;
}

export function OpportunityPaymentChoiceDialog({
  open,
  onOpenChange,
  opportunity,
  recordLabel,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opportunity: OpportunityOrPledge | null;
  recordLabel: string;
  busy: boolean;
  onSubmit: (transition: "gift" | "pledge") => void;
}) {
  const plannedAmount = opportunity?.awardedAmount ?? opportunity?.askAmount;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        data-testid="dialog-opportunity-payment-choice"
      >
        <DialogHeader>
          <DialogTitle>How did this opportunity resolve?</DialogTitle>
          <DialogDescription>
            “{recordLabel}” is received money, while “
            {opportunity?.name ?? "the selected opportunity"}” is still open.
            Choose the fundraising outcome before the system creates its payment
            record.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <Button
            type="button"
            variant="outline"
            className="h-auto justify-start px-4 py-3 text-left"
            disabled={busy}
            onClick={() => onSubmit("gift")}
            data-testid="button-opportunity-as-gift"
          >
            <span>
              <span className="block font-medium">Record as a won gift</span>
              <span className="block whitespace-normal text-xs font-normal text-muted-foreground">
                Treat this payment as the full one-time award and close the
                opportunity as cash received.
              </span>
            </span>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-auto justify-start px-4 py-3 text-left"
            disabled={busy}
            onClick={() => onSubmit("pledge")}
            data-testid="button-opportunity-as-pledge"
          >
            <span>
              <span className="block font-medium">
                Convert to a pledge and record the first payment
              </span>
              <span className="block whitespace-normal text-xs font-normal text-muted-foreground">
                {plannedAmount
                  ? `Keep ${formatCurrency(plannedAmount)} as the total commitment.`
                  : "Use this payment as the initial commitment amount; the pledge can be edited afterward."}
              </span>
            </span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CreateStandaloneGiftDialog({
  open,
  onOpenChange,
  recordLabel,
  preview,
  contextNote,
  prefill,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recordLabel: string;
  preview: EvidencePreview | null;
  /** e.g. a coding-form suggestion carried over from the lookup dialog. */
  contextNote?: string | null;
  /** Evidence-known editable defaults; blank means "server derives it". */
  prefill: CreateGiftPrefill | null;
  busy: boolean;
  onSubmit: (
    type: DonorType,
    id: string,
    overrides: MintGiftOverridesBody,
  ) => void;
}) {
  const [donorType, setDonorType] = useState<DonorType>("organization");
  const [donorId, setDonorId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [dateReceived, setDateReceived] = useState("");
  const [entityChoice, setEntityChoice] = useState<string>(EVIDENCE_DEFAULT);
  const [goalChoice, setGoalChoice] = useState<"default" | "yes" | "no">(
    "default",
  );
  const { data: entities } = useListEntities();

  const prefillName = prefill?.name?.trim() ?? "";
  const prefillDate = prefill?.dateReceived?.slice(0, 10) ?? "";

  useEffect(() => {
    if (open) {
      setDonorType("organization");
      setDonorId(null);
      setName(prefillName);
      setDateReceived(prefillDate);
      setEntityChoice(EVIDENCE_DEFAULT);
      setGoalChoice("default");
    }
    // Reset only on (re)open — prefill is fixed for a given opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const buildOverrides = (): MintGiftOverridesBody => {
    const body: MintGiftOverridesBody = {};
    const trimmed = name.trim();
    if (trimmed && trimmed !== prefillName) body.name = trimmed;
    if (dateReceived && dateReceived !== prefillDate)
      body.dateReceived = dateReceived;
    if (entityChoice === NO_ENTITY) body.entityId = null;
    else if (entityChoice !== EVIDENCE_DEFAULT) body.entityId = entityChoice;
    if (goalChoice !== "default") body.countsTowardGoal = goalChoice === "yes";
    return body;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        data-testid="dialog-create-standalone-gift"
      >
        <DialogHeader>
          <DialogTitle>Create standalone gift</DialogTitle>
          <DialogDescription>
            Mint a new gift from “{recordLabel}”. The amount is locked to the
            payment evidence; leave a field untouched to keep its
            evidence-derived default.
          </DialogDescription>
        </DialogHeader>
        {contextNote ? (
          <p className="rounded-md border border-dashed bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            {contextNote}
          </p>
        ) : null}
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Donor</Label>
            <DonorFieldPicker
              type={donorType}
              id={donorId}
              onChange={(t, id) => {
                setDonorType(t);
                setDonorId(id);
              }}
              testIdBase="standalone-gift-donor"
              disabled={busy}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Gift name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="From evidence when left blank"
                disabled={busy}
                data-testid="input-standalone-gift-name"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Date received</Label>
              <Input
                type="date"
                value={dateReceived}
                onChange={(e) => setDateReceived(e.target.value)}
                disabled={busy}
                data-testid="input-standalone-gift-date"
              />
              {!dateReceived ? (
                <p className="text-[10px] text-muted-foreground">
                  Blank keeps the evidence date.
                </p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Receiving entity</Label>
              <Select
                value={entityChoice}
                onValueChange={setEntityChoice}
                disabled={busy}
              >
                <SelectTrigger data-testid="select-standalone-gift-entity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EVIDENCE_DEFAULT}>
                    Default (from evidence)
                  </SelectItem>
                  <SelectItem value={NO_ENTITY}>No entity</SelectItem>
                  {(entities ?? []).map((entity) => (
                    <SelectItem key={entity.id} value={entity.id}>
                      {entity.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Counts toward goals</Label>
              <Select
                value={goalChoice}
                onValueChange={(v) =>
                  setGoalChoice(v as "default" | "yes" | "no")
                }
                disabled={busy}
              >
                <SelectTrigger data-testid="select-standalone-gift-goal">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">
                    Default (from evidence)
                  </SelectItem>
                  <SelectItem value="yes">Counts toward goals</SelectItem>
                  <SelectItem value="no">Doesn't count</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {preview ? (
            <div className="grid grid-cols-2 gap-3">
              <PreviewField label="Amount" value={preview.amount} locked />
              <PreviewField
                label="Payment method"
                value={preview.method}
                locked
              />
              <div className="col-span-2">
                <PreviewField
                  label="Source"
                  value={preview.source}
                  locked
                  hint={preview.memo ?? undefined}
                />
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || !donorId}
            onClick={() => {
              if (donorId) onSubmit(donorType, donorId, buildOverrides());
            }}
            data-testid="button-standalone-gift-create"
          >
            {busy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Create gift
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LinkEvidenceSearchDialog({
  open,
  onOpenChange,
  mode,
  busy,
  onPickGift,
  onPickOpp,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** all records, opportunity/pledge-only, or finalized pledge-only. */
  mode: "all" | "opportunities" | "pledges";
  busy: boolean;
  onPickGift: (gift: GiftOrPayment) => void;
  onPickOpp: (opp: OpportunityOrPledge) => void;
}) {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    if (open) {
      setText("");
      setDebounced("");
    }
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 300);
    return () => clearTimeout(t);
  }, [text]);

  const giftParams: ListGiftsAndPaymentsParams = useMemo(
    () => ({
      ...(debounced.trim() ? { search: debounced.trim() } : {}),
      sort: "date_desc",
      limit: 10,
    }),
    [debounced],
  );
  const giftsEnabled = open && mode === "all";
  const gifts = useListGiftsAndPayments(giftParams, {
    query: {
      queryKey: getListGiftsAndPaymentsQueryKey(giftParams),
      enabled: giftsEnabled,
    },
  });

  const oppParams: ListOpportunitiesAndPledgesParams = useMemo(
    () => ({
      ...(debounced.trim() ? { search: debounced.trim() } : {}),
      ...(mode === "pledges" ? { pledgeView: "pledges" as const } : {}),
      limit: 10,
      page: 1,
    }),
    [debounced, mode],
  );
  const opps = useListOpportunitiesAndPledges(oppParams, {
    query: {
      queryKey: getListOpportunitiesAndPledgesQueryKey(oppParams),
      enabled: open,
    },
  });

  // Pledge-only is an explicit shortcut. The unified search also offers open
  // opportunities; choosing one asks how it resolved before booking money.
  const pledgeOnly = mode === "pledges";
  const oppRowBlockedReason = (opp: OpportunityOrPledge): string | null =>
    pledgePaymentBlockedReason(opp, pledgeOnly);

  const giftRows = gifts.data?.data ?? [];
  const oppRows = opps.data?.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        data-testid="dialog-link-evidence-search"
      >
        <DialogHeader>
          <DialogTitle>
            {mode === "pledges"
              ? "Record as payment on pledge"
              : mode === "opportunities"
                ? "Apply to an opportunity or pledge"
              : "Search and link"}
          </DialogTitle>
          <DialogDescription>
            {mode === "pledges"
              ? "Pick the pledge this payment fulfills — it books a gift/payment under that pledge."
              : mode === "opportunities"
                ? "Pick a pledge to record a payment, or an open opportunity to record its gift-or-pledge outcome."
              : "Link this payment evidence to an existing gift, or book it against an opportunity or pledge."}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search by donor, name or reference…"
          data-testid="input-link-evidence-search"
        />
        <Separator />
        <div className="max-h-80 space-y-3 overflow-y-auto">
          {mode === "all" ? (
            <div className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Gifts
              </p>
              {gifts.isFetching && giftRows.length === 0 ? (
                <p className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
                </p>
              ) : giftRows.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">
                  No gifts match.
                </p>
              ) : (
                giftRows.map((g) => {
                  const alreadyLinked = g.hasPaymentEvidence === true;
                  return (
                    <button
                      key={g.id}
                      type="button"
                      disabled={busy}
                      onClick={() => onPickGift(g)}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                        alreadyLinked &&
                          "border-dashed bg-muted/50 text-muted-foreground",
                        busy
                          ? "cursor-not-allowed opacity-50"
                          : alreadyLinked
                            ? "hover:bg-muted"
                            : "hover:bg-muted/70",
                      )}
                      data-testid={`link-evidence-gift-${g.id}`}
                      data-already-linked={alreadyLinked ? "true" : "false"}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {giftDonorName(g)}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[
                            g.dateReceived
                              ? formatDateShort(g.dateReceived)
                              : null,
                            g.type ? formatEnum(g.type) : null,
                            g.name && g.name !== giftDonorName(g)
                              ? g.name
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "Gift"}
                        </span>
                        {alreadyLinked ? (
                          <span className="mt-1 block text-[11px] font-medium text-amber-700 dark:text-amber-300">
                            Already linked — selecting will disconnect and move
                            it
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {formatCurrency(g.amount ?? "0")}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          ) : null}
          <div className="space-y-1">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              {mode === "pledges" ? "Pledges" : "Opportunities & pledges"}
            </p>
            {mode === "all" ? (
              <p className="text-[11px] text-muted-foreground">
                Pick a pledge to record a payment, or an open opportunity to
                record its gift-or-pledge outcome.
              </p>
            ) : null}
            {opps.isFetching && oppRows.length === 0 ? (
              <p className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
              </p>
            ) : oppRows.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">
                {mode === "pledges"
                  ? "No pledges match."
                  : "No opportunities or pledges match."}
              </p>
            ) : (
              oppRows.map((opp) => {
                const blockedReason = oppRowBlockedReason(opp);
                const blocked = blockedReason != null;
                return (
                  <button
                    key={opp.id}
                    type="button"
                    disabled={busy || blocked}
                    onClick={() => onPickOpp(opp)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                      busy || blocked
                        ? "cursor-not-allowed opacity-50"
                        : "hover:bg-muted",
                    )}
                    data-testid={`link-evidence-opp-${opp.id}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {opp.name ?? opp.id}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[
                          opp.organizationName ??
                            opp.householdName ??
                            opp.individualGiverPersonName ??
                            null,
                          (opp.awardedAmount ?? opp.askAmount)
                            ? formatCurrency(
                                (opp.awardedAmount ?? opp.askAmount) as string,
                              )
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "Opportunity"}
                      </span>
                      {blockedReason ? (
                        <span className="block whitespace-normal text-[11px] text-muted-foreground">
                          {blockedReason}
                        </span>
                      ) : null}
                    </span>
                    <OppStatusBadge status={opp.status} />
                  </button>
                );
              })
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
