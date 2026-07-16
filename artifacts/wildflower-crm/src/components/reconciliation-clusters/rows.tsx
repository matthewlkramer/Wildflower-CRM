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
}: {
  gift: WorkbenchClusterGift;
  actions: ClusterActions;
}) {
  const tie = gift.quickbooksTie;
  const bad = tie === "amount_mismatch" || tie === "missing";
  const donor = donorHref(gift);
  const unlinkAnchor = giftUnlinkAnchor(gift);
  const menu: MenuItem[] = [
    { label: "Open gift record", href: `/gifts/${gift.giftId}` },
    donor
      ? { label: "Open donor record", href: donor }
      : {
          label: "Open donor record",
          disabledReason: "No donor on this gift",
        },
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
          label: "Unlink from this match",
          disabledReason: "Not linked to evidence in this row",
        },
    {
      label: "Move to another cluster",
      disabledReason:
        "Clusters follow the evidence ties — unlink here, then link from the other row",
    },
  ];
  return (
    <FacetCard
      tone={bad ? "amber" : "green"}
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
        </>
      }
      gap={
        tie === "amount_mismatch"
          ? "QB amount mismatch"
          : tie === "missing"
            ? "No QB record tied yet"
            : null
      }
      badges={
        <>
          {gift.donorbox ? <DbBadge /> : null}
          {gift.codingForm ? <CodingBadge /> : null}
          {gift.grantLetter ? <LetterBadge /> : null}
        </>
      }
      menu={
        <CardMenu items={menu} testId={`button-gift-menu-${gift.giftId}`} />
      }
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

function chargeLabel(c: WorkbenchClusterCharge): string {
  return c.payerName ?? c.chargeId;
}

