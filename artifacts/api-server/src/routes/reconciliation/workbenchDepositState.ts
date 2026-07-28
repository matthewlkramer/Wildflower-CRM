import {
  QB_DOCUMENTATION_COMPLETE,
  informationStateOf,
  type CrmCardEntry,
  type QbCardEntry,
  type SettlementLinkState,
  type TransactionEntry,
  type WorkbenchRowState,
} from "./workbenchRowState";

export type DepositCompositionCoverage = {
  present: boolean;
  complete: boolean;
  grain: "bundle" | "unit" | "none";
  relationshipCount: number;
};

export type DepositTransactionInput = {
  entry: TransactionEntry;
  linkedToCrm: boolean;
};

export type DepositWorkbenchStateInput = {
  composition: DepositCompositionCoverage;
  transactions: DepositTransactionInput[];
  crmCards: CrmCardEntry[];
  qbCards: QbCardEntry[];
  accountingEvidencePresent: boolean;
  accountingCorrection: boolean;
  excluded: boolean;
  conflict: boolean;
  attentionRequired: boolean;
  settlementLinkState?: SettlementLinkState;
};

/**
 * Canonical state derivation for the deposit-first workbench.
 *
 * The deposit route used to treat "payout paired to bank" as end-to-end
 * completion, even when one or more live charges still had no CRM gift. This
 * helper derives the three relationship surfaces independently and only marks
 * the row link-complete when the bank/composition relationship and every live,
 * countable transaction→CRM relationship are complete.
 *
 * Information completeness remains independent. QuickBooks documentation is
 * not yet a built workflow, so QB_DOCUMENTATION_COMPLETE continues to gate
 * audit_ready exactly as it does in the cluster workbench.
 */
export function deriveDepositWorkbenchState(
  input: DepositWorkbenchStateInput,
): WorkbenchRowState {
  const countable = input.transactions.filter(
    ({ entry }) => entry.state !== "excluded",
  );
  const live = countable.filter(({ entry }) => entry.livePayment);
  const linkedLive = live.filter(({ linkedToCrm }) => linkedToCrm);

  const transactionToCrmState =
    live.length === 0
      ? "missing"
      : linkedLive.length === live.length
        ? "complete"
        : linkedLive.length > 0
          ? "partial"
          : "missing";

  const accountingToTransactionState = input.composition.complete
    ? "complete"
    : input.composition.present
      ? "partial"
      : "missing";

  const accountingToCrmState =
    input.composition.complete && transactionToCrmState === "complete"
      ? "complete"
      : input.composition.present || linkedLive.length > 0
        ? "partial"
        : "missing";

  const linkageState =
    accountingToTransactionState === "complete" &&
    transactionToCrmState === "complete" &&
    accountingToCrmState === "complete" &&
    !input.conflict
      ? "complete"
      : input.composition.present ||
          input.transactions.length > 0 ||
          linkedLive.length > 0
        ? "partial"
        : "missing";

  // An empty CRM column is not complete. This avoids the Array.every([]) trap
  // that previously allowed evidence-only rows to look information-complete.
  const crmComplete =
    input.crmCards.length > 0 &&
    input.crmCards.every((card) => card.recordComplete);

  const attentionRequired =
    input.attentionRequired || input.accountingCorrection;

  return {
    linkage: {
      state: linkageState,
      accountingToTransaction: {
        state: accountingToTransactionState,
        grain: input.composition.grain,
        relationshipCount: input.composition.relationshipCount,
      },
      transactionToCrm: {
        state: transactionToCrmState,
        grain: input.transactions.length > 0 ? "unit" : "none",
        relationshipCount: linkedLive.length,
      },
      accountingToCrm: {
        state: accountingToCrmState,
        grain: input.transactions.length > 0
          ? input.composition.grain
          : "none",
        relationshipCount: linkedLive.length,
      },
    },
    information: {
      state: informationStateOf({
        crmComplete,
        qbEvidenceComplete: input.accountingEvidencePresent,
        qbDocumented: QB_DOCUMENTATION_COMPLETE,
        attentionRequired,
      }),
      crmComplete,
      qbComplete: QB_DOCUMENTATION_COMPLETE,
      qbEvidenceComplete: input.accountingEvidencePresent,
    },
    flags: {
      excluded: input.excluded,
      conflict: input.conflict,
      attentionRequired,
    },
    settlementLinkState: input.settlementLinkState,
    qbCards: input.qbCards,
    transactions: input.transactions.map(({ entry }) => entry),
    crmCards: input.crmCards,
  };
}
