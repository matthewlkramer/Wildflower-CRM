import { describe, expect, it } from "vitest";
import { formatDisplayAddress } from "./format-address";

describe("formatDisplayAddress", () => {
  it.each(["United States", "UNITED STATES", "USA", "U.S.A.", "US", "U.S."])(
    "omits domestic country label %s",
    (country) => {
      expect(
        formatDisplayAddress({
          street: "7035 Blair Road Northwest, #313",
          cityName: "Washington",
          stateCode: "DC",
          postalCode: "20012",
          country,
        }),
      ).toBe("7035 Blair Road Northwest, #313, Washington, DC, 20012");
    },
  );

  it("keeps non-US countries visible", () => {
    expect(
      formatDisplayAddress({
        street: "10 King Street",
        cityName: "Toronto",
        stateCode: "ON",
        postalCode: "M5H 1A1",
        country: "Canada",
      }),
    ).toBe("10 King Street, Toronto, ON, M5H 1A1, Canada");
  });
});
