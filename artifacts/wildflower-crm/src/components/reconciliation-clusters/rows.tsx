import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  MoreHorizontal,
  X,
} from "lucide-react";
import type {
  WorkbenchCluster,
  WorkbenchClusterCharge,
  WorkbenchClusterGift,
  WorkbenchClusterQbRecord,
  WorkbenchClusterStatus,
  WorkbenchRowState,
  WorkbenchRowLinkCompleteness,
  WorkbenchRowInformationCompleteness,
  WorkbenchRowSettlementLinkState,
} from "@workspace/api-client-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatCurrency, formatDateShort } from "@/lib/format";
import type { EvidencePreview } from "./dialogs";
import {
  CodingBadge,
  DbBadge,
  DonorActions,
  ExcludedCard,
  FacetCard,
  GRID,
  LetterBadge,
  LinkSlot,
  StatusCell,
  SummaryCard,
  type Tone,
} from "./primitives";

/** Derived from generated types — orval doesn't re-export nested subtypes through the tag barrel. */
type AttributedDonor = NonNullable<WorkbenchClusterCharge["attributedDonor"]>;

// ─── Cluster rows: one row per piece of money work, three facet columns ─────

/** The evidence row an action targets: a Stripe charge or a QB staged payment. */
export type AnchorRef =
  | { kind: "charge"; id: string; label: string }
  | { kind: "staged"; id: string; label: string };

/** Action callbacks the page wires to the real endpoints. */
export interface ClusterActions {
  busy: boolean;
  openLinkGift: (anchor: AnchorRef) => void;
  openCreateGift: (anchor: AnchorRef, preview: EvidencePreview) => void;
  openIdentify: (anchor: AnchorRef, preview: EvidencePreview | null) => void;
  openExclude: (anchor: AnchorRef) => void;
  reInclude: (anchor: AnchorRef) => void;
  /** Confirm-gated unlink/undo: reverts a booked link (may delete a minted gift). */
  openRevert: (anchor: AnchorRef, description: string) => void;
  openConfirmRefund: (
    chargeId: string,
    kind: "refund" | "chargeback",
    label: string,
  ) => void;
  openDismissRefund: (chargeId: string, label: string) => void;
  openFlag: (stagedPaymentId: string, label: string) => void;
}

const CLUSTER_STATUS: Record<
  WorkbenchClusterStatus,
  { tone: Tone; word: string }
> = {
  complete: { tone: "green", word: "Complete" },
  partial: { tone: "blue", word: "Partial" },
  unresolved: { tone: "amber", word: "Unresolved" },
  conflict: { tone: "red", word: "Conflict" },
  refund: { tone: "red", word: "Refund proposed" },
  excluded: { tone: "slate", word: "Excluded" },
  unlinked: { tone: "slate", word: "Unlinked" },
};

// ── Canonical row-state display maps (§2, §6 of workbench-business-rules.md) ─

const LINKAGE_META: Record<WorkbenchRowLinkCompleteness, { tone: Tone; word: string }> = {
  complete: { tone: "green", word: "Linked" },
  partial: { tone: "blue", word: "Partial linkage" },
  mixed: { tone: "amber", word: "Mixed linkage" },
  partial_mixed: { tone: "amber", word: "Partial & mixed" },
  missing: { tone: "amber", word: "No linkage" },
};

const INFO_META: Record<WorkbenchRowInformationCompleteness, { tone: Tone; word: string }> = {
  audit_ready: { tone: "green", word: "Audit ready" },
  accounting_pending: { tone: "blue", word: "Accounting pending" },
  incomplete: { tone: "amber", word: "Record incomplete" },
};

const SETTLEMENT_META: Record<WorkbenchRowSettlementLinkState, { tone: Tone; word: string }> = {
  unlinked: { tone: "amber", word: "QB not linked" },
  proposed_full: { tone: "blue", word: "Settlement proposed" },
  proposed_partial: { tone: "blue", word: "Partial settlement" },
  proposed_conflict: { tone: "amber", word: "Settlement conflict" },
  confirmed: { tone: "green", word: "Settlement confirmed" },
};

const QB_ROLE_LABEL: Record<WorkbenchClusterQbRecord["role"], string> = {
  anchor: "QB record",
  deposit: "Deposit",
  fee: "Processor fee",
  charge_tie: "Charge tie",
  group_member: "Group member",
};

function fmt(v: string | null | undefined): string {
  return v != null ? formatCurrency(v) : "—";
}

function donorHref(gift: WorkbenchClusterGift): string | null {
  if (!gift.donorId || !gift.donorKind) return null;
  switch (gift.donorKind) {
    case "organization":
      return `/organizations/${gift.donorId}`;
    case "person":
      return `/individuals/${gift.donorId}`;
    case "household":
      return `/households/${gift.donorId}`;
    default:
      return null;
  }
}

function attributedDonorHref(cd: AttributedDonor): string | null {
  if (!cd) return null;
  switch (cd.donorKind) {
    case "organization": return `/organizations/${cd.donorId}`;
    case "person": return `/individuals/${cd.donorId}`;
    case "household": return `/households/${cd.donorId}`;
    default: return null;
  }
}

/** Shown when a donor has been identified on a specific evidence row (charge or QB row). */
function IdentifiedDonorNote({
  attributedDonor,
}: {
  attributedDonor: AttributedDonor;
}) {
  if (!attributedDonor) return null;
  const href = attributedDonorHref(attributedDonor);
  const name = attributedDonor.donorName ?? "(unnamed)";
  return (
    <div className="text-[11px] text-muted-foreground pb-1 pl-0.5">
      Identified:{" "}
      {href ? (
        <Link
          href={href}
          className="text-primary font-medium hover:underline underline-offset-2"
          onClick={(e) => e.stopPropagation()}
        >
          {name}
        </Link>
      ) : (
        <span className="font-medium">{name}</span>
      )}
      {" — no gift yet"}
    </div>
  );
}

