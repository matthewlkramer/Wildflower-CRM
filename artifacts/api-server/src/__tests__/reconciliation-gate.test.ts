import { describe, it, expect } from "vitest";
import {
  runConsistencyGate,
  amountWithinFeeBand,
  type ConsistencyGateInput,
  type GateIssueCode,
} from "../lib/reconciliationGate";

function codes(input: ConsistencyGateInput): GateIssueCode[] {
  return runConsistencyGate(input).map((i) => i.code);
}

// A consistent baseline: pending QB anchor, single-donor gift, evidence == gift
// amount, no opportunity, no Stripe charge.
function baseInput(
  overrides: Partial<ConsistencyGateInput> = {},
): ConsistencyGateInput {
  return {
    staged: { id: "sp1", status: "pending" },
    gift: {
      id: "g1",
      amount: "100.00",
      archivedAt: null,
      organizationId: "org1",
      individualGiverPersonId: null,
      householdId: null,
    },
    opportunity: null,
    evidenceAmount: "100.00",
    stripeCharge: null,
    stagedPayoutIds: [],
    overrideAmountMismatchReason: null,
    ...overrides,
  };
}

describe("amountWithinFeeBand", () => {
  it("equal to the cent → within band", () => {
    expect(amountWithinFeeBand("100.00", "100.00")).toBe(true);
  });
  it("gift (gross) above evidence (net) within fee band → within band", () => {
    // 100 net, 103 gross → within 10% + $1
    expect(amountWithinFeeBand("100.00", "103.00")).toBe(true);
  });
  it("gift far above evidence beyond fee band → out of band", () => {
    expect(amountWithinFeeBand("100.00", "200.00")).toBe(false);
  });
  it("gift below evidence beyond a half-cent → out of band", () => {
    expect(amountWithinFeeBand("100.00", "90.00")).toBe(false);
  });
  it("both null → trivially within band", () => {
    expect(amountWithinFeeBand(null, null)).toBe(true);
  });
  it("one null → out of band", () => {
    expect(amountWithinFeeBand("100.00", null)).toBe(false);
    expect(amountWithinFeeBand(null, "100.00")).toBe(false);
  });
  it("non-numeric → out of band", () => {
    expect(amountWithinFeeBand("abc", "100.00")).toBe(false);
  });
});

