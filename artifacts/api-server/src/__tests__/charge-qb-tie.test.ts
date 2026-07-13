import { describe, expect, it } from "vitest";
import {
  assignChargeQbTies,
  assignManualChargeQbTies,
  nameSimilarity,
  nameTokens,
  CHARGE_TIE_WINDOW_DAYS,
  NAME_SIM_THRESHOLD,
  type ChargeForTie,
  type QbRowForTie,
} from "../lib/chargeQbTie";

function charge(
  id: string,
  grossAmount: string | null,
  dateReceived: string | null,
  payerName: string | null = null,
  description: string | null = null,
): ChargeForTie {
  return { id, grossAmount, dateReceived, payerName, description };
}

function qb(
  id: string,
  amount: string | null,
  dateReceived: string | null,
  payerName: string | null = null,
): QbRowForTie {
  return { id, amount, dateReceived, payerName };
}

describe("nameTokens / nameSimilarity", () => {
  it("tokenizes ignoring punctuation and case", () => {
    expect([...nameTokens("Beard, Hilary")].sort()).toEqual([
      "beard",
      "hilary",
    ]);
  });

  it("is word-order insensitive: 'Beard, Hilary' ≈ 'Hilary Beard'", () => {
    expect(nameSimilarity("Beard, Hilary", "Hilary Beard")).toBe(1);
  });

  it("partial overlap scores between 0 and 1", () => {
    const s = nameSimilarity("Hilary Beard", "Hilary Smith");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it("empty / null names score 0", () => {
    expect(nameSimilarity(null, "Someone")).toBe(0);
    expect(nameSimilarity("Someone", "")).toBe(0);
    expect(nameSimilarity(null, null)).toBe(0);
  });
});

describe("assignChargeQbTies (proposal pass)", () => {
  it("assigns an unambiguous 1×1 amount group on amount + window alone", () => {
    const out = assignChargeQbTies(
      [charge("c1", "100.00", "2026-01-10")],
      [qb("q1", "100.00", "2026-01-12")],
    );
    expect(out.get("c1")).toBe("q1");
  });

  it("requires EXACT amount to the cent", () => {
    const out = assignChargeQbTies(
      [charge("c1", "100.00", "2026-01-10")],
      [qb("q1", "100.01", "2026-01-10")],
    );
    expect(out.size).toBe(0);
  });

  it("rejects candidates outside the date window", () => {
    const out = assignChargeQbTies(
      [charge("c1", "100.00", "2026-01-10")],
      [qb("q1", "100.00", "2026-03-01")],
    );
    expect(out.size).toBe(0);
  });

  it("accepts a candidate exactly at the window edge", () => {
    const edge = `2026-01-${String(10 + CHARGE_TIE_WINDOW_DAYS).padStart(2, "0")}`;
    const out = assignChargeQbTies(
      [charge("c1", "50.00", "2026-01-10")],
      [qb("q1", "50.00", edge)],
    );
    expect(out.get("c1")).toBe("q1");
  });

  it("NEVER assigns on amount alone when several same-amount pairs compete", () => {
    // Two charges, two candidates, all $25 — but no payer names anywhere, so
    // similarity is 0 < threshold and nothing may be assigned.
    const out = assignChargeQbTies(
      [
        charge("c1", "25.00", "2026-01-10"),
        charge("c2", "25.00", "2026-01-11"),
      ],
      [qb("q1", "25.00", "2026-01-10"), qb("q2", "25.00", "2026-01-11")],
    );
    expect(out.size).toBe(0);
  });

  it("disambiguates an ambiguous group by payer-name similarity", () => {
    const out = assignChargeQbTies(
      [
        charge("c1", "25.00", "2026-01-10", "Hilary Beard"),
        charge("c2", "25.00", "2026-01-10", "John Smith"),
      ],
      [
        qb("q1", "25.00", "2026-01-11", "Smith, John"),
        qb("q2", "25.00", "2026-01-11", "Beard, Hilary"),
      ],
    );
    expect(out.get("c1")).toBe("q2");
    expect(out.get("c2")).toBe("q1");
  });

  it("in an ambiguous group, assigns only the pairs that clear the threshold", () => {
    const out = assignChargeQbTies(
      [
        charge("c1", "25.00", "2026-01-10", "Hilary Beard"),
        charge("c2", "25.00", "2026-01-10", "Anonymous Donor"),
      ],
      [
        qb("q1", "25.00", "2026-01-11", "Beard, Hilary"),
        qb("q2", "25.00", "2026-01-11", "Completely Different"),
      ],
    );
    expect(out.get("c1")).toBe("q1");
    expect(out.has("c2")).toBe(false);
  });

  it("falls back to charge.description when payerName is null", () => {
    const out = assignChargeQbTies(
      [
        charge("c1", "25.00", "2026-01-10", null, "Donation from Hilary Beard"),
        charge("c2", "25.00", "2026-01-10", null, "Donation from John Smith"),
      ],
      [
        qb("q1", "25.00", "2026-01-10", "Beard, Hilary"),
        qb("q2", "25.00", "2026-01-10", "Smith, John"),
      ],
    );
    expect(out.get("c1")).toBe("q1");
    expect(out.get("c2")).toBe("q2");
  });

  it("one QB row is assigned to at most one charge", () => {
    const out = assignChargeQbTies(
      [
        charge("c1", "10.00", "2026-01-10", "Alice Jones"),
        charge("c2", "10.00", "2026-01-10", "Alice Jones"),
      ],
      [qb("q1", "10.00", "2026-01-10", "Alice Jones")],
    );
    const values = [...out.values()];
    expect(values).toEqual(["q1"]);
    expect(out.size).toBe(1);
  });

  it("skips charges/candidates with missing amount or date", () => {
    const out = assignChargeQbTies(
      [
        charge("c1", null, "2026-01-10"),
        charge("c2", "10.00", null),
        charge("c3", "10.00", "2026-01-10"),
      ],
      [qb("q1", "10.00", "2026-01-10"), qb("q2", null, "2026-01-10")],
    );
    expect(out.get("c3")).toBe("q1");
    expect(out.size).toBe(1);
  });

  it("never proposes a DISMISSED charge↔QB pair, but the QB row stays available for other charges", () => {
    // c1 dismissed q1: even though it's the only exact-amount candidate for
    // c1, nothing may be proposed there. c2 (no dismissal) still gets q1.
    const c1 = {
      ...charge("c1", "40.00", "2026-01-10", "Alice Jones"),
      dismissedQbIds: ["q1"],
    };
    const solo = assignChargeQbTies([c1], [qb("q1", "40.00", "2026-01-10", "Alice Jones")]);
    expect(solo.size).toBe(0);

    const c2 = charge("c2", "40.00", "2026-01-10", "Alice Jones");
    const both = assignChargeQbTies(
      [c1, c2],
      [qb("q1", "40.00", "2026-01-10", "Alice Jones")],
    );
    expect(both.get("c2")).toBe("q1");
    expect(both.has("c1")).toBe(false);
  });

  it("a dismissal only blocks the exact pair — other candidates still propose", () => {
    const c1 = {
      ...charge("c1", "41.00", "2026-01-10", "Alice Jones"),
      dismissedQbIds: ["q1"],
    };
    const out = assignChargeQbTies(
      [c1],
      [
        qb("q1", "41.00", "2026-01-10", "Alice Jones"),
        qb("q2", "41.00", "2026-01-11", "Alice Jones"),
      ],
    );
    expect(out.get("c1")).toBe("q2");
  });

  it("is deterministic on equal-evidence ties (stable id ordering)", () => {
    const run = () =>
      assignChargeQbTies(
        [charge("c1", "25.00", "2026-01-10", "Alice Jones")],
        [
          qb("q2", "25.00", "2026-01-10", "Alice Jones"),
          qb("q1", "25.00", "2026-01-10", "Alice Jones"),
        ],
      );
    const a = run();
    const b = run();
    expect(a.get("c1")).toBe("q1"); // smaller qbId wins the tie
    expect(b.get("c1")).toBe("q1");
  });
});

describe("assignManualChargeQbTies (Tie selected)", () => {
  it("IGNORES dismissals — an explicit human tie overrides a prior reject", () => {
    const c1 = {
      ...charge("c1", "100.00", "2026-01-10"),
      dismissedQbIds: ["q1"],
    };
    const { assigned, issues } = assignManualChargeQbTies(
      [c1],
      [qb("q1", "100.00", "2026-01-10")],
    );
    expect(issues).toEqual([]);
    expect(assigned.get("c1")).toBe("q1");
  });

  it("places every row on an exact-amount charge, ignoring the date window", () => {
    const { assigned, issues } = assignManualChargeQbTies(
      [charge("c1", "100.00", "2026-01-10")],
      // Way outside the propose window — human asserted the tie, so it places.
      [qb("q1", "100.00", "2025-06-01")],
    );
    expect(issues).toEqual([]);
    expect(assigned.get("c1")).toBe("q1");
  });

  it("does NOT require name similarity, but uses it to order ambiguous placements", () => {
    const { assigned, issues } = assignManualChargeQbTies(
      [
        charge("c1", "25.00", "2026-01-10", "Hilary Beard"),
        charge("c2", "25.00", "2026-01-10", "John Smith"),
      ],
      [
        qb("q1", "25.00", "2026-01-11", "Smith, John"),
        qb("q2", "25.00", "2026-01-11", "Totally Unrelated"),
      ],
    );
    expect(issues).toEqual([]);
    // q1 pairs with the similar-name charge; q2 takes the remaining one even
    // though its name matches nothing.
    expect(assigned.get("c2")).toBe("q1");
    expect(assigned.get("c1")).toBe("q2");
  });

  it("reports an issue when a row's amount fits no charge", () => {
    const { assigned, issues } = assignManualChargeQbTies(
      [charge("c1", "100.00", "2026-01-10")],
      [qb("q1", "50.00", "2026-01-10")],
    );
    expect(assigned.size).toBe(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.qbStagedPaymentId).toBe("q1");
    expect(issues[0]!.reason).toMatch(/exact amount/i);
  });

  it("reports an issue when more rows than same-amount charges", () => {
    const { assigned, issues } = assignManualChargeQbTies(
      [charge("c1", "25.00", "2026-01-10")],
      [qb("q1", "25.00", "2026-01-10"), qb("q2", "25.00", "2026-01-11")],
    );
    expect(assigned.size).toBe(1);
    expect(issues).toHaveLength(1);
  });

  it("reports an issue for a row with no amount", () => {
    const { assigned, issues } = assignManualChargeQbTies(
      [charge("c1", "25.00", "2026-01-10")],
      [qb("q1", null, "2026-01-10")],
    );
    expect(assigned.size).toBe(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.reason).toMatch(/no amount/i);
  });

  it("threshold sanity: NAME_SIM_THRESHOLD blocks propose but not manual", () => {
    const chargesArr = [
      charge("c1", "25.00", "2026-01-10", "AAA"),
      charge("c2", "25.00", "2026-01-10", "BBB"),
    ];
    const rowsArr = [
      qb("q1", "25.00", "2026-01-10", "CCC"),
      qb("q2", "25.00", "2026-01-10", "DDD"),
    ];
    // Propose: ambiguous + zero similarity (< threshold) → nothing.
    expect(NAME_SIM_THRESHOLD).toBeGreaterThan(0);
    expect(assignChargeQbTies(chargesArr, rowsArr).size).toBe(0);
    // Manual: human asserted it → both place.
    const manual = assignManualChargeQbTies(chargesArr, rowsArr);
    expect(manual.issues).toEqual([]);
    expect(manual.assigned.size).toBe(2);
  });
});
