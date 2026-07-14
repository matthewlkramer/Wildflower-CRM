// Close-transition rule: a request that NEWLY closes an opportunity
// (lossType → dormant/lost, or stage → complete) must leave the row with an
// actualCompletionDate. Already-closed rows — including the ~244 legacy
// closed rows without dates — must stay freely editable, so the rule fires
// only on the transition itself (API-level replacement for the dropped
// `closed_requires_completion_date` DB CHECK).
import { describe, it, expect } from "vitest";
import {
  validateOppCloseTransition,
  CreateOpportunityOrPledgeBodyRefined,
  CLOSE_REQUIRES_COMPLETION_DATE_MESSAGE,
} from "@workspace/api-zod";

const OPEN = { lossType: null, stage: "in_conversation", actualCompletionDate: null };
const LEGACY_LOST_NO_DATE = { lossType: "lost", stage: "in_conversation", actualCompletionDate: null };
const COMPLETE_NO_DATE = { lossType: null, stage: "complete", actualCompletionDate: null };
const OPEN_WITH_DATE = { lossType: null, stage: "convince", actualCompletionDate: "2026-01-15" };

function issues(existing: Parameters<typeof validateOppCloseTransition>[0], patch: Parameters<typeof validateOppCloseTransition>[1]) {
  return validateOppCloseTransition(existing, patch);
}

describe("validateOppCloseTransition", () => {
  describe("newly closing without a date → blocked", () => {
    it.each([
      ["lossType lost", { lossType: "lost" }],
      ["lossType dormant", { lossType: "dormant" }],
      ["stage complete", { stage: "complete" }],
      ["lossType lost + explicit null date", { lossType: "lost", actualCompletionDate: null }],
      ["lossType lost + empty-string date", { lossType: "lost", actualCompletionDate: "" }],
    ])("%s", (_label, patch) => {
      const out = issues(OPEN, patch);
      expect(out).toHaveLength(1);
      expect(out[0]!.path).toBe("actualCompletionDate");
      expect(out[0]!.message).toBe(CLOSE_REQUIRES_COMPLETION_DATE_MESSAGE);
    });

    it("clearing the row's existing date in the same closing patch", () => {
      expect(issues(OPEN_WITH_DATE, { lossType: "lost", actualCompletionDate: null })).toHaveLength(1);
    });
  });

  describe("newly closing WITH a date → allowed", () => {
    it("date supplied in the same patch", () => {
      expect(issues(OPEN, { lossType: "lost", actualCompletionDate: "2026-07-13" })).toEqual([]);
      expect(issues(OPEN, { stage: "complete", actualCompletionDate: "2026-07-13" })).toEqual([]);
    });

    it("date already on the row (patch leaves it unchanged)", () => {
      expect(issues(OPEN_WITH_DATE, { lossType: "dormant" })).toEqual([]);
    });
  });

  describe("already-closed rows are grandfathered (legacy no-date rows stay editable)", () => {
    it("legacy lost row: rename-style patch of unrelated fields", () => {
      expect(issues(LEGACY_LOST_NO_DATE, {})).toEqual([]);
    });

    it("legacy lost row: switching dormant↔lost without a date", () => {
      expect(issues(LEGACY_LOST_NO_DATE, { lossType: "dormant" })).toEqual([]);
      expect(issues({ ...LEGACY_LOST_NO_DATE, lossType: "dormant" }, { lossType: "lost" })).toEqual([]);
    });

    it("legacy complete-stage row: re-asserting stage complete without a date", () => {
      expect(issues(COMPLETE_NO_DATE, { stage: "complete" })).toEqual([]);
      expect(issues(COMPLETE_NO_DATE, { lossType: "lost" })).toEqual([]);
    });

    it("reopening (lossType → null) never requires a date", () => {
      expect(issues(LEGACY_LOST_NO_DATE, { lossType: null })).toEqual([]);
    });
  });

  describe("non-closing patches never fire", () => {
    it("date-only edits, stage moves within the funnel, clearing the date on an open row", () => {
      expect(issues(OPEN, { actualCompletionDate: "2026-07-13" })).toEqual([]);
      expect(issues(OPEN, { stage: "convince" })).toEqual([]);
      expect(issues(OPEN_WITH_DATE, { actualCompletionDate: null })).toEqual([]);
    });

    it("a merged-state close caused purely by pre-existing fields is not a transition", () => {
      // e.g. row already lost; patch touches only the name → not gated.
      expect(issues(LEGACY_LOST_NO_DATE, { stage: "warm_lead" })).toEqual([]);
    });
  });
});

describe("CreateOpportunityOrPledgeBodyRefined (create = close from nothing)", () => {
  it("rejects creating an already-closed row without a date", () => {
    const out = CreateOpportunityOrPledgeBodyRefined.safeParse({
      name: "Test opp",
      organizationId: "org-1",
      lossType: "lost",
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(out.error.issues.some((i) => i.message === CLOSE_REQUIRES_COMPLETION_DATE_MESSAGE)).toBe(true);
    }
  });

  it("accepts creating a closed row with a date", () => {
    const out = CreateOpportunityOrPledgeBodyRefined.safeParse({
      name: "Test opp",
      organizationId: "org-1",
      lossType: "lost",
      actualCompletionDate: "2026-07-13",
    });
    expect(out.success).toBe(true);
  });

  it("accepts creating an ordinary open row without a date", () => {
    const out = CreateOpportunityOrPledgeBodyRefined.safeParse({
      name: "Test opp",
      organizationId: "org-1",
    });
    expect(out.success).toBe(true);
  });
});
