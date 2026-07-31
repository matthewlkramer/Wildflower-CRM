import { describe, expect, it } from "vitest";
import {
  canonicalWinProbability,
  deriveOppFields,
  isConditionalPledge,
} from "../lib/pledgeStage";

const base = {
  stage: "in_conversation" as string | null,
  lossType: null as string | null,
  commitmentPath: null as string | null,
  verbalCommitmentAt: null as string | Date | null,
  pledgeCommittedAt: null as string | Date | null,
  writtenPledge: false as boolean | null,
  conditional: null as string | null,
  grantLetterUrl: null as string | null,
  awardedAmount: 1000,
  paidAmount: 0,
  firstPaymentDate: null as string | Date | null,
  actualCompletionDate: null as string | Date | null,
  disbursementModel: "fixed_commitment" as string | null,
  awardClosedAt: null as string | Date | null,
};

describe("deriveOppFields commitment lifecycle", () => {
  it("keeps an ordinary cultivation record open", () => {
    const result = deriveOppFields(base);
    expect(result).toMatchObject({
      status: "open",
      stage: "in_conversation",
      commitmentPath: null,
      pledgeCommittedAt: null,
      writtenPledge: false,
    });
  });

  it("keeps a written-pledge path open until pledge finalization", () => {
    const result = deriveOppFields({
      ...base,
      stage: "verbal_confirmation",
      commitmentPath: "written_pledge",
      verbalCommitmentAt: "2026-07-15",
      grantLetterUrl: "/api/storage/objects/pledge-letter",
    });
    expect(result).toMatchObject({
      status: "open",
      stage: "verbal_confirmation",
      commitmentPath: "written_pledge",
      pledgeCommittedAt: null,
      writtenPledge: false,
    });
  });

  it("treats a finalized written pledge as a pledge without overwriting stage", () => {
    const result = deriveOppFields({
      ...base,
      stage: "verbal_confirmation",
      commitmentPath: "written_pledge",
      verbalCommitmentAt: "2026-07-15",
      pledgeCommittedAt: "2026-07-20",
      grantLetterUrl: "/api/storage/objects/pledge-letter",
    });
    expect(result).toMatchObject({
      status: "pledge",
      stage: "verbal_confirmation",
      commitmentPath: "written_pledge",
      pledgeCommittedAt: "2026-07-20",
      writtenPledge: true,
    });
  });

  it("treats a finalized verbal pledge as a pledge without a document", () => {
    const result = deriveOppFields({
      ...base,
      stage: "verbal_confirmation",
      commitmentPath: "verbal_pledge",
      verbalCommitmentAt: "2026-07-15",
      pledgeCommittedAt: "2026-07-15",
    });
    expect(result.status).toBe("pledge");
    expect(result.writtenPledge).toBe(true);
    expect(result.stage).toBe("verbal_confirmation");
  });

  it("keeps a verbally confirmed gift open until money arrives", () => {
    const result = deriveOppFields({
      ...base,
      stage: "verbal_confirmation",
      commitmentPath: "gift",
      verbalCommitmentAt: "2026-07-15",
    });
    expect(result).toMatchObject({
      status: "open",
      commitmentPath: "gift",
      pledgeCommittedAt: null,
      writtenPledge: false,
    });
  });

  it("classifies money received before any pledge as a gift outcome", () => {
    const result = deriveOppFields({
      ...base,
      stage: "verbal_confirmation",
      commitmentPath: "gift",
      verbalCommitmentAt: "2026-07-15",
      paidAmount: 1000,
      firstPaymentDate: "2026-07-25",
    });
    expect(result).toMatchObject({
      status: "cash_in",
      stage: "verbal_confirmation",
      commitmentPath: "gift",
      pledgeCommittedAt: null,
      actualCompletionDate: "2026-07-25",
      writtenPledge: false,
    });
  });

  it("infers a gift outcome when money arrives with no commitment path", () => {
    const result = deriveOppFields({
      ...base,
      paidAmount: 500,
      awardedAmount: 0,
      firstPaymentDate: "2026-07-25",
    });
    expect(result.commitmentPath).toBe("gift");
    expect(result.status).toBe("cash_in");
    expect(result.actualCompletionDate).toBe("2026-07-25");
  });

  it("moves a fully paid finalized pledge to cash_in while preserving pledge identity", () => {
    const result = deriveOppFields({
      ...base,
      stage: "verbal_confirmation",
      commitmentPath: "verbal_pledge",
      verbalCommitmentAt: "2026-07-10",
      pledgeCommittedAt: "2026-07-10",
      paidAmount: 1000,
      firstPaymentDate: "2026-08-01",
    });
    expect(result.status).toBe("cash_in");
    expect(result.pledgeCommittedAt).toBe("2026-07-10");
    expect(result.writtenPledge).toBe(true);
    expect(result.stage).toBe("verbal_confirmation");
  });

  it("uses explicit closure rather than paid >= ceiling for cost reimbursement", () => {
    const stillOpen = deriveOppFields({
      ...base,
      commitmentPath: "written_pledge",
      verbalCommitmentAt: "2026-07-10",
      pledgeCommittedAt: "2026-07-10",
      grantLetterUrl: "/api/storage/objects/pledge-letter",
      disbursementModel: "cost_reimbursement",
      paidAmount: 5000,
    });
    expect(stillOpen.status).toBe("pledge");

    const closed = deriveOppFields({
      ...base,
      commitmentPath: "written_pledge",
      verbalCommitmentAt: "2026-07-10",
      pledgeCommittedAt: "2026-07-10",
      grantLetterUrl: "/api/storage/objects/pledge-letter",
      disbursementModel: "cost_reimbursement",
      awardClosedAt: "2026-08-01",
      paidAmount: 500,
    });
    expect(closed.status).toBe("cash_in");
    expect(closed.pledgeCommittedAt).toBe("2026-07-10");
  });

  it("lets loss and dormant overrides take precedence without erasing commitment history", () => {
    const result = deriveOppFields({
      ...base,
      stage: "verbal_confirmation",
      commitmentPath: "verbal_pledge",
      verbalCommitmentAt: "2026-07-10",
      pledgeCommittedAt: "2026-07-10",
      lossType: "dormant",
    });
    expect(result.status).toBe("dormant");
    expect(result.commitmentPath).toBe("verbal_pledge");
    expect(result.pledgeCommittedAt).toBe("2026-07-10");
    expect(result.stage).toBe("verbal_confirmation");
  });
});

describe("commitment lifecycle weighting", () => {
  it("weights open verbal confirmations through the funnel", () => {
    expect(canonicalWinProbability("open", "verbal_confirmation")).toBe(
      "0.9000",
    );
  });

  it("weights finalized conditional pledges below unconditional pledges", () => {
    expect(
      canonicalWinProbability("pledge", "verbal_confirmation", "unconditional"),
    ).toBe("0.9000");
    expect(
      canonicalWinProbability(
        "pledge",
        "verbal_confirmation",
        "conditional_on_target",
      ),
    ).toBe("0.7500");
  });

  it("retains the shared conditional classification", () => {
    expect(isConditionalPledge("conditional_on_target")).toBe(true);
    expect(isConditionalPledge("unconditional")).toBe(false);
  });
});