// ── Card-level ⋯ menu ────────────────────────────────────────────────────────

export interface MenuItem {
  label: string;
  onClick?: () => void;
  href?: string;
  /** Opens in a new tab (Stripe / QuickBooks deep links). */
  externalHref?: string;
  /** Grayed out WITH the blocking reason labeled — never hidden. */
  disabledReason?: string;
  destructive?: boolean;
}

function CardMenu({ items, testId }: { items: MenuItem[]; testId: string }) {
  const [, navigate] = useLocation();
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center w-[18px] h-[18px] rounded hover:bg-muted"
          data-testid={testId}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="w-3 h-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {items.map((it) => (
          <DropdownMenuItem
            key={it.label}
            disabled={!!it.disabledReason}
            className={`text-xs ${it.destructive ? "text-destructive focus:text-destructive" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if (it.disabledReason) return;
              if (it.externalHref)
                window.open(it.externalHref, "_blank", "noopener");
              else if (it.href) navigate(it.href);
              else it.onClick?.();
            }}
          >
            <span className="flex flex-col">
              {it.label}
              {it.disabledReason ? (
                <span className="text-[10px] text-muted-foreground">
                  {it.disabledReason}
                </span>
              ) : null}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Facet cards ──────────────────────────────────────────────────────────────

/** The evidence anchor whose revert would unlink this gift, if any. */
function giftUnlinkAnchor(gift: WorkbenchClusterGift): AnchorRef | null {
  const label = gift.name ?? "this gift";
  if (gift.linkedChargeIds && gift.linkedChargeIds.length > 0) {
    return { kind: "charge", id: gift.linkedChargeIds[0], label };
  }
  if (gift.linkedStagedPaymentIds && gift.linkedStagedPaymentIds.length > 0) {
    return { kind: "staged", id: gift.linkedStagedPaymentIds[0], label };
  }
  return null;
}

function GiftCard({
  gift,
  actions,
  rowState,
}: {
  gift: WorkbenchClusterGift;
  actions: ClusterActions;
  rowState?: WorkbenchRowState | null;
}) {
  // Canonical CRM card state (§§8.1).
  const crmEntry = rowState?.crmCards.find((e) => e.giftId === gift.giftId);
  const crmState = crmEntry?.state;
  const satisfiedBy = crmEntry?.satisfiedBy;

  // Tone from canonical state; fall back to QB-tie heuristic.
  const tone: "green" | "amber" | "slate" =
    crmState === "matched_complete" || crmState === "unmatched_complete"
      ? "green"
      : crmState === "lost" || crmState === "dormant"
        ? "slate"
        : crmEntry
          ? "amber"
          : gift.quickbooksTie === "amount_mismatch" || gift.quickbooksTie === "missing"
            ? "amber"
            : "green";

  // Gap line from canonical state; fall back to QB-tie heuristic.
  const stateGap: string | null =
    crmState === "unmatched_incomplete" || crmState === "matched_incomplete"
      ? "CRM record incomplete"
      : crmState === "unmatched_complete"
        ? "Not linked to evidence"
        : crmState === "conflict"
          ? "Data conflict"
          : crmState === "pledge_link_broken"
            ? "Pledge link broken"
            : crmState === "partial_gift_surplus"
              ? "Gift exceeds linked evidence"
              : crmState === "partial_external_surplus"
                ? "Evidence exceeds gift amount"
                : null;
  const qbTieGap: string | null = !crmEntry
    ? gift.quickbooksTie === "amount_mismatch"
      ? "QB amount mismatch"
      : gift.quickbooksTie === "missing"
        ? "No QB record tied yet"
        : null
    : null;

  // Completion-path sub-label (§§3.4).
  const completionLabel: string | null =
    crmState === "matched_complete" || crmState === "unmatched_complete"
      ? satisfiedBy === "donorbox"
        ? "· via Donorbox"
        : satisfiedBy === "completed_coding_form"
          ? "· via coding form"
          : satisfiedBy === "donor_allocations_and_supporting_documents"
            ? "· via donor & allocations"
            : null
      : null;

  const donor = donorHref(gift);
  const unlinkAnchor = giftUnlinkAnchor(gift);
  const incomplete =
    crmState === "unmatched_incomplete" || crmState === "matched_incomplete";
  const unmatchedGift =
    crmState === "unmatched_incomplete" || crmState === "unmatched_complete";
  // Actions per §§8.2, gated on the canonical CRM card state.
  const menu: MenuItem[] = [
    {
      label: incomplete ? "View & complete gift" : "Open gift record",
      href: `/gifts/${gift.giftId}`,
    },
    donor
      ? { label: "Open donor record", href: donor }
      : { label: "Open donor record", disabledReason: "No donor on this gift" },
  ];
  if (crmState === "conflict") {
    menu.push({
      label: "Review conflict — compare sources",
      href: `/gifts/${gift.giftId}`,
    });
  }
  if (crmState === "pledge_link_broken") {
    menu.push({
      label: "Repair pledge link",
      disabledReason: "Not built yet — re-point the pledge from the gift record",
    });
  }
  menu.push(
    unlinkAnchor
      ? {
          label: "Unlink from this match",
          destructive: true,
          onClick: () =>
            actions.openRevert(
              unlinkAnchor,
              `Unlink “${gift.name ?? gift.giftId}” from its evidence. If the gift was minted from this evidence it is deleted; a pre-existing gift is kept and just unlinked.`,
            ),
        }
      : {
          label: "Match to money evidence",
          disabledReason:
            "No money evidence in this row yet — link from a charge or QB card when it arrives",
        },
  );
  if (unmatchedGift || !crmEntry) {
    menu.push(
      {
        label: "Mark gift lost",
        disabledReason: "Not built yet — set the loss type on the gift's opportunity",
      },
      {
        label: "Mark gift dormant",
        disabledReason: "Not built yet — set the loss type on the gift's opportunity",
      },
    );
  }
  menu.push(
    { label: "Flag for research", disabledReason: "Open the gift record to flag it for research" },
    {
      label: "Move to another cluster",
      disabledReason: "Clusters follow the evidence ties — unlink here, then link from the other row",
    },
  );
  return (
    <FacetCard
      tone={tone}
      amount={fmt(gift.amount)}
      name={
        <Link
          href={`/gifts/${gift.giftId}`}
          className="hover:underline underline-offset-2"
          data-testid={`link-cluster-gift-${gift.giftId}`}
          onClick={(e) => e.stopPropagation()}
        >
          {gift.name ?? "(unnamed gift)"}
        </Link>
      }
      sub={
        <>
          {gift.donorName ?? "(no donor)"}
          {gift.dateReceived ? ` · ${formatDateShort(gift.dateReceived)}` : ""}
          {completionLabel ? ` ${completionLabel}` : ""}
        </>
      }
      gap={stateGap ?? qbTieGap}
      badges={
        <>
          {gift.donorbox ? <DbBadge /> : null}
          {gift.codingForm ? <CodingBadge /> : null}
          {gift.grantLetter ? <LetterBadge /> : null}
        </>
      }
      menu={<CardMenu items={menu} testId={`button-gift-menu-${gift.giftId}`} />}
      testId={`card-cluster-gift-${gift.giftId}`}
    />
  );
}

function chargePreview(c: WorkbenchClusterCharge): EvidencePreview {
  return {
    amount: fmt(c.amount),
    date: c.chargeDate ? formatDateShort(c.chargeDate) : "—",
    method: c.cardBrand ? `Card · ${c.cardBrand}` : "Stripe charge",
    source: `Stripe charge ${c.chargeId}`,
    memo: c.description ?? c.statementDescriptor ?? null,
  };
}

function qbPreview(r: WorkbenchClusterQbRecord): EvidencePreview {
  return {
    amount: fmt(r.amount),
    date: r.dateReceived ? formatDateShort(r.dateReceived) : "—",
    method: "QuickBooks payment",
    source: `QuickBooks record ${qbLabel(r)}`,
    memo: r.memo ?? r.lineDescription ?? null,
  };
}

function chargeLabel(c: WorkbenchClusterCharge): string {
  return c.payerName ?? c.chargeId;
}

function ChargeCard({
  charge,
  actions,
  rowState,
}: {
  charge: WorkbenchClusterCharge;
  actions: ClusterActions;
  rowState?: WorkbenchRowState | null;
}) {
  const label = chargeLabel(charge);
  const anchor: AnchorRef = { kind: "charge", id: charge.chargeId, label };
  const excluded = charge.status === "excluded";

  // Canonical transaction facts (§§5.1) — refund status from rowState when present.
  const txnEntry = rowState?.transactions.find((t) => t.transactionId === charge.chargeId);
  const refundProposed = txnEntry
    ? txnEntry.refundStatus === "anticipated"
    : !!charge.refundProposed;
  const linked = !!charge.linkedGiftId;
  const matched = linked && charge.status === "match_confirmed";
  const donorIdentified = !!charge.attributedDonor;
  const tone: "green" | "amber" | "slate" = excluded
    ? "slate"
    : matched && !refundProposed
      ? "green"
      : "amber";

  // Actions per §§5.2, gated on the canonical transaction state.
  const menu: MenuItem[] = [];
  if (refundProposed) {
    const kind = charge.refundKind === "chargeback" ? "chargeback" : "refund";
    menu.push(
      {
        label: `Confirm ${kind}`,
        destructive: true,
        onClick: () => actions.openConfirmRefund(charge.chargeId, kind, label),
      },
      {
        label: `Dismiss ${kind} proposal`,
        onClick: () => actions.openDismissRefund(charge.chargeId, label),
      },
    );
  }
  if (excluded) {
    menu.push({ label: "Re-include", onClick: () => actions.reInclude(anchor) });
  } else if (!refundProposed) {
    if (!linked) {
      // Unmatched transaction: match / create / identify are the real next steps.
      menu.push(
        {
          label: "Link to existing CRM gift",
          onClick: () => actions.openLinkGift(anchor),
        },
        {
          label: "Create new CRM gift",
          onClick: () => actions.openCreateGift(anchor, chargePreview(charge)),
        },
        {
          label: donorIdentified ? "Change identified donor" : "Identify donor",
          onClick: () => actions.openIdentify(anchor, chargePreview(charge)),
        },
        {
          label: "Match to QuickBooks evidence",
          disabledReason:
            "Not built yet — QB deposits tie to the whole payout, not one charge",
        },
      );
    } else {
      menu.push({
        label: "Unlink from CRM gift",
        destructive: true,
        onClick: () =>
          actions.openRevert(
            anchor,
            `Unlink Stripe charge ${label} from its gift. If the gift was minted from this charge it is deleted; a pre-existing gift is kept and just unlinked.`,
          ),
      });
    }
    menu.push(
      {
        label: "Mark refund anticipated",
        disabledReason: "Not built yet — flag via the cleanup queue for now",
      },
      {
        label: "Exclude — not a donation",
        onClick: () => actions.openExclude(anchor),
      },
    );
  }
  menu.push({
    label: "View in Stripe",
    externalHref: `https://dashboard.stripe.com/payments/${charge.chargeId}`,
  });
  const subBits = [
    charge.chargeDate ? formatDateShort(charge.chargeDate) : null,
    charge.cardBrand,
    charge.description ?? charge.statementDescriptor,
  ].filter(Boolean);
  // Per-charge money math — fees fold into the same row as the money they
  // belong to, so gross − fee = net reconciles at the line level.
  const feeMath =
    charge.feeAmount != null && charge.netAmount != null
      ? `${fmt(charge.amount)} gross − ${fmt(charge.feeAmount)} fee = ${fmt(charge.netAmount)} net`
      : null;
  // The gap must not contradict the donor slot: when a donor has been
  // identified on this charge, the missing piece is the gift, not the donor.
  const gap = refundProposed
    ? `${charge.refundKind === "chargeback" ? "Chargeback" : "Refund"} proposed`
    : excluded
      ? null
      : !linked
        ? donorIdentified
          ? "Donor identified — no gift linked yet"
          : "No donor identified"
        : null;
  return (
    <FacetCard
      tone={tone}
      amount={fmt(charge.amount)}
      name={`${label} · Stripe`}
      sub={
        feeMath ? (
          <>
            {subBits.join(" · ")}
            <span className="block tabular-nums">{feeMath}</span>
          </>
        ) : (
          subBits.join(" · ")
        )
      }
      gap={gap}
      menu={
        <CardMenu
          items={menu}
          testId={`button-charge-menu-${charge.chargeId}`}
        />
      }
      testId={`card-cluster-charge-${charge.chargeId}`}
    />
  );
}

