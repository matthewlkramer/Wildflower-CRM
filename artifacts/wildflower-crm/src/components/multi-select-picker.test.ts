import { describe, expect, it } from "vitest";
import { INTERESTS_GOV_MODELS_SUGGESTIONS } from "./multi-select-picker";

describe("governance model suggestions", () => {
  it("offers childcare centers and Head Start in the shared picker", () => {
    expect(INTERESTS_GOV_MODELS_SUGGESTIONS.map((option) => option.value)).toEqual(
      ["Charter", "Childcare center", "Head Start", "Voucher"],
    );
  });
});
