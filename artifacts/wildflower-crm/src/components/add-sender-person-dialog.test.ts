import { describe, expect, it } from "vitest";
import { guessNameFromEmail } from "./add-sender-person-dialog";

describe("guessNameFromEmail", () => {
  it("splits dotted local parts into first/last", () => {
    expect(guessNameFromEmail("jane.doe@kern.org")).toEqual(["Jane", "Doe"]);
    expect(guessNameFromEmail("john_smith@x.org")).toEqual(["John", "Smith"]);
    expect(guessNameFromEmail("a-b-c@x.org")).toEqual(["A", "B C"]);
  });
  it("handles single-word and numeric-noise locals", () => {
    expect(guessNameFromEmail("info@kern.org")).toEqual(["Info", ""]);
    expect(guessNameFromEmail("jane.doe42@x.org")).toEqual(["Jane", "Doe42"]);
    expect(guessNameFromEmail("jane.123@x.org")).toEqual(["Jane", ""]);
  });
  it("never throws on weird input", () => {
    expect(guessNameFromEmail("@x.org")).toEqual(["", ""]);
    expect(guessNameFromEmail("")).toEqual(["", ""]);
  });
});
