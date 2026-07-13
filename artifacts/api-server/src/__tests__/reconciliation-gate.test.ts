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

  // ── Ready/gate parity: the reconciler card's ready hint counts gifts with the
  // STRICT band (this function's QB-only branch). A gift booked UNDER a QB check
  // must NOT read one-click ready even though the widened donor proposal pool may
  // still surface it. ──────────────────────────────────────────────────────────
  it("QB-only, $920 gift under a $1000 check → out of band (not ready; needs override)", () => {
    expect(amountWithinFeeBand("1000.00", "920.00")).toBe(false);
  });
  it("known net (Stripe charge), $104.00 gift behind a $104.42/$99.26 charge → within band (Ayeisha)", () => {
    // The charge pool's known-net band [99.25, 104.43] matches the under-gross
    // gift, so the card proposes it instead of a duplicate create-gift.
    expect(amountWithinFeeBand("104.42", "104.00", "99.26")).toBe(true);
  });

  // ── Net-aware window: a Stripe charge gives an EXACT gross + net, so the gift
  // is the same money ONLY inside [net, gross]. Once the net is known the legacy
  // heuristic band no longer applies. ─────────────────────────────────────────
  it("net known, gift == net (pure gross-vs-net gap) → within band", () => {
    // gross 100.00, net 96.80; a gift recorded at the bank net auto-resolves.
    expect(amountWithinFeeBand("100.00", "96.80", "96.80")).toBe(true);
  });
  it("net known, gift == gross → within band", () => {
    expect(amountWithinFeeBand("100.00", "100.00", "96.80")).toBe(true);
  });
  it("net known, gift between net and gross → within band", () => {
    expect(amountWithinFeeBand("100.00", "98.00", "96.80")).toBe(true);
  });
  it("net known, gift below the net → out of band (real discrepancy)", () => {
    expect(amountWithinFeeBand("100.00", "90.00", "96.80")).toBe(false);
  });
  it("net known, gift ABOVE the gross → out of band (a fee can never raise the amount)", () => {
    // 105 sits inside the legacy gross*1.1+$1 band but ABOVE gross 100 — no
    // longer auto-accepted now that the net pins the window; needs an override.
    expect(amountWithinFeeBand("100.00", "105.00", "96.80")).toBe(false);
  });
  it("net absent/invalid → falls back to the legacy heuristic band", () => {
    // Without a usable net, gross 105 still sits within net*1.1+$1 of 100.
    expect(amountWithinFeeBand("100.00", "105.00", null)).toBe(true);
    expect(amountWithinFeeBand("100.00", "105.00", "abc")).toBe(true);
  });
});