/**
 * Card title for a QB record. Prefer the LINE-level description: for deposit
 * lines the reference is transaction-scoped (often a lump like "various
 * donors" or a stale payer), while line_description names the actual money on
 * THIS line. When the reference disagrees with the line, it still shows as a
 * labeled secondary line (see qbReferenceNote) so the discrepancy is visible.
 */
function qbLabel(r: WorkbenchClusterQbRecord): string {
  return r.lineDescription ?? r.reference ?? r.memo ?? r.stagedPaymentId;
}

/** The transaction-level reference, when it adds info beyond the title. */
function qbReferenceNote(r: WorkbenchClusterQbRecord): string | null {
  const label = qbLabel(r);
  if (r.reference && r.reference !== label) return `QB reference: ${r.reference}`;
  if (r.memo && r.memo !== label) return r.memo;
  return null;
}

/** QuickBooks Online transaction-page slug per staged qb_entity_type. */
const QB_TXN_PAGE: Record<string, string> = {
  sales_receipt: "salesreceipt",
  payment: "recvpayment",
  deposit: "deposit",
};

/** Deep link to the QBO transaction this staged row came from, when known. */
function qbHref(r: WorkbenchClusterQbRecord): string | null {
  if (!r.qbEntityType || !r.qbEntityId) return null;
  const page = QB_TXN_PAGE[r.qbEntityType];
  if (!page) return null;
  return `https://app.qbo.intuit.com/app/${page}?txnId=${encodeURIComponent(r.qbEntityId)}`;
}

