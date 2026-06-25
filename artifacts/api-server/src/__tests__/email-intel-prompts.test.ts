import { describe, it, expect } from "vitest";
import {
  EMAIL_INTEL_SIGNAL_TYPES,
  EMAIL_INTEL_REVIEW_PHASES,
  signalTypeForKind,
  kindsForSignalType,
  buildActionProposingCorePrompt,
  buildDefaultReviewPrompt,
  composeSystemPrompt,
  deriveHideDecision,
} from "../lib/emailIntelPrompts.js";

describe("email-intel prompt model", () => {
  it("covers exactly the 6 review signal types (wildflower_update excluded)", () => {
    expect([...EMAIL_INTEL_SIGNAL_TYPES].sort()).toEqual(
      [
        "auto_responder_move",
        "bounce",
        "grant_opportunity",
        "linkedin_job_change",
        "signature_update",
        "thank_you_acknowledgment",
      ].sort(),
    );
    expect(EMAIL_INTEL_SIGNAL_TYPES).not.toContain(
      "wildflower_update" as never,
    );
    expect([...EMAIL_INTEL_REVIEW_PHASES].sort()).toEqual([
      "accuracy",
      "suppression",
    ]);
  });

  describe("signalTypeForKind / kindsForSignalType", () => {
    it("maps both bounce kinds onto the single bounce signal type", () => {
      expect(signalTypeForKind("bounce_invalid")).toBe("bounce");
      expect(signalTypeForKind("bounce_soft")).toBe("bounce");
      expect(kindsForSignalType("bounce").sort()).toEqual([
        "bounce_invalid",
        "bounce_soft",
      ]);
    });

    it("maps every non-bounce signal type 1:1", () => {
      for (const st of EMAIL_INTEL_SIGNAL_TYPES) {
        if (st === "bounce") continue;
        expect(signalTypeForKind(st)).toBe(st);
        expect(kindsForSignalType(st)).toEqual([st]);
      }
    });

    it("returns null for kinds that never reach the review step", () => {
      expect(signalTypeForKind("wildflower_update")).toBeNull();
      expect(signalTypeForKind("something_else")).toBeNull();
    });

    it("round-trips: every kind a signal type owns maps back to it", () => {
      for (const st of EMAIL_INTEL_SIGNAL_TYPES) {
        for (const kind of kindsForSignalType(st)) {
          expect(signalTypeForKind(kind)).toBe(st);
        }
      }
    });
  });

  describe("buildDefaultReviewPrompt", () => {
    it("returns distinct, non-empty defaults for every (type, phase) key", () => {
      for (const st of EMAIL_INTEL_SIGNAL_TYPES) {
        const accuracy = buildDefaultReviewPrompt(st, "accuracy");
        const suppression = buildDefaultReviewPrompt(st, "suppression");
        expect(accuracy.trim().length).toBeGreaterThan(0);
        expect(suppression.trim().length).toBeGreaterThan(0);
        expect(accuracy).not.toEqual(suppression);
      }
    });
  });

  describe("composeSystemPrompt", () => {
    it("appends the hidden core plus both review sections for the signal type", () => {
      const composed = composeSystemPrompt({
        signalType: "grant_opportunity",
        accuracyPrompt: "ACC-MARKER",
        suppressionPrompt: "SUP-MARKER",
      });
      expect(composed).toContain(buildActionProposingCorePrompt());
      expect(composed).toContain("ACCURACY REVIEW (signal type: Grant opportunity)");
      expect(composed).toContain("SUPPRESSION REVIEW (signal type: Grant opportunity)");
      expect(composed).toContain("ACC-MARKER");
      expect(composed).toContain("SUP-MARKER");
      // Accuracy section comes before suppression.
      expect(composed.indexOf("ACC-MARKER")).toBeLessThan(
        composed.indexOf("SUP-MARKER"),
      );
    });
  });

  describe("deriveHideDecision", () => {
    it("never hides when the reviewer explicitly re-ran it (/revise path)", () => {
      const d = deriveHideDecision({
        disableAutoSuppress: true,
        actionsCount: 0,
        accuracy: { isAccurate: false, reason: "wrong" },
        suppress: { shouldSuppress: true, reason: "noise" },
      });
      expect(d.hide).toBe(false);
    });

    it("hides an inaccurate signal with a distinct 'Flagged inaccurate' reason, even with actions", () => {
      const d = deriveHideDecision({
        actionsCount: 3,
        accuracy: { isAccurate: false, reason: "grant winner, not a new opp" },
        suppress: null,
      });
      expect(d.hide).toBe(true);
      if (!d.hide) throw new Error("expected hide");
      expect(d.status).toBe("ignored");
      expect(d.reviewerNote).toBe(
        "Flagged inaccurate: grant winner, not a new opp",
      );
    });

    it("inaccurate takes precedence over suppress", () => {
      const d = deriveHideDecision({
        actionsCount: 0,
        accuracy: { isAccurate: false, reason: "wrong" },
        suppress: { shouldSuppress: true, reason: "noise" },
      });
      expect(d.hide).toBe(true);
      if (!d.hide) throw new Error("expected hide");
      expect(d.reviewerNote.startsWith("Flagged inaccurate")).toBe(true);
      expect(d.reviewerNote).not.toContain("Auto-suppressed");
    });

    it("suppresses non-actionable noise with a distinct 'Auto-suppressed' reason", () => {
      const d = deriveHideDecision({
        actionsCount: 0,
        accuracy: { isAccurate: true },
        suppress: { shouldSuppress: true, reason: "deadline passed" },
      });
      expect(d.hide).toBe(true);
      if (!d.hide) throw new Error("expected hide");
      expect(d.reviewerNote).toBe("Auto-suppressed: deadline passed");
    });

    it("never suppresses a proposal that still carries concrete actions", () => {
      const d = deriveHideDecision({
        actionsCount: 2,
        accuracy: { isAccurate: true },
        suppress: { shouldSuppress: true, reason: "noise" },
      });
      expect(d.hide).toBe(false);
    });

    it("keeps an accurate, non-suppressed proposal visible", () => {
      const d = deriveHideDecision({
        actionsCount: 1,
        accuracy: { isAccurate: true },
        suppress: { shouldSuppress: false },
      });
      expect(d.hide).toBe(false);
    });

    it("falls back to generic text when a reason is blank", () => {
      const inacc = deriveHideDecision({
        actionsCount: 0,
        accuracy: { isAccurate: false, reason: "   " },
        suppress: null,
      });
      if (!inacc.hide) throw new Error("expected hide");
      expect(inacc.reviewerNote).toBe(
        "Flagged inaccurate: detected signal is not accurate",
      );
      const supp = deriveHideDecision({
        actionsCount: 0,
        accuracy: { isAccurate: true },
        suppress: { shouldSuppress: true },
      });
      if (!supp.hide) throw new Error("expected hide");
      expect(supp.reviewerNote).toBe("Auto-suppressed: non-actionable noise");
    });

    it("caps the reviewer note at 500 chars", () => {
      const d = deriveHideDecision({
        actionsCount: 0,
        accuracy: { isAccurate: false, reason: "x".repeat(1000) },
        suppress: null,
      });
      if (!d.hide) throw new Error("expected hide");
      expect(d.reviewerNote.length).toBe(500);
    });
  });
});
