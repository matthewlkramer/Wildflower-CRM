import type {
  BankDepositExclusion,
  WorkbenchClusterQbRecord,
} from "@workspace/api-client-react";
import type { EvidencePickOption, EvidencePreview, UnlinkOption } from "./dialogs";

// Shared action-callback contract for the reconciliation workbench. Extracted
// from the retired clusters view; the deposit-first workbench (DepositActions)
// derives from it and the shared dialogs are wired through these callbacks.

/** The evidence row an action targets: a Stripe charge or a QB staged payment. */
export type AnchorRef =
  | { kind: "charge"; id: string; label: string }
  | { kind: "staged"; id: string; label: string }
  | { kind: "component"; id: string; label: string };

/**
 * Editable-field prefill for the standalone-create-gift dialog, pulled from the
 * evidence row when the client knows it (Stripe payer name / charge date).
 * Blank fields mean "keep the server's evidence-derived default" — the dialog
 * only sends overrides the user actually changed.
 */
export interface CreateGiftPrefill {
  name: string | null;
  /** ISO yyyy-mm-dd. */
  dateReceived: string | null;
}

/** Action callbacks the page wires to the real endpoints. */
export interface ClusterActions {
  busy: boolean;
  openLinkGift: (anchor: AnchorRef) => void;
  openCreateGift: (
    anchor: AnchorRef,
    preview: EvidencePreview,
    prefill?: CreateGiftPrefill,
  ) => void;
  openIdentify: (anchor: AnchorRef, preview: EvidencePreview | null) => void;
  openDonorboxSearch?: (anchor: AnchorRef, preview: EvidencePreview) => void;
  openCodingFormLookup?: (anchor: AnchorRef, preview: EvidencePreview) => void;
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
  /** Flag a CRM gift for research (cleanup queue), same flow as staged rows. */
  openFlagGift: (giftId: string, label: string) => void;
  /** Set loss_type on the gift's opportunity — marks the whole opportunity lost/dormant. */
  openMarkLoss: (
    opportunityId: string,
    kind: "lost" | "dormant",
    label: string,
  ) => void;
  /** Search QB deposits and confirm the settlement link for a payout. */
  openSettlementSearch: (args: {
    payoutId: string;
    amount: string | null;
    date: string | null;
  }) => void;
  openLinkDepositPayout?: (bankDepositId: string) => void;
  openLinkPayoutDeposit?: (payoutId: string) => void;
  openUnlinkPayoutDeposit?: (payoutId: string) => void;
  openConfirmPayoutBankMatch?: (payoutId: string) => void;
  openBankDepositExclusion?: (bankDepositId: string, existing: BankDepositExclusion | null) => void;
  clearBankDepositExclusion?: (bankDepositId: string) => void;
  /** True when the viewer is a finance team member or admin. Finance-gates QB write actions (§7.3). */
  isFinanceOrAdmin: boolean;
  /** Existing coding-form lookup endpoint is admin-only. */
  canUseCodingForm?: boolean;
  /** Open the read-only in-app QB record detail dialog (§7.2). Linkage word comes from coverage.state.qbCards. */
  openQbDetail: (record: WorkbenchClusterQbRecord, linkage: string) => void;
  /** Reject the system-proposed charge↔QB tie for a Stripe charge (§5.2 / §7.2 "Unmatch from QB evidence"). */
  rejectChargeQbTie: (chargeId: string) => void;
  confirmProposedMatch: (stagedPaymentId: string, label: string) => void;
  /** Gift-side "Match to …": chooser over the row's own evidence records. */
  openMatchEvidence: (
    giftId: string,
    giftLabel: string,
    options: EvidencePickOption[],
  ) => void;
  /** PATCH opportunityId=null — server re-derives the old pledge in the same call. */
  unmatchPledge: (giftId: string, giftLabel: string) => void;
  /** Relationship chooser when a gift has MULTIPLE linked evidence records. */
  openUnlinkChooser: (giftLabel: string, options: UnlinkOption[]) => void;
  /** Combine several of the row's gifts into ONE gift (shared MergeGiftsDialog). */
  openMergeGifts: (giftIds: string[]) => void;
  /** Approve the server-proposed match for a per-charge card via its deposit's reconciliation graph. */
  confirmChargeProposal: (
    chargeId: string,
    label: string,
    depositStagedPaymentId: string,
  ) => void;
}
