import { describe, expect, it } from "vitest";
import { getListOpportunitiesAndPledgesUrl } from "@workspace/api-client-react";

describe("opportunity allocation filters", () => {
  it("serializes Entity/Fund and Purpose as independent query parameters", () => {
    const url = getListOpportunitiesAndPledgesUrl({
      allocationEntityId: ["wildflower_foundation", "black_wildflowers_fund"],
      intendedUsage: ["school_startup", "teacher_training"],
    });

    expect(url).toContain(
      "allocationEntityId=wildflower_foundation%2Cblack_wildflowers_fund",
    );
    expect(url).toContain(
      "intendedUsage=school_startup%2Cteacher_training",
    );
  });
});
