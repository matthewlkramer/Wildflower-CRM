import { describe, expect, it } from "vitest";
import {
  decideSupersedeActions,
  type SupersedeQbRow,
} from "../lib/settlementSupersede";

/**
 * Pure-core coverage for the §4.3 settlement-supersede decision
 * (decideSupersedeActions): which QB ledger rows flip role given the current
 * facts — a confirmed settlement link, the per-gift counted Stripe sums booked
 * from the linked payout(s), and the fee-band same-money test.
 *
 * The DB apply half (locking, demote/promote writes, crumb cleanup, book-once
 * guard) is covered by settlement-supersede.integration.test.ts.
 */

const counted = (id: string, giftId: string, amount: string): SupersedeQbRow => ({
  id,
  giftId,
  amountApplied: amount,
  linkRole: "counted",
});
const corroborating = (
  id: string,
  giftId: string,
  amount: string | null,
): SupersedeQbRow => ({
  id,
  giftId,
  amountApplied: amount,
  linkRole: "corroborating",
});

describe("decideSupersedeActions", () => {
  it("demotes a counted QB row exactly covered by the payout's Stripe sum", () => {
    const d = decideSupersedeActions({
      hasConfirmedLink: true,
      rows: [counted("pa1", "g1", "1000.00")],
      stripeSumByGift: new Map([["g1", "1000.00"]]),
    });
    expect(d).toEqual([{ rowId: "pa1", giftId: "g1", action: "demote" }]);
  });

  it("demotes within the QB-only fee band (gross Stripe sum over a net QB lump)", () => {
    // QB row 1000.00 (net lump); Stripe counted sum 1030.00 (gross). Band:
    // g in [e−0.01, e*1.1+1] → 1030 ≤ 1101 → same money.
    const d = decideSupersedeActions({
      hasConfirmedLink: true,
      rows: [counted("pa1", "g1", "1000.00")],
      stripeSumByGift: new Map([["g1", "1030.00"]]),
    });
    expect(d).toEqual([{ rowId: "pa1", giftId: "g1", action: "demote" }]);
  });

  it("does NOT demote when the Stripe sum falls outside the fee band", () => {
    // Sum far above the band (not explainable by a processor fee) and sum
    // below the QB amount (partial coverage) both leave the row counted.
    for (const sum of ["1200.00", "500.00"]) {
      const d = decideSupersedeActions({
        hasConfirmedLink: true,
        rows: [counted("pa1", "g1", "1000.00")],
        stripeSumByGift: new Map([["g1", sum]]),
      });
      expect(d).toEqual([]);
    }
  });

  it("does NOT demote without a confirmed settlement link", () => {
    const d = decideSupersedeActions({
      hasConfirmedLink: false,
      rows: [counted("pa1", "g1", "1000.00")],
      stripeSumByGift: new Map([["g1", "1000.00"]]),
    });
    expect(d).toEqual([]);
  });

  it("does NOT demote on a zero or missing Stripe sum, or one for another gift", () => {
    for (const sums of [
      new Map<string, string>(),
      new Map([["g1", "0"]]),
      new Map([["gOther", "1000.00"]]),
    ]) {
      const d = decideSupersedeActions({
        hasConfirmedLink: true,
        rows: [counted("pa1", "g1", "1000.00")],
        stripeSumByGift: sums,
      });
      expect(d).toEqual([]);
    }
  });

  it("promotes a demoted (corroborating WITH amount) row once coverage disappears", () => {
    // Link reverted → hasConfirmedLink false → the demoted row's money trail
    // must come back.
    const d = decideSupersedeActions({
      hasConfirmedLink: false,
      rows: [corroborating("pa1", "g1", "1000.00")],
      stripeSumByGift: new Map(),
    });
    expect(d).toEqual([{ rowId: "pa1", giftId: "g1", action: "promote" }]);
  });

  it("promotes when the link stands but the Stripe rows were unbooked", () => {
    const d = decideSupersedeActions({
      hasConfirmedLink: true,
      rows: [corroborating("pa1", "g1", "1000.00")],
      stripeSumByGift: new Map(), // charge revert removed the counted sum
    });
    expect(d).toEqual([{ rowId: "pa1", giftId: "g1", action: "promote" }]);
  });

  it("keeps a covered demoted row demoted (idempotent re-run)", () => {
    const d = decideSupersedeActions({
      hasConfirmedLink: true,
      rows: [corroborating("pa1", "g1", "1000.00")],
      stripeSumByGift: new Map([["g1", "1030.00"]]),
    });
    expect(d).toEqual([]);
  });

  it("NEVER touches corrections-flow corroborating rows (NULL amount)", () => {
    // Regardless of link state or coverage, a NULL-amount corroborating row is
    // an audit-only annotation owned by the corrections flow.
    for (const hasConfirmedLink of [true, false]) {
      const d = decideSupersedeActions({
        hasConfirmedLink,
        rows: [corroborating("pa1", "g1", null)],
        stripeSumByGift: new Map([["g1", "1000.00"]]),
      });
      expect(d).toEqual([]);
    }
  });

  it("decides per row: mixed demote + promote across gifts in one pass", () => {
    const d = decideSupersedeActions({
      hasConfirmedLink: true,
      rows: [
        counted("pa1", "g1", "600.00"), // covered → demote
        corroborating("pa2", "g2", "400.00"), // no coverage → promote
        counted("pa3", "g3", "500.00"), // no coverage → stays
        corroborating("pa4", "g4", null), // corrections row → untouched
      ],
      stripeSumByGift: new Map([["g1", "600.00"]]),
    });
    expect(d).toEqual([
      { rowId: "pa1", giftId: "g1", action: "demote" },
      { rowId: "pa2", giftId: "g2", action: "promote" },
    ]);
  });
});
