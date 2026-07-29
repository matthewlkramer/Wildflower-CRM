import { describe, expect, it } from "vitest";
import {
  deriveDepositWorkbenchState,
  type DepositTransactionInput,
  type DepositWorkbenchStateInput,
} from "./workbenchDepositState";

const matched = (
  id: string,
  overrides: Partial<DepositTransactionInput["entry"]> = {},
): DepositTransactionInput => ({
  linkedToCrm: true,
  entry: {
    transactionId: id,
    livePayment: true,
    refundStatus: "none",
    state: "matched",
    ...overrides,
  },
});

const unmatched = (id: string): DepositTransactionInput => ({
  linkedToCrm: false,
  entry: {
    transactionId: id,
    livePayment: true,
    refundStatus: "none",
    state: "unmatched",
  },
});

const base = (
  overrides: Partial<DepositWorkbenchStateInput> = {},
): DepositWorkbenchStateInput => ({
  composition: {
    present: true,
    complete: true,
    grain: "bundle",
    relationshipCount: 1,
  },
  transactions: [matched("tx_1")],
  crmCards: [
    {
      giftId: "gift_1",
      recordComplete: true,
      state: "matched_complete",
      satisfiedBy: "donor_allocations_and_supporting_documents",
    },
  ],
  qbCards: [],
  accountingEvidencePresent: true,
  accountingCorrection: false,
  excluded: false,
  conflict: false,
  attentionRequired: false,
  settlementLinkState: "confirmed",
  ...overrides,
});

describe("deriveDepositWorkbenchState", () => {
  it("marks the money lineage complete only when composition and every live transaction are linked", () => {
    const state = deriveDepositWorkbenchState(base());

    expect(state.linkage.state).toBe("complete");
    expect(state.linkage.accountingToTransaction.state).toBe("complete");
    expect(state.linkage.transactionToCrm.state).toBe("complete");
    expect(state.linkage.accountingToCrm.state).toBe("complete");
  });

  it("keeps a paired payout partial when any live charge still needs a gift", () => {
    const state = deriveDepositWorkbenchState(
      base({ transactions: [matched("tx_1"), unmatched("tx_2")] }),
    );

    expect(state.linkage.state).toBe("partial");
    expect(state.linkage.transactionToCrm).toMatchObject({
      state: "partial",
      relationshipCount: 1,
    });
  });

  it("does not let an evidence-only row become CRM complete through Array.every on an empty list", () => {
    const state = deriveDepositWorkbenchState(base({ crmCards: [] }));

    expect(state.information.crmComplete).toBe(false);
    expect(state.information.state).toBe("incomplete");
  });

  it("keeps a link-complete row accounting-pending until QuickBooks documentation exists", () => {
    const state = deriveDepositWorkbenchState(base());

    expect(state.linkage.state).toBe("complete");
    expect(state.information.qbComplete).toBe(false);
    expect(state.information.state).toBe("accounting_pending");
  });

  it("ignores excluded transactions when measuring active transaction coverage", () => {
    const state = deriveDepositWorkbenchState(
      base({
        transactions: [
          matched("tx_1"),
          {
            linkedToCrm: false,
            entry: {
              transactionId: "tx_excluded",
              livePayment: false,
              refundStatus: "none",
              state: "excluded",
            },
          },
        ],
      }),
    );

    expect(state.linkage.state).toBe("complete");
    expect(state.linkage.transactionToCrm.relationshipCount).toBe(1);
  });

  it("does not count a fully refunded transaction as live payment coverage", () => {
    const state = deriveDepositWorkbenchState(
      base({
        transactions: [
          {
            linkedToCrm: true,
            entry: {
              transactionId: "tx_refunded",
              livePayment: false,
              refundStatus: "refunded",
              state: "refunded",
            },
          },
        ],
      }),
    );

    expect(state.linkage.state).toBe("partial");
    expect(state.linkage.transactionToCrm.state).toBe("missing");
  });

  it("keeps accounting corrections as attention-required without changing the underlying relationship facts", () => {
    const state = deriveDepositWorkbenchState(
      base({ accountingCorrection: true }),
    );

    expect(state.linkage.state).toBe("complete");
    expect(state.flags.attentionRequired).toBe(true);
    expect(state.information.state).toBe("accounting_pending");
  });
});
