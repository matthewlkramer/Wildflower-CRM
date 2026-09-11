import { describe, expect, it } from "vitest";
import { scalePlannedAmounts } from "../lib/proportionalPlan";

describe("scalePlannedAmounts", () => {
  it("reduces every line proportionally and preserves an exact cent total", () => {
    const result = scalePlannedAmounts(
      [
        { id: "a", amount: "33.33" },
        { id: "b", amount: "33.33" },
        { id: "c", amount: "33.34" },
      ],
      100,
      75,
    );
    expect(result).toEqual([
      { id: "a", amount: "25.00" },
      { id: "b", amount: "25.00" },
      { id: "c", amount: "25.00" },
    ]);
  });

  it("leaves unknown plan amounts unknown", () => {
    expect(
      scalePlannedAmounts(
        [
          { id: "known", amount: "80.00" },
          { id: "unknown", amount: null },
        ],
        100,
        50,
      ),
    ).toEqual([
      { id: "known", amount: "40.00" },
      { id: "unknown", amount: null },
    ]);
  });

  it("uses largest remainders without making the final line negative", () => {
    expect(
      scalePlannedAmounts(
        [
          { id: "a", amount: "0.01" },
          { id: "b", amount: "0.01" },
          { id: "c", amount: "0.01" },
        ],
        100,
        34,
      ),
    ).toEqual([
      { id: "a", amount: "0.01" },
      { id: "b", amount: "0.00" },
      { id: "c", amount: "0.00" },
    ]);
  });
});
