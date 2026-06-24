import { describe, it, expect } from "vitest";
import {
  deriveOppFields,
  canonicalWinProbability,
  isConditionalPledge,
} from "../lib/pledgeStage";

const base = {
  // A real cultivation funnel stage (the funnel is separate from outcome).
  stage: "in_conversation" as string | null,
  lossType: null as string | null,
  writtenPledge: false as boolean | null,
  conditional: null as string | null,
  grantLetterUrl: null as string | null,
  awardedAmount: 1000,
  paidAmount: 0,
};

describe("deriveOppFields", () => {
  describe("status derivation matrix (loss_type unset)", () => {
    it("plain funnel stage + unpaid → status=open, stage unchanged", () => {
      const r = deriveOppFields({ ...base, stage: "in_conversation" });
      expect(r.status).toBe("open");
      expect(r.stage).toBe("in_conversation");
    });
    it("verbal_confirmation unpaid → status=open (funnel stage, not a pledge)", () => {
      const r = deriveOppFields({ ...base, stage: "verbal_confirmation" });
      expect(r.status).toBe("open");
      expect(r.stage).toBe("verbal_confirmation");
    });
    it("writtenPledge unpaid → status=pledge + stage advances to complete (won)", () => {
      const r = deriveOppFields({ ...base, writtenPledge: true });
      expect(r.status).toBe("pledge");
      expect(r.stage).toBe("complete");
    });
    it("fully paid → status=cash_in + stage advances to complete (won)", () => {
      const r = deriveOppFields({
        ...base,
        writtenPledge: true,
        paidAmount: 1000,
      });
      expect(r.status).toBe("cash_in");
      expect(r.stage).toBe("complete");
    });
    it("overpaid → status=cash_in", () => {
      const r = deriveOppFields({
        ...base,
        writtenPledge: true,
        paidAmount: 1500,
      });
      expect(r.status).toBe("cash_in");
      expect(r.stage).toBe("complete");
    });
    it("legacy stage=cash_in no longer latches writtenPledge (cash-in is not a pledge)", () => {
      const r = deriveOppFields({ ...base, stage: "cash_in" });
      expect(r.writtenPledge).toBe(false);
      expect(r.status).toBe("open");
    });
    it("legacy stage=cash_in WITH full payment → status=cash_in (payment-driven), not a pledge", () => {
      const r = deriveOppFields({ ...base, stage: "cash_in", paidAmount: 1000 });
      expect(r.status).toBe("cash_in");
      expect(r.stage).toBe("complete");
      expect(r.writtenPledge).toBe(false);
    });
    it("legacy written_commitment stage no longer latches writtenPledge", () => {
      const r = deriveOppFields({ ...base, stage: "written_commitment" });
      expect(r.writtenPledge).toBe(false);
      expect(r.status).toBe("open");
    });
    it("zero awarded with payments → not fully paid, stays pledge when written", () => {
      const r = deriveOppFields({
        ...base,
        writtenPledge: true,
        awardedAmount: 0,
        paidAmount: 500,
      });
      expect(r.status).toBe("pledge");
      expect(r.stage).toBe("complete");
    });
  });

  describe("loss_type override drives status (cultivation stage preserved)", () => {
    it("lossType=dormant → status=dormant, funnel stage preserved", () => {
      const r = deriveOppFields({
        ...base,
        lossType: "dormant",
        stage: "convince",
      });
      expect(r.status).toBe("dormant");
      expect(r.stage).toBe("convince");
    });
    it("lossType=lost → status=lost even when fully paid; stage NOT advanced to complete", () => {
      const r = deriveOppFields({
        ...base,
        lossType: "lost",
        stage: "verbal_confirmation",
        paidAmount: 1000,
      });
      expect(r.status).toBe("lost");
      expect(r.stage).toBe("verbal_confirmation");
    });
    it("lossType=lost on plain funnel stage → status=lost", () => {
      const r = deriveOppFields({
        ...base,
        lossType: "lost",
        stage: "cold_lead",
      });
      expect(r.status).toBe("lost");
      expect(r.stage).toBe("cold_lead");
    });
    it("clearing lossType (null) re-calculates status from writtenPledge/payments", () => {
      const r = deriveOppFields({
        ...base,
        lossType: null,
        writtenPledge: true,
      });
      expect(r.status).toBe("pledge");
    });
    it("a stale complete on a non-won row reverts to the pre-win funnel stage", () => {
      const r = deriveOppFields({
        ...base,
        lossType: "lost",
        stage: "complete",
      });
      expect(r.status).toBe("lost");
      expect(r.stage).toBe("verbal_confirmation");
    });
  });

  describe("writtenPledge stickiness", () => {
    it("does NOT flip writtenPledge on legacy conditional_commitment stage", () => {
      const r = deriveOppFields({ ...base, stage: "conditional_commitment" });
      expect(r.writtenPledge).toBe(false);
      expect(r.status).toBe("open");
    });
    it("does NOT flip writtenPledge on verbal_confirmation (funnel stage)", () => {
      const r = deriveOppFields({ ...base, stage: "verbal_confirmation" });
      expect(r.writtenPledge).toBe(false);
      expect(r.status).toBe("open");
    });
    it("does NOT flip writtenPledge on legacy written_commitment stage", () => {
      const r = deriveOppFields({ ...base, stage: "written_commitment" });
      expect(r.writtenPledge).toBe(false);
      expect(r.status).toBe("open");
    });
    it("flips false→true when a grant letter is set on an unpaid opp, even on a plain funnel stage", () => {
      const r = deriveOppFields({
        ...base,
        stage: "cold_lead",
        grantLetterUrl: "/api/storage/objects/abc",
      });
      expect(r.writtenPledge).toBe(true);
    });
    it("does NOT latch on a grant letter when the money is already fully in", () => {
      const r = deriveOppFields({
        ...base,
        stage: "cold_lead",
        grantLetterUrl: "/api/storage/objects/abc",
        paidAmount: 1000,
      });
      expect(r.writtenPledge).toBe(false);
      expect(r.status).toBe("cash_in");
    });
    it("NEVER auto-clears: stays true even when stage rolls back with no letter", () => {
      const r = deriveOppFields({
        ...base,
        stage: "cold_lead",
        writtenPledge: true,
      });
      expect(r.writtenPledge).toBe(true);
    });
    it("stays true after cash_in", () => {
      const r = deriveOppFields({
        ...base,
        writtenPledge: true,
        paidAmount: 1000,
      });
      expect(r.writtenPledge).toBe(true);
    });
    it("stays true even when lossType pulls status to dormant", () => {
      const r = deriveOppFields({
        ...base,
        lossType: "dormant",
        writtenPledge: true,
      });
      expect(r.writtenPledge).toBe(true);
      expect(r.status).toBe("dormant");
    });
  });
});