describe("runConsistencyGate", () => {
  it("consistent baseline → no issues", () => {
    expect(codes(baseInput())).toEqual([]);
  });

  it("missing QB anchor → qb_missing", () => {
    expect(codes(baseInput({ staged: null }))).toContain("qb_missing");
  });

  it("match_confirmed QB anchor → qb_not_pending", () => {
    expect(
      codes(baseInput({ staged: { id: "sp1", status: "match_confirmed" } })),
    ).toContain("qb_not_pending");
  });

  it("excluded QB anchor → qb_not_pending", () => {
    expect(
      codes(baseInput({ staged: { id: "sp1", status: "excluded" } })),
    ).toContain("qb_not_pending");
  });

  // A match_proposed row (an auto-applied match awaiting human review) is still
  // OPEN for reconciliation — approving IS the confirmation, so the gate must
  // not block it.
  it("match_proposed QB anchor → no qb_not_pending (still open for reconciliation)", () => {
    expect(
      codes(baseInput({ staged: { id: "sp1", status: "match_proposed" } })),
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

  it("net known, pure gross-vs-net gap (gift at net) → no amount_out_of_band", () => {
    expect(
      codes(
        baseInput({
          evidenceAmount: "100.00",
          evidenceNetAmount: "96.80",
          gift: { ...baseInput().gift, amount: "96.80" },
        }),
      ),
    ).not.toContain("amount_out_of_band");
  });

  it("net known, gift ABOVE gross → amount_out_of_band (real discrepancy needs override)", () => {
    expect(
      codes(
        baseInput({
          evidenceAmount: "100.00",
          evidenceNetAmount: "96.80",
          gift: { ...baseInput().gift, amount: "105.00" },
        }),
      ),
    ).toContain("amount_out_of_band");
  });

  it("net known, gift above gross WITH override reason → waived", () => {
    expect(
      codes(
        baseInput({
          evidenceAmount: "100.00",
          evidenceNetAmount: "96.80",
          gift: { ...baseInput().gift, amount: "105.00" },
          overrideAmountMismatchReason: "Donor added a tip on top of the charge",
        }),
      ),
    ).not.toContain("amount_out_of_band");
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

  it("switchStripeSource confirmed → re-point allowed (no block)", () => {
    expect(
      codes(
        baseInput({
          stripeCharge: { id: "c-new", stripePayoutId: "po1" },
          stagedPayoutIds: ["po1"],
          switchStripeSource: true,
          gift: {
            ...baseInput().gift,
            finalAmountSource: "stripe",
            finalAmountStripeChargeId: "c-old",
          },
        }),
      ),
    ).not.toContain("gift_already_stripe_sourced");
  });

  it("gift_already_stripe_sourced issue carries the current charge details", () => {
    const issues = runConsistencyGate(
      baseInput({
        stripeCharge: { id: "c-new", stripePayoutId: "po1" },
        stagedPayoutIds: ["po1"],
        currentStripeChargeDetails: {
          id: "c-old",
          amount: "100.00",
          payerName: "Jane Donor",
          date: "2026-01-15",
        },
        gift: {
          ...baseInput().gift,
          finalAmountSource: "stripe",
          finalAmountStripeChargeId: "c-old",
        },
      }),
    );
    const issue = issues.find((i) => i.code === "gift_already_stripe_sourced");
    expect(issue?.details?.currentStripeCharge?.id).toBe("c-old");
    expect(issue?.details?.currentStripeCharge?.payerName).toBe("Jane Donor");
    expect(issue?.details?.targetStripeChargeId).toBe("c-new");
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

  it("gift already QB-linked to a different staged payment → gift_already_qb_linked", () => {
    expect(
      codes(
        baseInput({
          qbLinkedPaymentId: "sp-old",
        }),
      ),
    ).toContain("gift_already_qb_linked");
  });

  it("no incumbent QB payment → no gift_already_qb_linked", () => {
    expect(codes(baseInput({ qbLinkedPaymentId: null }))).not.toContain(
      "gift_already_qb_linked",
    );
  });

  it("displaceLinkedPayment confirmed → displacement allowed (no block)", () => {
    expect(
      codes(
        baseInput({
          qbLinkedPaymentId: "sp-old",
          displaceLinkedPayment: true,
        }),
      ),
    ).not.toContain("gift_already_qb_linked");
  });

  it("gift_already_qb_linked issue carries the incumbent payment + target details", () => {
    const issues = runConsistencyGate(
      baseInput({
        qbLinkedPaymentId: "sp-old",
        currentQbPaymentDetails: {
          id: "sp-old",
          amount: "100.00",
          payerName: "Jane Donor",
          date: "2026-01-15",
        },
      }),
    );
    const issue = issues.find((i) => i.code === "gift_already_qb_linked");
    expect(issue?.details?.currentQbPayment?.id).toBe("sp-old");
    expect(issue?.details?.currentQbPayment?.payerName).toBe("Jane Donor");
    // baseInput's anchor is "sp1" — the payment being approved.
    expect(issue?.details?.targetStagedPaymentId).toBe("sp1");
  });

  it("composes with stripe re-source: both conflicts surface together, both flags clear both", () => {
    const conflicting = baseInput({
      stripeCharge: { id: "c-new", stripePayoutId: "po1" },
      stagedPayoutIds: ["po1"],
      qbLinkedPaymentId: "sp-old",
      gift: {
        ...baseInput().gift,
        finalAmountSource: "stripe",
        finalAmountStripeChargeId: "c-old",
      },
    });
    const both = codes(conflicting);
    expect(both).toContain("gift_already_stripe_sourced");
    expect(both).toContain("gift_already_qb_linked");
    // Both confirmation flags together clear both issues in one pass.
    const cleared = codes({
      ...conflicting,
      switchStripeSource: true,
      displaceLinkedPayment: true,
    });
    expect(cleared).not.toContain("gift_already_stripe_sourced");
    expect(cleared).not.toContain("gift_already_qb_linked");
  });

  it("anchor payment already applied to a DIFFERENT gift → payment_already_applied", () => {
    expect(
      codes(baseInput({ ownAppliedGiftId: "g-other" })),
    ).toContain("payment_already_applied");
  });

  it("no own application → no payment_already_applied", () => {
    expect(codes(baseInput())).not.toContain("payment_already_applied");
  });

  it("moveOwnApplication confirmed → own-application move allowed (no block)", () => {
    expect(
      codes(
        baseInput({ ownAppliedGiftId: "g-other", moveOwnApplication: true }),
      ),
    ).not.toContain("payment_already_applied");
  });

  it("payment_already_applied issue carries the current applied gift + target details", () => {
    const issues = runConsistencyGate(
      baseInput({
        ownAppliedGiftId: "g-other",
        currentAppliedGiftDetails: {
          id: "g-other",
          name: "Rue Foundation gift",
          amount: "156.48",
          date: "2026-05-01",
        },
      }),
    );
    const issue = issues.find((i) => i.code === "payment_already_applied");
    expect(issue?.details?.currentAppliedGift?.id).toBe("g-other");
    expect(issue?.details?.currentAppliedGift?.name).toBe("Rue Foundation gift");
    expect(issue?.details?.currentAppliedGift?.amount).toBe("156.48");
    expect(issue?.details?.targetGiftId).toBe("g1");
  });
});
