import { describe, it, expect } from "vitest";
import { deriveOppFields } from "../lib/pledgeStage";

const base = {
  stage: "qualified" as string | null,
  status: "open" as string | null,
  wasPledge: false as boolean | null,
  grantLetterUrl: null as string | null,
  awardedAmount: 1000,
  paidAmount: 0,
};

describe("deriveOppFields", () => {
  describe("status derivation matrix", () => {
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

  describe("dormant/lost stickiness", () => {
    it("dormant stays dormant even when stage promotes to written", () => {
      const r = deriveOppFields({
        ...base,
        status: "dormant",
        stage: "written_commitment",
      });
      expect(r.status).toBe("dormant");
    });
    it("lost stays lost even when fully paid", () => {
      const r = deriveOppFields({
        ...base,
        status: "lost",
        stage: "written_commitment",
        paidAmount: 1000,
      });
      expect(r.status).toBe("lost");
    });
    it("lost stays lost on plain open stage", () => {
      const r = deriveOppFields({ ...base, status: "lost", stage: "qualified" });
      expect(r.status).toBe("lost");
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
    it("stays true even when status is overridden dormant/lost", () => {
      const r = deriveOppFields({
        ...base,
        status: "dormant",
        stage: "verbal_commitment",
        wasPledge: true,
      });
      expect(r.wasPledge).toBe(true);
      expect(r.status).toBe("dormant");
    });
  });
});