function QbCard({
  record,
  actions,
  rowState,
}: {
  record: WorkbenchClusterQbRecord;
  actions: ClusterActions;
  rowState?: WorkbenchRowState | null;
}) {
  const roleLabel = QB_ROLE_LABEL[record.role];
  const anchor: AnchorRef = { kind: "staged", id: record.stagedPaymentId, label: qbLabel(record) };
  const excluded = record.status === "excluded";
  const linked = record.status === "match_confirmed";
  const refNote = qbReferenceNote(record);

  // Tone from canonical QB card state (§§7.1).
  const qbEntry = rowState?.qbCards.find((e) => e.qbRecordId === record.stagedPaymentId);
  const qbState = qbEntry?.state;
  const tone: "green" | "amber" | "slate" =
    excluded
      ? "slate"
      : qbState === "matched_complete"
        ? "green"
        : qbState != null
          ? qbState === "excluded"
            ? "slate"
            : "amber"
          : linked
            ? "green"
            : "amber";

  const gap: string | null =
    excluded
      ? null
      : qbState === "matched_partial_qb_surplus"
        ? "QB amount exceeds gift"
        : qbState === "matched_partial_external_surplus"
          ? "External amount exceeds QB"
          : qbState === "matched_conflict"
            ? "Record conflict"
            : !linked
              ? "Not linked to a gift"
              : null;

  // Actions per §§7.2, gated on the canonical QB card state.
  const qbHrefUrl = qbHref(record);
  const isFee = record.role === "fee";
  const menu: MenuItem[] = [];
  if (excluded) {
    menu.push({ label: "Re-include", onClick: () => actions.reInclude(anchor) });
  } else if (isFee) {
    // Processor fees are accounting detail, never donations to match.
    menu.push({
      label: "Exclude — not a donation",
      disabledReason: "Fees are accounting detail on the payout, not standalone records",
    });
  } else if (linked) {
    menu.push(
      {
        label: "Unlink from CRM gift",
        destructive: true,
        onClick: () =>
          actions.openRevert(
            anchor,
            `Unlink QuickBooks record from its gift. If the gift was minted from this QB record it is deleted; a pre-existing gift is kept and just unlinked.`,
          ),
      },
      {
        label: "Fill out QB from CRM",
        disabledReason: rowState?.information.crmComplete
          ? "Not built yet — writing back to QuickBooks is planned"
          : "Complete the CRM gift record first",
      },
    );
  } else {
    // Raw / enriched / partially matched: matching is the real next step.
    menu.push(
      {
        label: "Match to CRM gift",
        onClick: () => actions.openLinkGift(anchor),
      },
      {
        label: "Create gift from this record",
        onClick: () => actions.openCreateGift(anchor, qbPreview(record)),
      },
      {
        label: "Match to transaction",
        disabledReason: "Not built yet — charge ties are proposed by the Stripe sync",
      },
      {
        label: "Exclude — not a donation",
        onClick: () => actions.openExclude(anchor),
      },
    );
  }
  if (!isFee) {
    menu.push(
      {
        label: "Group QuickBooks records",
        disabledReason: "Not built yet — grouping several QB rows into one event",
      },
      {
        label: "Split into reconciliation units",
        disabledReason: "Not built yet — splitting one QB row into parts",
      },
    );
  }
  menu.push(
    {
      label: "Flag for research",
      onClick: () => actions.openFlag(record.stagedPaymentId, qbLabel(record)),
    },
    qbHrefUrl
      ? { label: "View in QuickBooks", externalHref: qbHrefUrl }
      : { label: "View in QuickBooks", disabledReason: "No QB entity ID available" },
  );

  return (
    <FacetCard
      tone={tone}
      amount={record.amount != null ? fmt(record.amount) : null}
      name={
        <>
          {qbLabel(record)}
          <span className="font-normal text-muted-foreground"> · {roleLabel}</span>
        </>
      }
      sub={
        <>
          {record.dateReceived ? formatDateShort(record.dateReceived) : null}
          {record.memo ? ` · ${record.memo}` : null}
          {refNote ? <span className="block text-xs text-muted-foreground">{refNote}</span> : null}
        </>
      }
      gap={gap}
      menu={
        <CardMenu
          items={menu}
          testId={`button-qb-menu-${record.stagedPaymentId}`}
        />
      }
      testId={`card-cluster-qb-${record.stagedPaymentId}`}
    />
  );
}

