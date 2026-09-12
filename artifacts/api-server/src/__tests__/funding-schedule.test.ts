import { describe, expect, it } from "vitest";
import { remainingFundingSchedule } from "../lib/fundingSchedule";

const rows = [
  { id: "first", expectedDate: "2026-08-01", amount: "400" },
  { id: "second", expectedDate: "2026-10-01", amount: "600" },
];
describe("remaining funding schedule", () => {
  it.each([
    [0, 1000, [400, 600]],
    [250, 750, [150, 600]],
    [400, 600, [0, 600]],
    [1000, 0, [0, 0]],
    [1200, 0, [0, 0]],
    [0, 800, [400, 400]],
    [250, 550, [150, 400]],
  ])(
    "nets paid %s against collectible remainder %s",
    (paid, unpaid, expected) => {
      expect(
        remainingFundingSchedule(rows, paid as number, unpaid as number).map(
          (row) => row.remaining,
        ),
      ).toEqual(expected);
    },
  );
  it("keeps later coverage unknown when a preceding unknown amount could consume payments", () => {
    const uncertain = [{ ...rows[0], amount: null }, rows[1]];
    expect(
      remainingFundingSchedule(uncertain, 100, 900).map((row) => row.remaining),
    ).toEqual([null, null]);
  });
  it("can place a later known amount when no payments are ambiguously allocated", () => {
    expect(
      remainingFundingSchedule(
        [{ ...rows[0], amount: null }, rows[1]],
        0,
        1000,
      ).map((row) => row.remaining),
    ).toEqual([null, 600]);
  });
  it("does not turn unknown collection capacity into zero or invented scheduled cash", () => {
    expect(
      remainingFundingSchedule(rows, 0, null).map((row) => row.remaining),
    ).toEqual([null, null]);
  });
  it("sorts by receipt date without mutating the input", () => {
    const reversed = [...rows].reverse();
    expect(
      remainingFundingSchedule(reversed, 400, 600).map((row) => row.id),
    ).toEqual(["first", "second"]);
    expect(reversed[0].id).toBe("second");
  });
  it("uses whole cents and never exceeds the collectible remainder", () => {
    const cents = rows.map((row) => ({ ...row, amount: "0.03" }));
    expect(
      remainingFundingSchedule(cents, 0.01, 0.04).map((row) => row.remaining),
    ).toEqual([0.02, 0.02]);
  });
});
