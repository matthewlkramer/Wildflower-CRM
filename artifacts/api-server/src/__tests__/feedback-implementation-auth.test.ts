import { describe, expect, it } from "vitest";
import { canStartFeedbackImplementation } from "../lib/feedbackImplementationAuth";

const owner = {
  id: "usr_owner",
  role: "admin" as const,
  archivedAt: null,
};

describe("feedback implementation authorization", () => {
  it("fails closed when no implementer is configured", () => {
    expect(canStartFeedbackImplementation(owner, undefined)).toBe(false);
    expect(canStartFeedbackImplementation(owner, "   ")).toBe(false);
  });

  it("allows only the configured active admin", () => {
    expect(canStartFeedbackImplementation(owner, " usr_owner ")).toBe(true);
    expect(
      canStartFeedbackImplementation(
        { ...owner, id: "usr_other" },
        "usr_owner",
      ),
    ).toBe(false);
    expect(
      canStartFeedbackImplementation(
        { ...owner, role: "team_member" },
        "usr_owner",
      ),
    ).toBe(false);
    expect(
      canStartFeedbackImplementation(
        { ...owner, archivedAt: new Date() },
        "usr_owner",
      ),
    ).toBe(false);
  });
});
