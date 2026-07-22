import { describe, expect, it } from "vitest";
import {
  assignChargeQbTies,
  assignCombinedChargeQbTies,
  assignManualChargeQbTies,
  combinedSubsetSumAmounts,
  nameSimilarity,
  nameTokens,
  pairChargeFeeRows,
  CHARGE_TIE_WINDOW_DAYS,
  COMBINED_TIE_MAX_CHARGES,
  NAME_SIM_THRESHOLD,
  type ChargeForTie,
  type FeeChargeInput,
  type FeeRowInput,
  type QbRowForTie,
} from "../lib/chargeQbTie";

function charge(
  id: string,
  grossAmount: string | null,
  dateReceived: string | null,
  payerName: string | null = null,
  description: string | null = null,
  netAmount: string | null = null,
): ChargeForTie {
  return { id, grossAmount, netAmount, dateReceived, payerName, description };
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

  it("matches a NET-booked QB row exactly (bookkeeper booked post-fee)", () => {
    // $600 gross / $584.70 net — QB row records the net bank deposit.
    const out = assignChargeQbTies(
      [charge("c1", "600.00", "2026-01-10", "Allen Vasan", null, "584.70")],
      [qb("q1", "584.70", "2026-01-12", "Allen Vasan")],
    );
    expect(out.get("c1")).toBe("q1");
  });

  it("still requires NET to match exactly to the cent", () => {
    const out = assignChargeQbTies(
      [charge("c1", "600.00", "2026-01-10", null, null, "584.70")],
      [qb("q1", "584.71", "2026-01-12")],
    );
    expect(out.size).toBe(0);
  });

  it("prefers the GROSS row when both a gross and a net row fit", () => {
    const out = assignChargeQbTies(
      [charge("c1", "100.00", "2026-01-10", "Alice Jones", null, "95.05")],
      [
        qb("qNet", "95.05", "2026-01-10", "Alice Jones"),
        qb("qGross", "100.00", "2026-01-10", "Alice Jones"),
      ],
    );
    expect(out.get("c1")).toBe("qGross");
    expect(out.size).toBe(1);
  });

  it("a row equal to one charge's NET and another's GROSS is ambiguous — name similarity required", () => {
    // q1 = c1's net AND c2's gross → 2 eligible charges at 95.05; no names →
    // nothing assigns on amount alone.
    const out = assignChargeQbTies(
      [
        charge("c1", "100.00", "2026-01-10", null, null, "95.05"),
        charge("c2", "95.05", "2026-01-10"),
      ],
      [qb("q1", "95.05", "2026-01-11")],
    );
    expect(out.size).toBe(0);
  });

  it("disambiguates the cross gross/net collision by payer name", () => {
    const out = assignChargeQbTies(
      [
        charge("c1", "100.00", "2026-01-10", "Hilary Beard", null, "95.05"),
        charge("c2", "95.05", "2026-01-10", "John Smith"),
      ],
      [qb("q1", "95.05", "2026-01-11", "Smith, John")],
    );
    expect(out.get("c2")).toBe("q1");
    expect(out.has("c1")).toBe(false);
  });

  it("zero-fee charge (net == gross) registers once and matches normally", () => {
    const out = assignChargeQbTies(
      [charge("c1", "50.00", "2026-01-10", null, null, "50.00")],
      [qb("q1", "50.00", "2026-01-10")],
    );
    expect(out.get("c1")).toBe("q1");
    expect(out.size).toBe(1);
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

  it("places a row matching a charge's NET amount", () => {
    const { assigned, issues } = assignManualChargeQbTies(
      [charge("c1", "600.00", "2026-01-10", null, null, "584.70")],
      [qb("q1", "584.70", "2026-01-15")],
    );
    expect(issues).toEqual([]);
    expect(assigned.get("c1")).toBe("q1");
  });

  it("a charge is placed at most once even though it registers under gross AND net", () => {
    // Two rows both fit c1 (one = gross, one = net) — only one may land; the
    // other is an issue (a charge is booked once).
    const { assigned, issues } = assignManualChargeQbTies(
      [charge("c1", "100.00", "2026-01-10", null, null, "95.05")],
      [qb("q1", "100.00", "2026-01-10"), qb("q2", "95.05", "2026-01-10")],
    );
    expect(assigned.size).toBe(1);
    expect(assigned.get("c1")).toBe("q1"); // gross fit wins
    expect(issues).toHaveLength(1);
    expect(issues[0]!.qbStagedPaymentId).toBe("q2");
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

// ── Combined-booked proposer (subset-sum) ───────────────────────────────────

describe("combinedSubsetSumAmounts", () => {
  it("enumerates every size-≥2 subset sum on the gross basis", () => {
    const out = combinedSubsetSumAmounts([
      charge("c1", "100.00", "2026-01-10"),
      charge("c2", "200.00", "2026-01-10"),
      charge("c3", "50.00", "2026-01-10"),
    ]);
    // Pairs: 300, 150, 250; triple: 350. NO singles (150/250/300/350 only).
    expect(out).toEqual(["150.00", "250.00", "300.00", "350.00"]);
  });

  it("includes net-basis sums as separate candidates", () => {
    const out = combinedSubsetSumAmounts([
      charge("c1", "100.00", "2026-01-10", null, null, "97.00"),
      charge("c2", "50.00", "2026-01-10", null, null, "48.50"),
    ]);
    expect(out).toContain("150.00"); // gross+gross
    expect(out).toContain("145.50"); // net+net
    // Mixed bases are NOT enumerated (100 + 48.50 / 97 + 50).
    expect(out).not.toContain("148.50");
    expect(out).not.toContain("147.00");
  });

  it("skips charges with no usable amount and dedupes equal sums", () => {
    const out = combinedSubsetSumAmounts([
      charge("c1", "25.00", "2026-01-10", null, null, "25.00"),
      charge("c2", "25.00", "2026-01-10", null, null, "25.00"),
      charge("c3", null, "2026-01-10"),
    ]);
    expect(out).toEqual(["50.00"]); // gross pair == net pair, deduped
  });

  it("caps the enumeration at COMBINED_TIE_MAX_CHARGES", () => {
    const many = Array.from({ length: COMBINED_TIE_MAX_CHARGES + 4 }, (_, i) =>
      charge(`c${i}`, "10.00", "2026-01-10"),
    );
    const out = combinedSubsetSumAmounts(many);
    // Largest possible sum uses only the first 8 charges: 8 × $10.
    expect(out[out.length - 1]).toBe("80.00");
  });
});

describe("assignCombinedChargeQbTies (combined-booked proposer)", () => {
  it("proposes the unique pair whose gross sum equals the row amount", () => {
    // The Fisher+Devon shape: 4794.70 + 496.38 booked as one 5291.08 row.
    const out = assignCombinedChargeQbTies(
      [
        charge("c1", "4794.70", "2026-01-10"),
        charge("c2", "496.38", "2026-01-10"),
      ],
      [qb("q1", "5291.08", "2026-01-12")],
    );
    expect(out.get("c1")).toBe("q1");
    expect(out.get("c2")).toBe("q1");
    expect(out.size).toBe(2);
  });

  it("proposes on the net basis when the bookkeeper booked post-fee", () => {
    const out = assignCombinedChargeQbTies(
      [
        charge("c1", "100.00", "2026-01-10", null, null, "97.00"),
        charge("c2", "50.00", "2026-01-10", null, null, "48.50"),
      ],
      [qb("q1", "145.50", "2026-01-12")],
    );
    expect(out.get("c1")).toBe("q1");
    expect(out.get("c2")).toBe("q1");
  });

  it("never mixes bases inside one subset", () => {
    // gross(c1) + net(c2) = 148.50 — must NOT propose.
    const out = assignCombinedChargeQbTies(
      [
        charge("c1", "100.00", "2026-01-10", null, null, "97.00"),
        charge("c2", "50.00", "2026-01-10", null, null, "48.50"),
      ],
      [qb("q1", "148.50", "2026-01-12")],
    );
    expect(out.size).toBe(0);
  });

  it("skips a row explained by TWO different subsets (ambiguous membership)", () => {
    // {10+20} and {12+18} both sum to 30 — two explanations, no proposal.
    const out = assignCombinedChargeQbTies(
      [
        charge("c1", "10.00", "2026-01-10"),
        charge("c2", "20.00", "2026-01-10"),
        charge("c3", "12.00", "2026-01-10"),
        charge("c4", "18.00", "2026-01-10"),
      ],
      [qb("q1", "30.00", "2026-01-11")],
    );
    expect(out.size).toBe(0);
  });

  it("gross and net subsets with IDENTICAL members are one explanation", () => {
    // Zero-fee charges: gross == net, so both bases find the same pair.
    const out = assignCombinedChargeQbTies(
      [
        charge("c1", "25.00", "2026-01-10", null, null, "25.00"),
        charge("c2", "35.00", "2026-01-10", null, null, "35.00"),
      ],
      [qb("q1", "60.00", "2026-01-11")],
    );
    expect(out.get("c1")).toBe("q1");
    expect(out.get("c2")).toBe("q1");
  });

  it("defers to the 1:1 pass when the row also equals a SINGLE charge", () => {
    // q1=30 equals c3's gross alone — 1:1 territory (name rules apply there),
    // even though {c1,c2} also sums to 30.
    const out = assignCombinedChargeQbTies(
      [
        charge("c1", "10.00", "2026-01-10"),
        charge("c2", "20.00", "2026-01-10"),
        charge("c3", "30.00", "2026-01-10"),
      ],
      [qb("q1", "30.00", "2026-01-11")],
    );
    expect(out.size).toBe(0);
  });

  it("excludes charges outside the date window from subsets", () => {
    const out = assignCombinedChargeQbTies(
      [
        charge("c1", "10.00", "2026-01-10"),
        charge("c2", "20.00", "2026-01-10"),
        charge("c3", "5.00", "2025-06-01"), // far outside the window
      ],
      [qb("q1", "30.00", "2026-01-11")],
    );
    expect(out.get("c1")).toBe("q1");
    expect(out.get("c2")).toBe("q1");
    expect(out.has("c3")).toBe(false);
  });

  it("a charge joins at most ONE combined group (stable candidate order)", () => {
    // Both rows could be explained by the same pair; the smaller row id wins.
    const out = assignCombinedChargeQbTies(
      [
        charge("c1", "10.00", "2026-01-10"),
        charge("c2", "20.00", "2026-01-10"),
      ],
      [qb("q2", "30.00", "2026-01-11"), qb("q1", "30.00", "2026-01-12")],
    );
    expect(out.get("c1")).toBe("q1");
    expect(out.get("c2")).toBe("q1");
    expect(out.size).toBe(2);
  });

  it("returns nothing for fewer than 2 or more than the cap of charges", () => {
    expect(
      assignCombinedChargeQbTies(
        [charge("c1", "10.00", "2026-01-10")],
        [qb("q1", "10.00", "2026-01-10")],
      ).size,
    ).toBe(0);
    const many = Array.from(
      { length: COMBINED_TIE_MAX_CHARGES + 1 },
      (_, i) => charge(`c${i}`, "10.00", "2026-01-10"),
    );
    expect(
      assignCombinedChargeQbTies(many, [qb("q1", "20.00", "2026-01-10")]).size,
    ).toBe(0);
  });

  it("ignores negative or zero-amount candidate rows", () => {
    const out = assignCombinedChargeQbTies(
      [
        charge("c1", "10.00", "2026-01-10"),
        charge("c2", "20.00", "2026-01-10"),
      ],
      [qb("q1", "-30.00", "2026-01-11"), qb("q2", "0.00", "2026-01-11")],
    );
    expect(out.size).toBe(0);
  });
});

// ── Sibling "Stripe fee" row pairing (confirm-time claim + 0127 backfill) ──

function feeCharge(
  chargeId: string,
  depositKey: string,
  feeCents: number,
): FeeChargeInput {
  return { chargeId, depositKey, feeCents };
}

function feeRow(
  id: string,
  depositKey: string,
  feeCents: number,
  qbLineId = "",
): FeeRowInput {
  return { id, depositKey, feeCents, qbLineId };
}

describe("pairChargeFeeRows (sibling Stripe-fee claim)", () => {
  it("pairs a single charge with the single exact-fee row of its deposit", () => {
    const out = pairChargeFeeRows(
      [feeCharge("c1", "dep1", 1311)],
      [feeRow("f1", "dep1", 1311)],
    );
    expect(out.size).toBe(1);
    expect(out.get("c1")).toBe("f1");
  });

  it("requires the deposit to match — same fee amount in another deposit is ignored", () => {
    const out = pairChargeFeeRows(
      [feeCharge("c1", "dep1", 1311)],
      [feeRow("f1", "dep2", 1311)],
    );
    expect(out.size).toBe(0);
  });

  it("requires the fee to match to the cent", () => {
    const out = pairChargeFeeRows(
      [feeCharge("c1", "dep1", 1311)],
      [feeRow("f1", "dep1", 1312)],
    );
    expect(out.size).toBe(0);
  });

  it("equal-fee twins pair rank-to-rank (charge id order × qbLineId order)", () => {
    // Two $500 donations in one deposit, each with a −$13.11 fee line.
    const out = pairChargeFeeRows(
      [feeCharge("c2", "dep1", 1311), feeCharge("c1", "dep1", 1311)],
      [feeRow("f9", "dep1", 1311, "2"), feeRow("f5", "dep1", 1311, "1")],
    );
    expect(out.size).toBe(2);
    expect(out.get("c1")).toBe("f5"); // 1st charge (id order) ↔ 1st row (line order)
    expect(out.get("c2")).toBe("f9");
    // A fee row is never claimed twice.
    expect(new Set(out.values()).size).toBe(2);
  });

  it("more charges than rows: only the leading ranks pair; rest stay unclaimed", () => {
    const out = pairChargeFeeRows(
      [
        feeCharge("c1", "dep1", 1311),
        feeCharge("c2", "dep1", 1311),
        feeCharge("c3", "dep1", 1311),
      ],
      [feeRow("f1", "dep1", 1311, "1")],
    );
    expect(out.size).toBe(1);
    expect(out.get("c1")).toBe("f1");
  });

  it("more rows than charges: surplus rows stay unclaimed", () => {
    const out = pairChargeFeeRows(
      [feeCharge("c1", "dep1", 1311)],
      [feeRow("f1", "dep1", 1311, "1"), feeRow("f2", "dep1", 1311, "2")],
    );
    expect(out.size).toBe(1);
    expect(out.get("c1")).toBe("f1");
  });

  it("mixed deposits and fee amounts partition independently", () => {
    const out = pairChargeFeeRows(
      [
        feeCharge("c1", "dep1", 1311),
        feeCharge("c2", "dep1", 725),
        feeCharge("c3", "dep2", 1311),
      ],
      [
        feeRow("f1", "dep1", 725),
        feeRow("f2", "dep2", 1311),
        feeRow("f3", "dep1", 1311),
      ],
    );
    expect(out.size).toBe(3);
    expect(out.get("c1")).toBe("f3");
    expect(out.get("c2")).toBe("f1");
    expect(out.get("c3")).toBe("f2");
  });

  it("is deterministic: shuffled input order yields the same pairing", () => {
    const charges = [
      feeCharge("c2", "dep1", 1311),
      feeCharge("c1", "dep1", 1311),
    ];
    const rows = [
      feeRow("f2", "dep1", 1311, "2"),
      feeRow("f1", "dep1", 1311, "1"),
    ];
    const a = pairChargeFeeRows(charges, rows);
    const b = pairChargeFeeRows([...charges].reverse(), [...rows].reverse());
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it("qbLineId ties break by row id", () => {
    const out = pairChargeFeeRows(
      [feeCharge("c1", "dep1", 1311), feeCharge("c2", "dep1", 1311)],
      [feeRow("fB", "dep1", 1311, "1"), feeRow("fA", "dep1", 1311, "1")],
    );
    expect(out.get("c1")).toBe("fA");
    expect(out.get("c2")).toBe("fB");
  });

  it("empty inputs are a no-op", () => {
    expect(pairChargeFeeRows([], []).size).toBe(0);
    expect(pairChargeFeeRows([feeCharge("c1", "d", 1)], []).size).toBe(0);
    expect(pairChargeFeeRows([], [feeRow("f1", "d", 1)]).size).toBe(0);
  });
});
