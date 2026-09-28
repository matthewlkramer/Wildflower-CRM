import { describe, expect, it } from "vitest";
import {
  organizationInlineDraftToPatch,
  organizationToInlineDraft,
  type OrgDraft,
} from "./funding-entities";

describe("organization list inline editing", () => {
  it("round-trips active status through the row draft and update patch", () => {
    const draft = organizationToInlineDraft({
      activeStatus: "spenddown",
      priority: "high",
      capacityRating: "tier_50k_250k",
      connectionStatus: "have_a_connector",
      enthusiasm: "6-supportive",
      strategicAlignment: "medium",
    });

    expect(draft.activeStatus).toBe("spenddown");
    expect(
      organizationInlineDraftToPatch({
        ...draft,
        activeStatus: "defunct",
      }),
    ).toMatchObject({ activeStatus: "defunct" });
  });

  it("allows an inline edit to clear active status", () => {
    const draft: OrgDraft = {
      activeStatus: "__none__",
      priority: "__none__",
      capacityRating: "__none__",
      connectionStatus: "__none__",
      enthusiasm: "__none__",
      strategicAlignment: "__none__",
    };

    expect(organizationInlineDraftToPatch(draft)).toEqual({
      activeStatus: null,
      priority: null,
      capacityRating: null,
      connectionStatus: null,
      enthusiasm: null,
      strategicAlignment: null,
    });
  });
});