describe("runConsistencyGate", () => {
  it("consistent baseline → no issues", () => {
    expect(codes(baseInput())).toEqual([]);
  });

  it("missing QB anchor → qb_missing", () => {
    expect(codes(baseInput({ staged: null }))).toContain("qb_missing");
  });

  it("reconciled QB anchor → qb_not_pending", () => {
    expect(
      codes(baseInput({ staged: { id: "sp1", status: "reconciled" } })),
    ).toContain("qb_not_pending");
  });

  it("excluded QB anchor → qb_not_pending", () => {
    expect(
      codes(baseInput({ staged: { id: "sp1", status: "excluded" } })),
    ).toContain("qb_not_pending");
  });

  // A legacy `approved` row (from the old /staged-payments flow) is still OPEN for
  // reconciliation — it must NOT be blocked by the gate.
  it("approved QB anchor → no qb_not_pending (still open for reconciliation)", () => {
    expect(
      codes(baseInput({ staged: { id: "sp1", status: "approved" } })),
    ).not.toContain("qb_not_pending");
  });

  it("gift with no donor → donor_missing", () => {
    expect(
      codes(
        baseInput({
          gift: {
            id: "g1",
            amount: "100.00",
            archivedAt: null,
            organizationId: null,
            individualGiverPersonId: null,
            householdId: null,
          },
        }),
      ),
    ).toContain("donor_missing");
  });

  it("gift with two donors → donor_not_xor", () => {
    expect(
      codes(
        baseInput({
          gift: {
            id: "g1",
            amount: "100.00",
            archivedAt: null,
            organizationId: "org1",
            individualGiverPersonId: "p1",
            householdId: null,
          },
        }),
      ),
    ).toContain("donor_not_xor");
  });

  it("archived gift → gift_archived", () => {
    expect(
      codes(
        baseInput({
          gift: {
            id: "g1",
            amount: "100.00",
            archivedAt: new Date(),
            organizationId: "org1",
            individualGiverPersonId: null,
            householdId: null,
          },
        }),
      ),
    ).toContain("gift_archived");
  });

  it("archived opportunity → opportunity_archived", () => {
    expect(
      codes(
        baseInput({
          opportunity: {
            id: "o1",
            archivedAt: new Date(),
            organizationId: "org1",
            individualGiverPersonId: null,
            householdId: null,
          },
        }),
      ),
    ).toContain("opportunity_archived");
  });

  it("opportunity donor != gift donor → gift_donor_mismatch_opportunity", () => {
    expect(
      codes(
        baseInput({
          opportunity: {
            id: "o1",
            archivedAt: null,
            organizationId: "org2",
            individualGiverPersonId: null,
            householdId: null,
          },
        }),
      ),
    ).toContain("gift_donor_mismatch_opportunity");
  });

  it("opportunity donor == gift donor → no mismatch", () => {
    expect(
      codes(
        baseInput({
          opportunity: {
            id: "o1",
            archivedAt: null,
            organizationId: "org1",
            individualGiverPersonId: null,
            householdId: null,
          },
        }),
      ),
    ).not.toContain("gift_donor_mismatch_opportunity");
  });

  it("Stripe charge not in this payment's payouts → stripe_charge_unlinked", () => {
    expect(
      codes(
        baseInput({
          stripeCharge: { id: "c1", stripePayoutId: "po-other" },
          stagedPayoutIds: ["po1"],
        }),
      ),
    ).toContain("stripe_charge_unlinked");
  });

  it("Stripe charge belongs to this payment's payout → no unlinked issue", () => {
    expect(
      codes(
        baseInput({
          stripeCharge: { id: "c1", stripePayoutId: "po1" },
          stagedPayoutIds: ["po1"],
          // Stripe gross precedence: evidence amount is the charge gross.
          evidenceAmount: "100.00",
        }),
      ),
    ).not.toContain("stripe_charge_unlinked");
  });

  it("amount out of band, no override → amount_out_of_band", () => {
    expect(
      codes(baseInput({ evidenceAmount: "100.00", gift: { ...baseInput().gift, amount: "500.00" } })),
    ).toContain("amount_out_of_band");
  });

  it("amount out of band WITH override reason → waived", () => {
    expect(
      codes(
        baseInput({
          evidenceAmount: "100.00",
          gift: { ...baseInput().gift, amount: "500.00" },
          overrideAmountMismatchReason: "Donor covered the processor fee separately",
        }),
      ),
    ).not.toContain("amount_out_of_band");
  });

  it("blank override reason does NOT waive the band check", () => {
    expect(
      codes(
        baseInput({
          evidenceAmount: "100.00",
          gift: { ...baseInput().gift, amount: "500.00" },
          overrideAmountMismatchReason: "   ",
        }),
      ),
    ).toContain("amount_out_of_band");
  });

  // ── Stripe precedence: a charge must be selected when one is available ──────
  it("no charge selected but unreconciled charges available → stripe_charge_required", () => {
    expect(
      codes(
        baseInput({
          stripeCharge: null,
          stripeChargesAvailable: 2,
        }),
      ),
    ).toContain("stripe_charge_required");
  });

  it("no charge selected and none available → no stripe_charge_required", () => {
    expect(
      codes(
        baseInput({
          stripeCharge: null,
          stripeChargesAvailable: 0,
        }),
      ),
    ).not.toContain("stripe_charge_required");
  });

  it("a charge IS selected → no stripe_charge_required even if more are available", () => {
    expect(
      codes(
        baseInput({
          stripeCharge: { id: "c1", stripePayoutId: "po1" },
          stagedPayoutIds: ["po1"],
          stripeChargesAvailable: 3,
        }),
      ),
    ).not.toContain("stripe_charge_required");
  });

  // ── Gift already sourced from a DIFFERENT Stripe charge → block re-point ────
  it("gift already stripe-sourced from a different charge → gift_already_stripe_sourced", () => {
    expect(
      codes(
        baseInput({
          stripeCharge: { id: "c-new", stripePayoutId: "po1" },
          stagedPayoutIds: ["po1"],
          gift: {
            ...baseInput().gift,
            finalAmountSource: "stripe",
            finalAmountStripeChargeId: "c-old",
          },
        }),
      ),
    ).toContain("gift_already_stripe_sourced");
  });

  it("gift already stripe-sourced from the SAME charge → no re-point issue", () => {
    expect(
      codes(
        baseInput({
          stripeCharge: { id: "c1", stripePayoutId: "po1" },
          stagedPayoutIds: ["po1"],
          gift: {
            ...baseInput().gift,
            finalAmountSource: "stripe",
            finalAmountStripeChargeId: "c1",
          },
        }),
      ),
    ).not.toContain("gift_already_stripe_sourced");
  });

  it("gift sourced from human/QB → selecting a charge is allowed", () => {
    expect(
      codes(
        baseInput({
          stripeCharge: { id: "c1", stripePayoutId: "po1" },
          stagedPayoutIds: ["po1"],
          gift: {
            ...baseInput().gift,
            finalAmountSource: "quickbooks",
            finalAmountStripeChargeId: null,
          },
        }),
      ),
    ).not.toContain("gift_already_stripe_sourced");
  });
});
