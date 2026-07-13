import { describe, expect, it } from "vitest";
import {
  changeReachedIntendedState,
  isAlreadyResolvedError,
  type ResolvedStateProbe,
} from "./reconciliation";

/**
 * These cover the self-healing path of Apply-to-CRM: an already-resolved staged
 * payment (the non-idempotent `not_pending` 409) must NOT surface as a scary
 * error when the row already reached the outcome the reviewer staged, but must
 * stay in the tray with a calm note when it was resolved into a different state.
 */
describe("isAlreadyResolvedError", () => {
  it("recognizes the 409 not_pending shape thrown by the resolve endpoints", () => {
    expect(
      isAlreadyResolvedError({
        status: 409,
        data: {
          error: "not_pending",
          message: "This staged payment has already been resolved.",
        },
      }),
    ).toBe(true);
  });

  it("ignores other 409s (real blocking conflicts)", () => {
    expect(
      isAlreadyResolvedError({
        status: 409,
        data: { error: "link_conflict", message: "already linked" },
      }),
    ).toBe(false);
    expect(
      isAlreadyResolvedError({
        status: 409,
        data: { error: "consistency_gate", details: { issues: [] } },
      }),
    ).toBe(false);
  });

  it("ignores non-409 errors and malformed values", () => {
    expect(
      isAlreadyResolvedError({ status: 400, data: { error: "not_pending" } }),
    ).toBe(false);
    expect(isAlreadyResolvedError(new Error("boom"))).toBe(false);
    expect(isAlreadyResolvedError(null)).toBe(false);
    expect(isAlreadyResolvedError({ status: 409 })).toBe(false);
  });
});

describe("changeReachedIntendedState", () => {
  const sp = "sp_1";

  it("treats a split as applied once the payment shows as a resolved done card", () => {
    const probe: ResolvedStateProbe = {
      kind: "split",
      stagedPaymentId: sp,
      targetGiftId: null,
    };
    expect(
      changeReachedIntendedState(probe, {
        done: [{ stagedPaymentId: sp, resolvedGiftId: "gift_a" }],
      }),
    ).toBe(true);
  });

  it("keeps a split unapplied when the payment is not yet a resolved done card", () => {
    const probe: ResolvedStateProbe = {
      kind: "split",
      stagedPaymentId: sp,
      targetGiftId: null,
    };
    expect(
      changeReachedIntendedState(probe, {
        done: [{ stagedPaymentId: "sp_other", resolvedGiftId: "gift_a" }],
      }),
    ).toBe(false);
  });

  it("confirms a link only when the done card ties to the intended gift", () => {
    const probe: ResolvedStateProbe = {
      kind: "confirm",
      stagedPaymentId: sp,
      targetGiftId: "gift_target",
    };
    expect(
      changeReachedIntendedState(probe, {
        done: [{ stagedPaymentId: sp, resolvedGiftId: "gift_target" }],
      }),
    ).toBe(true);
  });

  it("keeps a link unapplied when it resolved to a DIFFERENT gift", () => {
    const probe: ResolvedStateProbe = {
      kind: "confirm",
      stagedPaymentId: sp,
      targetGiftId: "gift_target",
    };
    expect(
      changeReachedIntendedState(probe, {
        done: [{ stagedPaymentId: sp, resolvedGiftId: "gift_other" }],
      }),
    ).toBe(false);
  });
});