function ChargeCard({
  charge,
  actions,
}: {
  charge: WorkbenchClusterCharge;
  actions: ClusterActions;
}) {
  const label = chargeLabel(charge);
  const anchor: AnchorRef = { kind: "charge", id: charge.chargeId, label };
  const excluded = charge.status === "excluded";
  const menu: MenuItem[] = [
    {
      label: "View in Stripe",
      externalHref: `https://dashboard.stripe.com/payments/${charge.chargeId}`,
    },
  ];
  if (charge.refundProposed) {
    const kind = charge.refundKind === "chargeback" ? "chargeback" : "refund";
    menu.push(
      {
        label: `Confirm ${kind}`,
        destructive: true,
        onClick: () =>
          actions.openConfirmRefund(charge.chargeId, kind, label),
      },
      {
        label: `Dismiss ${kind} proposal`,
        onClick: () => actions.openDismissRefund(charge.chargeId, label),
      },
    );
  }
  if (excluded) {
    menu.push({
      label: "Re-include",
      onClick: () => actions.reInclude(anchor),
    });
  } else if (charge.linkedGiftId) {
    menu.push({
      label: "Unlink gift",
      destructive: true,
      onClick: () =>
        actions.openRevert(
          anchor,
          `Unlink Stripe charge ${label} from its gift. If the gift was minted from this charge it is deleted; a pre-existing gift is kept and just unlinked.`,
        ),
    });
  } else {
    menu.push({
      label: "Exclude — not a donation",
      onClick: () => actions.openExclude(anchor),
    });
  }
  menu.push(
    {
      label: "Move to another cluster",
      disabledReason:
        "Charges belong to their Stripe payout — the cluster is fixed",
    },
    {
      label: "Flag for research",
      disabledReason: "Only QuickBooks records can be flagged for research",
    },
  );
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
  return (
    <FacetCard
      tone={
        excluded ? "slate" : charge.status === "match_confirmed" ? "green" : "amber"
      }
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
      gap={
        charge.refundProposed
          ? `${charge.refundKind === "chargeback" ? "Chargeback" : "Refund"} proposed`
          : excluded
            ? null
            : !charge.linkedGiftId
              ? "No donor identified"
              : null
      }
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
}: {
  record: WorkbenchClusterQbRecord;
  actions: ClusterActions;
}) {
  const label = qbLabel(record);
  const anchor: AnchorRef = {
    kind: "staged",
    id: record.stagedPaymentId,
    label,
  };
  // Deposit / fee / charge-tie rows are payout plumbing — exclude/revert on
  // them belongs to the payout flows in the queue workbench, so those rows
  // only offer flag-for-research here.
  const actionable = record.role === "anchor" || record.role === "group_member";
  const href = qbHref(record);
  const menu: MenuItem[] = [
    href
      ? { label: "View in QuickBooks", externalHref: href }
      : {
          label: "View in QuickBooks",
          disabledReason: "No QuickBooks transaction id on this row",
        },
  ];
  if (actionable) {
    if (record.status === "excluded") {
      menu.push({
        label: "Re-include",
        onClick: () => actions.reInclude(anchor),
      });
    } else if (record.status === "pending") {
      menu.push({
        label: "Exclude — not a donation",
        onClick: () => actions.openExclude(anchor),
      });
    } else {
      menu.push({
        label: "Unlink / undo booking",
        destructive: true,
        onClick: () =>
          actions.openRevert(
            anchor,
            `Undo the booked reconciliation on ${label}. An auto-minted gift is deleted; a pre-existing gift is kept and just unlinked. The row returns to pending.`,
          ),
      });
    }
  }
  menu.push(
    {
      label: "Flag for research",
      onClick: () => actions.openFlag(record.stagedPaymentId, label),
    },
    {
      label: "Flag QB recode",
      disabledReason:
        "Not available yet — use Flag for research and note the recode",
    },
  );
  const subBits = [
    QB_ROLE_LABEL[record.role],
    record.dateReceived ? formatDateShort(record.dateReceived) : null,
    record.payerName && record.payerName !== label ? record.payerName : null,
    qbReferenceNote(record),
  ].filter(Boolean);
  return (
    <FacetCard
      tone={
        record.status === "excluded"
          ? "slate"
          : record.status === "match_confirmed"
            ? "green"
            : "amber"
      }
      amount={fmt(record.amount)}
      name={label}
      sub={subBits.join(" · ")}
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
      label: "View in queue workbench",
      onClick: () => navigate("/reconciliation-workbench"),
    },
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

function StatusForCluster({
  cluster,
  action,
}: {
  cluster: WorkbenchCluster;
  action?: ReactNode;
}) {
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
    const status = chargeStatus(charge, cluster.coverage);
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
            <GiftCard gift={gift} actions={actions} />
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
        <ChargeCard charge={charge} actions={actions} />
        <div className="space-y-1.5">
          {cluster.qbRecords.length > 0 ? (
            cluster.qbRecords.map((r) => (
              <QbCard
                key={`${r.role}-${r.stagedPaymentId}`}
                record={r}
                actions={actions}
              />
            ))
          ) : (
            <SummaryCard
              lines={["No QB deposit linked yet"]}
              gap="settlement link missing"
            />
          )}
        </div>
        <StatusCell
          tone={status.tone}
          word={status.word}
          detail={status.detail}
          testId={`status-cluster-${cluster.id}`}
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
          />
        )}
        <StatusForCluster
          cluster={cluster}
          action={
            cluster.status === "conflict" ? (
              <StatusAction
                label="Resolve in queue workbench"
                onClick={() => navigate("/reconciliation-workbench")}
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
                    <GiftCard gift={gift} actions={actions} />
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
                <ChargeCard charge={charge} actions={actions} />
                {tie ? (
                  <QbCard record={tie} actions={actions} />
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
                <GiftCard gift={gift} actions={actions} />
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
                {hiddenCount === 1 ? "" : "s"} —{" "}
                <Link
                  href="/reconciliation-workbench"
                  className="text-primary hover:underline underline-offset-2 not-italic"
                >
                  open the queue workbench to see all
                </Link>
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
            <GiftCard key={g.giftId} gift={g} actions={actions} />
          ))
        ) : cluster.status === "excluded" ? (
          <ExcludedCard reason={cluster.statusDetail} />
        ) : cluster.group ? (
          <div className="text-[11px] text-muted-foreground italic pt-1">
            Grouped payment ({cluster.group.memberCount} rows) —{" "}
            <Link
              href="/reconciliation-workbench"
              className="text-primary hover:underline underline-offset-2 not-italic"
            >
              act on the group in the queue workbench
            </Link>
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
            looks like Stripe money — charge not tied yet;{" "}
            <Link
              href="/reconciliation-workbench"
              className="text-primary hover:underline underline-offset-2 not-italic"
            >
              tie it in the queue workbench
            </Link>
          </>
        ) : (
          "arrived via QuickBooks — no separate processor record"
        )}
      </div>
      <div className="space-y-1.5">
        {cluster.qbRecords.map((r) => (
          <QbCard
            key={`${r.role}-${r.stagedPaymentId}`}
            record={r}
            actions={actions}
          />
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
          <GiftCard key={g.giftId} gift={g} actions={actions} />
        ))}
      </div>
      <LinkSlot
        label="Link payment evidence"
        onClick={() => navigate("/reconciliation-workbench")}
        testId={`button-link-evidence-${cluster.id}`}
      />
      <LinkSlot
        label="Link bank & accounting"
        onClick={() => navigate("/reconciliation-workbench")}
        testId={`button-link-accounting-${cluster.id}`}
      />
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
