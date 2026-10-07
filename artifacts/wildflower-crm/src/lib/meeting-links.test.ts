import { describe, expect, it } from "vitest";
import {
  meetingLinkIds,
  meetingLinksFromIds,
  uniqueMeetingLinks,
} from "./meeting-links";

describe("meeting links", () => {
  it("preserves both person and organization links without a primary choice", () => {
    expect(
      meetingLinkIds(
        meetingLinksFromIds({
          personIds: ["person-1", "person-2"],
          organizationIds: ["org-1"],
        }),
      ),
    ).toEqual({
      personIds: ["person-1", "person-2"],
      organizationIds: ["org-1"],
      householdIds: [],
    });
  });

  it("deduplicates matched records without merging kinds", () => {
    expect(
      uniqueMeetingLinks([
        { kind: "person", id: "same" },
        { kind: "person", id: "same" },
        { kind: "organization", id: "same" },
      ]),
    ).toHaveLength(2);
  });
});