// ── Row-level kebab (cluster-wide actions) ───────────────────────────────────

function RowKebab({ clusterId }: { clusterId: string }) {
  const [, navigate] = useLocation();
  const items: MenuItem[] = [
    {
      label: "Approve all matches in cluster",
      disabledReason: "Not available yet — confirm each match on its card",
    },
    {
      label: "Split this cluster",
      disabledReason:
        "Cluster boundaries follow the payout and deposit ties — they can't be split by hand",
    },
    {
      label: "View change history",
      disabledReason: "Not available yet",
    },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-muted shrink-0"
          data-testid={`button-row-kebab-${clusterId}`}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {items.map((it) => (
          <DropdownMenuItem
            key={it.label}
            disabled={!!it.disabledReason}
            className="text-xs"
            onClick={(e) => {
              e.stopPropagation();
              if (it.disabledReason) return;
              it.onClick?.();
            }}
          >
            <span className="flex flex-col">
              {it.label}
              {it.disabledReason ? (
                <span className="text-[10px] text-muted-foreground">
                  {it.disabledReason}
                </span>
              ) : null}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Per-charge status (child rows of an expanded payout bundle) ─────────────

function chargeStatus(
  c: WorkbenchClusterCharge,
  coverage: WorkbenchCluster["coverage"],
): {
  tone: Tone;
  word: string;
  detail?: string;
} {
  if (c.status === "excluded") return { tone: "slate", word: "Excluded" };
  if (c.refundProposed) {
    return {
      tone: "red",
      word:
        c.refundKind === "chargeback" ? "Chargeback proposed" : "Refund proposed",
      detail: "confirm or dismiss on the charge card",
    };
  }
  if (c.linkedGiftId) {
    // Per-charge a linked gift is "Gift booked"; only the cluster level says "Complete".
    if (c.status === "match_confirmed") return { tone: "green", word: "Gift booked" };
    return { tone: "blue", word: "Linked", detail: "awaiting confirm" };
  }
  if (coverage?.donorPurpose.crmLinkage.grain === "bundle" && coverage.donorPurpose.crmLinkage.complete) {
    return { tone: "green", word: "Covered", detail: "deposit-grain gift" };
  }
  return {
    tone: "amber",
    word: "Missing donor",
    detail: "pick an action at left",
  };
}

// ── The three row shapes ─────────────────────────────────────────────────────

/** Small inline next-step button under the status word. */
function StatusAction({
  label,
  onClick,
  testId,
}: {
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      className="text-[10px] font-semibold text-primary hover:underline underline-offset-2"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      data-testid={testId}
    >
      {label} →
    </button>
  );
}

/** ⋯ menu on the "No QB deposit linked yet" card — §§6.2 settlement-link
 * actions for the `unlinked` state (shown grayed with the honest reason until
 * the manual settlement flows are built). */
function SettlementGapMenu({ clusterId }: { clusterId: string }) {
  return (
    <CardMenu
      items={[
        {
          label: "Search QuickBooks for this deposit",
          disabledReason:
            "Not built yet — deposit matches are proposed by the QuickBooks sync",
        },
        {
          label: "Confirm settlement link",
          disabledReason: "Nothing proposed yet — needs a QB deposit first",
        },
      ]}
      testId={`button-settlement-menu-${clusterId}`}
    />
  );
}

function StatusForCluster({
  cluster,
  action,
}: {
  cluster: WorkbenchCluster;
  action?: ReactNode;
}) {
  // If the server returned canonical row-state, use it; otherwise fall back to
  // the legacy cluster.status signal.
  const state = cluster.coverage?.state;
  if (state) {
    const lnk = LINKAGE_META[state.linkage.state];
    const inf = INFO_META[state.information.state];
    const settle = state.settlementLinkState
      ? SETTLEMENT_META[state.settlementLinkState]
      : null;
    // Worst tone wins across linkage, information AND settlement.
    const tonePriority: Record<Tone, number> = {
      red: 4,
      amber: 3,
      blue: 2,
      green: 1,
      slate: 0,
    };
    const facets = settle ? [lnk, inf, settle] : [lnk, inf];
    const tone = facets.reduce<Tone>(
      (worst, f) => (tonePriority[f.tone] > tonePriority[worst] ? f.tone : worst),
      "slate",
    );
    const detailBits = [
      inf.word !== lnk.word ? inf.word : null,
      settle && state.settlementLinkState !== "confirmed" ? settle.word : null,
    ].filter((b): b is string => b != null);
    return (
      <StatusCell
        tone={tone}
        word={lnk.word}
        detail={detailBits.length > 0 ? detailBits.join(" · ") : null}
        action={action}
        testId={`status-cluster-${cluster.id}`}
      />
    );
  }
  // Legacy fallback.
  const meta = CLUSTER_STATUS[cluster.status];
  return (
    <StatusCell
      tone={meta.tone}
      word={meta.word}
      detail={
        cluster.statusDetail ??
        (cluster.resolvedCount != null && cluster.totalCount != null
          ? `${cluster.resolvedCount} of ${cluster.totalCount} linked`
          : null)
      }
      action={action}
      testId={`status-cluster-${cluster.id}`}
    />
  );
}
/** Stripe payout bundle: collapsed summary row + expandable paired child rows. */
function PayoutBundleRow({
  cluster,
  expanded,
  onToggle,
  actions,
}: {
  cluster: WorkbenchCluster;
  expanded: boolean;
  onToggle: () => void;
  actions: ClusterActions;
}) {
  const [, navigate] = useLocation();
  const giftById = new Map(cluster.gifts.map((g) => [g.giftId, g]));
  const pairedGiftIds = new Set(
    cluster.charges
      .map((c) => c.linkedGiftId)
      .filter((id): id is string => id != null),
  );
  const leftoverGifts = cluster.gifts.filter((g) => !pairedGiftIds.has(g.giftId));
  const chargeTotal = cluster.chargeCount ?? cluster.charges.length;
  const hiddenCount = chargeTotal - cluster.charges.length;
  const unmatched = cluster.charges.filter(
    (c) => !c.linkedGiftId && c.status !== "excluded",
  );
  const deposit = cluster.qbRecords.find((r) => r.role === "deposit");
  const fees = cluster.qbRecords.filter((r) => r.role === "fee");
  const gap = cluster.gapAmount != null ? Number(cluster.gapAmount) : null;
  const balanced = gap != null && gap === 0;

  const qbLines: string[] = [];
  if (deposit) qbLines.push(`${qbLabel(deposit)} · ${fmt(deposit.amount)}`);
  for (const f of fees) qbLines.push(`${qbLabel(f)} · −${fmt(f.amount)}`);

  // Single-charge payout: no summary/detail duplication — render ONE flat
  // row (donor | charge | bank cards | status), like any other cluster.
  if (chargeTotal === 1 && cluster.charges.length === 1) {
    const charge = cluster.charges[0];
    const gift = charge.linkedGiftId
      ? giftById.get(charge.linkedGiftId)
      : cluster.gifts[0];
    const donorIdentified = !!charge.attributedDonor;
    const anchor: AnchorRef = {
      kind: "charge",
      id: charge.chargeId,
      label: chargeLabel(charge),
    };
    return (
      <div
        className={`${GRID} py-2.5 border-b hover:bg-muted/40`}
        data-testid={`cluster-row-${cluster.id}`}
      >
        <ChevronRight className="w-4 h-4 text-transparent mt-1.5" />
        <div className="space-y-1.5">
          {gift ? (
            <GiftCard gift={gift} actions={actions} rowState={cluster.coverage?.state} />
          ) : charge.status === "excluded" ? (
            <ExcludedCard />
          ) : cluster.coverage?.donorPurpose.crmLinkage.grain === "bundle" &&
            cluster.coverage.donorPurpose.crmLinkage.complete ? (
            <div className="text-[11px] text-muted-foreground/70 pt-2 pl-1 italic">
              covered by the deposit-grain gift above
            </div>
          ) : (
            <>
              {charge.attributedDonor ? (
                <IdentifiedDonorNote attributedDonor={charge.attributedDonor} />
              ) : null}
              <DonorActions
                disabled={actions.busy}
                identified={donorIdentified}
                onLink={() => actions.openLinkGift(anchor)}
                onCreate={() =>
                  actions.openCreateGift(anchor, chargePreview(charge))
                }
                onIdentify={() =>
                  actions.openIdentify(anchor, chargePreview(charge))
                }
                testIdBase={`donor-slot-${charge.chargeId}`}
              />
            </>
          )}
        </div>
        <ChargeCard charge={charge} actions={actions} rowState={cluster.coverage?.state} />
        <div className="space-y-1.5">
          {cluster.qbRecords.length > 0 ? (
            cluster.qbRecords.map((r) => (
              <QbCard key={`${r.role}-${r.stagedPaymentId}`} record={r} actions={actions} rowState={cluster.coverage?.state} />
            ))
          ) : (
            <SummaryCard
              lines={["No QB deposit linked yet"]}
              gap="settlement link missing"
              menu={<SettlementGapMenu clusterId={cluster.id} />}
            />
          )}
        </div>
        <StatusForCluster
          cluster={cluster}
          action={
            !gift && charge.status !== "excluded" && !charge.refundProposed ? (
              donorIdentified ? (
                <StatusAction
                  label="Create gift"
                  onClick={() =>
                    actions.openCreateGift(anchor, chargePreview(charge))
                  }
                  testId={`button-status-create-${cluster.id}`}
                />
              ) : (
                <StatusAction
                  label="Identify donor"
                  onClick={() =>
                    actions.openIdentify(anchor, chargePreview(charge))
                  }
                  testId={`button-status-identify-${cluster.id}`}
                />
              )
            ) : null
          }
        />
        <RowKebab clusterId={cluster.id} />
      </div>
    );
  }

  return (
    <>
      <div
        className={`${GRID} pt-2.5 ${expanded ? "pb-1 bg-blue-50/40 dark:bg-blue-950/20" : "pb-2.5 border-b hover:bg-muted/40"} cursor-pointer`}
        onClick={onToggle}
        data-testid={`cluster-row-${cluster.id}`}
      >
        <button
          type="button"
          className="mt-1.5"
          aria-label={expanded ? "Collapse bundle" : "Expand bundle"}
          data-testid={`button-toggle-${cluster.id}`}
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-blue-500" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground/50" />
          )}
        </button>
        <SummaryCard
          lines={[
            `${cluster.gifts.length} gift${cluster.gifts.length === 1 ? "" : "s"}${
              cluster.resolvedCount != null && cluster.totalCount != null
                ? ` — cover ${cluster.resolvedCount} of ${cluster.totalCount} charges`
                : ""
            }`,
            "in this Stripe payout bundle",
          ]}
          gap={
            unmatched.length > 0
              ? `${unmatched.length} charge${unmatched.length === 1 ? " has" : "s have"} no gift yet`
              : null
          }
        />
        <SummaryCard
          lines={[
            `${chargeTotal} Stripe charge${chargeTotal === 1 ? "" : "s"} · one payout${
              cluster.date ? ` · ${formatDateShort(cluster.date)}` : ""
            }`,
            `${fmt(cluster.grossTotal)} gross · ${fmt(cluster.feeTotal)} fees · ${fmt(cluster.netTotal)} net`,
          ]}
        />
        {qbLines.length > 0 ? (
          <SummaryCard lines={qbLines} />
        ) : (
          <SummaryCard
            lines={["No QB deposit linked yet"]}
            gap="settlement link missing"
            menu={<SettlementGapMenu clusterId={cluster.id} />}
          />
        )}
        <StatusForCluster
          cluster={cluster}
          action={
            cluster.status === "conflict" ? (
              <StatusAction
                label="Expand to see the conflict"
                onClick={() => onToggle()}
                testId={`button-resolve-conflict-${cluster.id}`}
              />
            ) : !expanded &&
              cluster.status !== "complete" &&
              cluster.status !== "excluded" ? (
              <StatusAction
                label="Expand to resolve"
                onClick={onToggle}
                testId={`button-expand-resolve-${cluster.id}`}
              />
            ) : null
          }
        />
        <RowKebab clusterId={cluster.id} />
      </div>

      {expanded ? (
        <>
          <div className="pl-[52px] pr-4 pb-2 bg-blue-50/40 dark:bg-blue-950/20">
            <p className="text-[11px] text-muted-foreground font-mono flex items-center gap-1 flex-wrap">
              {balanced ? (
                <Check className="w-3 h-3 inline text-emerald-600 shrink-0" />
              ) : (
                <X className="w-3 h-3 inline text-amber-600 shrink-0" />
              )}
              gross {fmt(cluster.grossTotal)} − fees {fmt(cluster.feeTotal)} ={" "}
              net {fmt(cluster.netTotal)} {balanced ? "=" : "≠"} bank{" "}
              {deposit ? qbLabel(deposit) : fmt(cluster.bankAmount)}
              {gap != null
                ? ` · gap ${fmt(cluster.gapAmount)} — ${balanced ? "money balanced" : "off"}`
                : ""}
              {cluster.resolvedCount != null && cluster.totalCount != null
                ? ` · attribution ${cluster.resolvedCount}/${cluster.totalCount}`
                : ""}
            </p>
          </div>
          {cluster.charges.map((charge) => {
            const gift = charge.linkedGiftId
              ? giftById.get(charge.linkedGiftId)
              : undefined;
            const status = chargeStatus(charge, cluster.coverage);
            const tie = cluster.qbRecords.find(
              (r) =>
                r.linkedChargeId === charge.chargeId && r.role === "charge_tie",
            );
            const anchor: AnchorRef = {
              kind: "charge",
              id: charge.chargeId,
              label: chargeLabel(charge),
            };
            return (
              <div
                key={charge.chargeId}
                className={`${GRID} py-2 border-b border-border/40 bg-blue-50/40 dark:bg-blue-950/20`}
                data-testid={`cluster-charge-row-${charge.chargeId}`}
              >
                <CornerDownRight className="w-3.5 h-3.5 text-muted-foreground/40 ml-2 mt-2" />
                <div className="pl-4">
                  {gift ? (
                    <GiftCard gift={gift} actions={actions} rowState={cluster.coverage?.state} />
                  ) : charge.status === "excluded" ? (
                    <ExcludedCard />
                  ) : cluster.coverage?.donorPurpose.crmLinkage.grain === "bundle" &&
                    cluster.coverage.donorPurpose.crmLinkage.complete ? (
                    <div className="text-[11px] text-muted-foreground/70 pt-2 pl-1 italic">
                      covered by the deposit-grain gift above
                    </div>
                  ) : (
                    <>
                      {charge.attributedDonor ? (
                        <IdentifiedDonorNote attributedDonor={charge.attributedDonor} />
                      ) : null}
                      <DonorActions
                        disabled={actions.busy}
                        identified={!!charge.attributedDonor}
                        onLink={() => actions.openLinkGift(anchor)}
                        onCreate={() =>
                          actions.openCreateGift(anchor, chargePreview(charge))
                        }
                        onIdentify={() =>
                          actions.openIdentify(anchor, chargePreview(charge))
                        }
                        testIdBase={`donor-slot-${charge.chargeId}`}
                      />
                    </>
                  )}
                </div>
                <ChargeCard charge={charge} actions={actions} rowState={cluster.coverage?.state} />
                {tie ? (
                  <QbCard record={tie} actions={actions} rowState={cluster.coverage?.state} />
                ) : (
                  <div className="text-[11px] text-muted-foreground/70 pt-2 pl-1">
                    ↳ part of the payout bundle above
                  </div>
                )}
                <StatusCell
                  tone={status.tone}
                  word={status.word}
                  detail={status.detail}
                  testId={`status-charge-${charge.chargeId}`}
                />
                <span />
              </div>
            );
          })}
          {leftoverGifts.map((gift) => (
            <div
              key={gift.giftId}
              className={`${GRID} py-2 border-b border-border/40 bg-blue-50/40 dark:bg-blue-950/20`}
            >
              <CornerDownRight className="w-3.5 h-3.5 text-muted-foreground/40 ml-2 mt-2" />
              <div className="pl-4">
                <GiftCard gift={gift} actions={actions} rowState={cluster.coverage?.state} />
              </div>
              <div className="text-[11px] text-muted-foreground/70 pt-2 pl-1 italic">
                {(gift.linkedChargeIds ?? []).length === 0 &&
                (gift.linkedStagedPaymentIds ?? []).length > 0
                  ? "booked against the QB deposit — one gift covers this payout's lump"
                  : "linked charge not shown (charge list capped)"}
              </div>
              <span />
              <span />
              <span />
            </div>
          ))}
          {hiddenCount > 0 ? (
            <div className="pl-[52px] pr-4 py-1.5 border-b bg-blue-50/40 dark:bg-blue-950/20">
              <p className="text-[11px] text-muted-foreground italic">
                … and {hiddenCount.toLocaleString()} more charge
                {hiddenCount === 1 ? "" : "s"} — expand to see all
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** QuickBooks-anchored (or grouped) money with no payout bundle. */
function QbStandaloneRow({
  cluster,
  actions,
}: {
  cluster: WorkbenchCluster;
  actions: ClusterActions;
}) {
  const anchorRecord =
    cluster.qbRecords.find((r) => r.role === "anchor") ?? cluster.qbRecords[0];
  const label = cluster.title ?? (anchorRecord ? qbLabel(anchorRecord) : "");
  // Honest middle column: a QB row whose text mentions Stripe DOES have a
  // processor record somewhere — it just isn't tied to its charge yet.
  const looksLikeStripeMoney = /stripe/i.test(
    [
      anchorRecord?.memo,
      anchorRecord?.lineDescription,
      anchorRecord?.reference,
      cluster.title,
    ]
      .filter(Boolean)
      .join(" "),
  );
  const stagedAnchor: AnchorRef | null = anchorRecord
    ? { kind: "staged", id: anchorRecord.stagedPaymentId, label }
    : null;
  const preview: EvidencePreview = {
    amount: fmt(cluster.netTotal ?? anchorRecord?.amount),
    date: cluster.date ? formatDateShort(cluster.date) : "—",
    method: "QuickBooks payment",
    source: anchorRecord
      ? `QuickBooks record ${qbLabel(anchorRecord)}`
      : "QuickBooks record",
    memo: anchorRecord?.memo ?? anchorRecord?.lineDescription ?? null,
  };
  return (
    <div
      className={`${GRID} py-2.5 border-b hover:bg-muted/40 ${cluster.status === "excluded" ? "opacity-90" : ""}`}
      data-testid={`cluster-row-${cluster.id}`}
    >
      <ChevronRight className="w-4 h-4 text-transparent mt-1.5" />
      <div className="space-y-1.5">
        {cluster.gifts.length > 0 ? (
          cluster.gifts.map((g) => (
            <GiftCard key={g.giftId} gift={g} actions={actions} rowState={cluster.coverage?.state} />
          ))
        ) : cluster.status === "excluded" ? (
          <ExcludedCard reason={cluster.statusDetail} />
        ) : cluster.group ? (
          <div className="text-[11px] text-muted-foreground italic pt-1">
            Grouped payment ({cluster.group.memberCount} rows) — expand individual rows to act on each charge
          </div>
        ) : stagedAnchor ? (
          <>
            {cluster.qbRecords.find((r) => r.role === "anchor")?.attributedDonor ? (
              <IdentifiedDonorNote
                attributedDonor={
                  cluster.qbRecords.find((r) => r.role === "anchor")!.attributedDonor!
                }
              />
            ) : null}
            <DonorActions
              disabled={actions.busy}
              identified={
                !!cluster.qbRecords.find((r) => r.role === "anchor")
                  ?.attributedDonor
              }
              onLink={() => actions.openLinkGift(stagedAnchor)}
              onCreate={() => actions.openCreateGift(stagedAnchor, preview)}
              onIdentify={() => actions.openIdentify(stagedAnchor, preview)}
              testIdBase={`donor-slot-${stagedAnchor.id}`}
            />
          </>
        ) : null}
      </div>
      <div className="text-[11px] text-muted-foreground/70 pt-2 pl-1 italic">
        {looksLikeStripeMoney ? (
          <>
            looks like Stripe money — charge not tied yet; use the donor slot to link it
          </>
        ) : (
          "arrived via QuickBooks — no separate processor record"
        )}
      </div>
      <div className="space-y-1.5">
        {cluster.qbRecords.map((r) => (
          <QbCard key={`${r.role}-${r.stagedPaymentId}`} record={r} actions={actions} rowState={cluster.coverage?.state} />
        ))}
      </div>
      <StatusForCluster cluster={cluster} />
      <RowKebab clusterId={cluster.id} />
    </div>
  );
}

/** A CRM gift with no money evidence yet. */
function CrmOnlyRow({
  cluster,
  actions,
}: {
  cluster: WorkbenchCluster;
  actions: ClusterActions;
}) {
  const [, navigate] = useLocation();
  return (
    <div
      className={`${GRID} py-2.5 border-b hover:bg-muted/40`}
      data-testid={`cluster-row-${cluster.id}`}
    >
      <ChevronRight className="w-4 h-4 text-transparent mt-1.5" />
      <div className="space-y-1.5">
        {cluster.gifts.map((g) => (
          <GiftCard key={g.giftId} gift={g} actions={actions} rowState={cluster.coverage?.state} />
        ))}
      </div>
      
      <StatusForCluster cluster={cluster} />
      <RowKebab clusterId={cluster.id} />
    </div>
  );
}

export function ClusterRow({
  cluster,
  expanded,
  onToggle,
  actions,
}: {
  cluster: WorkbenchCluster;
  expanded: boolean;
  onToggle: () => void;
  actions: ClusterActions;
}) {
  if (cluster.kind === "stripe_payout") {
    return (
      <PayoutBundleRow
        cluster={cluster}
        expanded={expanded}
        onToggle={onToggle}
        actions={actions}
      />
    );
  }
  if (cluster.kind === "crm_only") {
    return <CrmOnlyRow cluster={cluster} actions={actions} />;
  }
  return <QbStandaloneRow cluster={cluster} actions={actions} />;
}

/** Sticky column-header row for the grid. */
export function GridHeader() {
  return (
    <div
      className={`${GRID} py-1.5 border-b bg-muted/40 sticky top-0 z-10`}
    >
      <span />
      {[
        "DONOR & PURPOSE",
        "PAYMENT EVIDENCE",
        "BANK & ACCOUNTING",
        "STATUS & NEXT STEP",
      ].map((h) => (
        <span
          key={h}
          className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground"
        >
          {h}
        </span>
      ))}
      <span />
    </div>
  );
}