describe("isConditionalPledge", () => {
  it("true only for the genuinely-uncertain conditional kinds", () => {
    expect(isConditionalPledge("conditional_unspecified")).toBe(true);
    expect(isConditionalPledge("conditional_on_funder_determination")).toBe(true);
    expect(isConditionalPledge("conditional_on_target")).toBe(true);
  });
  it("false for unconditional / reimbursable / null", () => {
    expect(isConditionalPledge("unconditional")).toBe(false);
    expect(isConditionalPledge("reimbursable")).toBe(false);
    expect(isConditionalPledge(null)).toBe(false);
    expect(isConditionalPledge(undefined)).toBe(false);
  });
});

describe("canonicalWinProbability", () => {
  it("dormant/lost calculated status → 0.0000", () => {
    expect(canonicalWinProbability("dormant", "verbal_confirmation")).toBe("0.0000");
    expect(canonicalWinProbability("lost", "complete")).toBe("0.0000");
  });
  it("cash_in → 1.0000", () => {
    expect(canonicalWinProbability("cash_in", "complete")).toBe("1.0000");
    expect(canonicalWinProbability("cash_in", "cold_lead")).toBe("1.0000");
  });
  it("unpaid written pledge is its own weighted category (90% non-conditional)", () => {
    expect(canonicalWinProbability("pledge", "complete")).toBe("0.9000");
    expect(canonicalWinProbability("pledge", "complete", "unconditional")).toBe("0.9000");
    expect(canonicalWinProbability("pledge", "complete", "reimbursable")).toBe("0.9000");
  });
  it("conditional written pledge weights 75%", () => {
    expect(canonicalWinProbability("pledge", "complete", "conditional_unspecified")).toBe("0.7500");
    expect(canonicalWinProbability("pledge", "complete", "conditional_on_target")).toBe("0.7500");
  });
  it("open status weights by funnel stage", () => {
    expect(canonicalWinProbability("open", "cold_lead")).toBe("0.0000");
    expect(canonicalWinProbability("open", "warm_lead")).toBe("0.0500");
    expect(canonicalWinProbability("open", "in_conversation")).toBe("0.2000");
    expect(canonicalWinProbability("open", "convince")).toBe("0.4000");
    expect(canonicalWinProbability("open", "probable_renewal")).toBe("0.7500");
    expect(canonicalWinProbability("open", "verbal_confirmation")).toBe("0.9000");
  });
  it("returns null when neither matches", () => {
    expect(canonicalWinProbability(null, null)).toBeNull();
    expect(canonicalWinProbability("open", null)).toBeNull();
  });

  it("win probability tracks the derived status end-to-end", () => {
    const lost = deriveOppFields({ ...base, lossType: "lost", writtenPledge: true });
    expect(canonicalWinProbability(lost.status, lost.stage, base.conditional)).toBe("0.0000");
    const open = deriveOppFields({ ...base, stage: "in_conversation" });
    expect(canonicalWinProbability(open.status, open.stage, base.conditional)).toBe("0.2000");
    const pledge = deriveOppFields({ ...base, writtenPledge: true, conditional: "conditional_on_target" });
    expect(canonicalWinProbability(pledge.status, pledge.stage, "conditional_on_target")).toBe("0.7500");
  });
});
