import { describe, it, expect } from "vitest";
import { deriveOppFields, canonicalWinProbability } from "../lib/pledgeStage";

const base = {
  stage: "qualified" as string | null,
  lossType: null as string | null,
  wasPledge: false as boolean | null,
  grantLetterUrl: null as string | null,
  awardedAmount: 1000,
  paidAmount: 0,
};

describe("deriveOppFields", () => {
  describe("status derivation matrix (loss_type unset)", () => {
    it("open stage + unpaid → status=open", () => {
      const r = deriveOppFields({ ...base, stage: "qualified" });
      expect(r.status).toBe("open");
    });
    it("verbal_commitment unpaid → status=pledge", () => {
      const r = deriveOppFields({ ...base, stage: "verbal_commitment" });
      expect(r.status).toBe("pledge");
    });
    it("written_commitment unpaid → status=pledge, no stage advance", () => {
      const r = deriveOppFields({ ...base, stage: "written_commitment" });
      expect(r.status).toBe("pledge");
      expect(r.stage).toBe("written_commitment");
    });
    it("written_commitment fully paid → status=cash_in + stage auto-advances to cash_in", () => {
      const r = deriveOppFields({
        ...base,
        stage: "written_commitment",
        paidAmount: 1000,
      });
      expect(r.status).toBe("cash_in");
      expect(r.stage).toBe("cash_in");
    });
    it("written_commitment overpaid → status=cash_in", () => {
      const r = deriveOppFields({
        ...base,
        stage: "written_commitment",
        paidAmount: 1500,
      });
      expect(r.status).toBe("cash_in");
    });
    it("explicit stage=cash_in → status=cash_in even with no payments", () => {
      const r = deriveOppFields({ ...base, stage: "cash_in" });
      expect(r.status).toBe("cash_in");
    });
    it("conditional_commitment → status=open (only verbal/written promote to pledge)", () => {
      const r = deriveOppFields({ ...base, stage: "conditional_commitment" });
      expect(r.status).toBe("open");
    });
    it("zero awarded with payments → not fully paid", () => {
      const r = deriveOppFields({
        ...base,
        stage: "written_commitment",
        awardedAmount: 0,
        paidAmount: 500,
      });
      expect(r.status).toBe("pledge");
      expect(r.stage).toBe("written_commitment");
    });
  });

  describe("loss_type override drives status", () => {
    it("lossType=dormant → status=dormant even when stage is written", () => {
      const r = deriveOppFields({
        ...base,
        lossType: "dormant",
        stage: "written_commitment",
      });
      expect(r.status).toBe("dormant");
    });
    it("lossType=lost → status=lost even when fully paid", () => {
      const r = deriveOppFields({
        ...base,
        lossType: "lost",
        stage: "written_commitment",
        paidAmount: 1000,
      });
      expect(r.status).toBe("lost");
    });
    it("lossType=lost → status=lost on plain open stage", () => {
      const r = deriveOppFields({
        ...base,
        lossType: "lost",
        stage: "qualified",
      });
      expect(r.status).toBe("lost");
    });
    it("clearing lossType (null) re-calculates status from stage/payments", () => {
      const r = deriveOppFields({
        ...base,
        lossType: null,
        stage: "verbal_commitment",
      });
      expect(r.status).toBe("pledge");
    });
    it("lossType=lost on fully-paid written → status=lost (override beats cash_in), but stage still advances", () => {
      const r = deriveOppFields({
        ...base,
        lossType: "lost",
        stage: "written_commitment",
        paidAmount: 1000,
      });
      expect(r.status).toBe("lost");
      expect(r.stage).toBe("cash_in");
    });
  });

  describe("wasPledge stickiness", () => {
    it("flips false→true on conditional_commitment", () => {
      const r = deriveOppFields({ ...base, stage: "conditional_commitment" });
      expect(r.wasPledge).toBe(true);
    });
    it("flips false→true on verbal_commitment", () => {
      const r = deriveOppFields({ ...base, stage: "verbal_commitment" });
      expect(r.wasPledge).toBe(true);
    });
    it("flips false→true on written_commitment", () => {
      const r = deriveOppFields({ ...base, stage: "written_commitment" });
      expect(r.wasPledge).toBe(true);
    });
    it("flips false→true when grant letter url is set, even on open stage", () => {
      const r = deriveOppFields({
        ...base,
        stage: "qualified",
        grantLetterUrl: "/api/storage/objects/abc",
      });
      expect(r.wasPledge).toBe(true);
    });
    it("NEVER auto-clears: stays true even when stage rolls back to qualified with no letter", () => {
      const r = deriveOppFields({ ...base, stage: "qualified", wasPledge: true });
      expect(r.wasPledge).toBe(true);
    });
    it("stays true after cash_in", () => {
      const r = deriveOppFields({
        ...base,
        stage: "cash_in",
        wasPledge: true,
        paidAmount: 1000,
      });
      expect(r.wasPledge).toBe(true);
    });
    it("stays true even when lossType pulls status to dormant/lost", () => {
      const r = deriveOppFields({
        ...base,
        lossType: "dormant",
        stage: "verbal_commitment",
        wasPledge: true,
      });
      expect(r.wasPledge).toBe(true);
      expect(r.status).toBe("dormant");
    });
  });
});

describe("canonicalWinProbability", () => {
  it("dormant/lost calculated status → 0.0000", () => {
    expect(canonicalWinProbability("dormant", "verbal_commitment")).toBe("0.0000");
    expect(canonicalWinProbability("lost", "cash_in")).toBe("0.0000");
  });
  it("calculated status overrides stage for pledge/cash_in", () => {
    expect(canonicalWinProbability("pledge", "cold_lead")).toBe("0.9000");
    expect(canonicalWinProbability("cash_in", "cold_lead")).toBe("1.0000");
  });
  it("falls through to stage when status is open", () => {
    expect(canonicalWinProbability("open", "in_conversation")).toBe("0.2000");
    expect(canonicalWinProbability("open", "convince")).toBe("0.4000");
  });
  it("returns null when neither matches", () => {
    expect(canonicalWinProbability(null, null)).toBeNull();
  });

  it("win probability tracks the loss_type-derived status end-to-end", () => {
    const lost = deriveOppFields({ ...base, lossType: "lost", stage: "verbal_commitment" });
    expect(canonicalWinProbability(lost.status, lost.stage)).toBe("0.0000");
    const open = deriveOppFields({ ...base, lossType: null, stage: "in_conversation" });
    expect(canonicalWinProbability(open.status, open.stage)).toBe("0.2000");
  });
});
