import { describe, it, expect } from "vitest";
import {
  classifyRefund,
  deriveRefundProposal,
  type RefundFacts,
  type RefundProposalState,
} from "../lib/stripeRefund";

const noFacts: RefundFacts = {
  refunded: false,
  disputed: false,
  amountRefunded: null,
  grossAmount: "100.00",
};

const fresh: RefundProposalState = {
  refundPropagationStatus: "none",
  refundPropagationKind: null,
  refundProposedAmount: null,
};

describe("classifyRefund", () => {
  it("returns null when there is no refund or dispute", () => {
    expect(classifyRefund(noFacts)).toBeNull();
  });

  it("classifies a full refund (amount_refunded == gross)", () => {
    const r = classifyRefund({ ...noFacts, refunded: true, amountRefunded: "100.00" });
    expect(r).toEqual({ kind: "full_refund", reversedAmount: "100.00" });
  });

  it("classifies a partial refund (amount_refunded < gross)", () => {
    const r = classifyRefund({ ...noFacts, refunded: true, amountRefunded: "40.00" });
    expect(r).toEqual({ kind: "partial_refund", reversedAmount: "40.00" });
  });

  it("classifies a dispute as a chargeback reversing the whole gross", () => {
    const r = classifyRefund({ ...noFacts, disputed: true, amountRefunded: "10.00" });
    expect(r).toEqual({ kind: "chargeback", reversedAmount: "100.00" });
  });

  it("treats a refunded flag with no amount as a full refund", () => {
    const r = classifyRefund({ ...noFacts, refunded: true, amountRefunded: null });
    expect(r).toEqual({ kind: "full_refund", reversedAmount: "100.00" });
  });

  it("ignores sub-cent refund noise when the refunded flag is unset", () => {
    expect(
      classifyRefund({ ...noFacts, refunded: false, amountRefunded: "0.001" }),
    ).toBeNull();
  });
});

describe("deriveRefundProposal", () => {
  const fullRefund: RefundFacts = {
    ...noFacts,
    refunded: true,
    amountRefunded: "100.00",
  };

  it("does not raise when there is no linked gift", () => {
    expect(deriveRefundProposal(fullRefund, fresh, false)).toBeNull();
  });

  it("raises a fresh proposal for a refund on a linked gift", () => {
    expect(deriveRefundProposal(fullRefund, fresh, true)).toEqual({
      kind: "full_refund",
      reversedAmount: "100.00",
    });
  });

  it("is idempotent: does not re-raise an already-proposed identical signature", () => {
    const state: RefundProposalState = {
      refundPropagationStatus: "proposed",
      refundPropagationKind: "full_refund",
      refundProposedAmount: "100.00",
    };
    expect(deriveRefundProposal(fullRefund, state, true)).toBeNull();
  });

  it("does not re-raise after the same refund was applied", () => {
    const state: RefundProposalState = {
      refundPropagationStatus: "applied",
      refundPropagationKind: "full_refund",
      refundProposedAmount: "100.00",
    };
    expect(deriveRefundProposal(fullRefund, state, true)).toBeNull();
  });

  it("does not re-raise after the same refund was dismissed", () => {
    const state: RefundProposalState = {
      refundPropagationStatus: "dismissed",
      refundPropagationKind: "partial_refund",
      refundProposedAmount: "40.00",
    };
    const partial: RefundFacts = { ...noFacts, refunded: true, amountRefunded: "40.00" };
    expect(deriveRefundProposal(partial, state, true)).toBeNull();
  });

  it("re-raises on escalation: dismissed partial then a larger partial", () => {
    const state: RefundProposalState = {
      refundPropagationStatus: "dismissed",
      refundPropagationKind: "partial_refund",
      refundProposedAmount: "40.00",
    };
    const bigger: RefundFacts = { ...noFacts, refunded: true, amountRefunded: "75.00" };
    expect(deriveRefundProposal(bigger, state, true)).toEqual({
      kind: "partial_refund",
      reversedAmount: "75.00",
    });
  });

  it("re-raises on escalation: applied partial then escalated to a full refund", () => {
    const state: RefundProposalState = {
      refundPropagationStatus: "applied",
      refundPropagationKind: "partial_refund",
      refundProposedAmount: "40.00",
    };
    expect(deriveRefundProposal(fullRefund, state, true)).toEqual({
      kind: "full_refund",
      reversedAmount: "100.00",
    });
  });
});
