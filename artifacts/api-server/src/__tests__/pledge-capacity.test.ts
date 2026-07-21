import { describe, expect, it } from "vitest";
import {
  pledgeCapacity,
  pledgeWrittenOffSumText,
} from "../lib/pledgeCapacity";

/**
 * Pins the CANONICAL pledge-capacity formula (pledgeCapacity.ts):
 *
 *   capacity = committed + writtenOff − paid, rounded to whole cents
 *
 * This is the single derivation behind the write-off dialog prefill, the
 * server-enforced write-off cap (computePledgeUncollectedRemainder), and the
 * pre-close checklist's underpaid-pledge remainder. If this test breaks, one
 * of those surfaces changed the money math — all of them must move together.
 */
describe("pledgeCapacity", () => {
  it("computes committed + writtenOff − paid", () => {
    expect(pledgeCapacity(1000, 0, 600)).toBe(400);
    expect(pledgeCapacity(1000, -100, 600)).toBe(300); // write-offs are negative
    expect(pledgeCapacity(500, 0, 500)).toBe(0);
  });

  it("is NOT clamped — a fully written-off / over-paid pledge goes ≤ 0", () => {
    expect(pledgeCapacity(1000, -400, 600)).toBe(0);
    expect(pledgeCapacity(500, 0, 700)).toBe(-200);
    expect(pledgeCapacity(1000, -500, 600)).toBe(-100);
  });

  it("rounds to whole cents (float noise from decimal sums must not leak)", () => {
    // 0.1 + 0.2 style float noise: 100.10 + (−0.00) − 99.90 = 0.20 exactly.
    expect(pledgeCapacity(100.1, 0, 99.9)).toBe(0.2);
    // Sub-cent noise rounds away, never truncates.
    expect(pledgeCapacity(10.005, 0, 0)).toBe(10.01);
    expect(pledgeCapacity(1000.004, 0, 0)).toBe(1000);
    // Three-bucket combination that produces a long float tail.
    expect(pledgeCapacity(1000.33, -100.11, 600.1)).toBe(300.12);
  });

  it("accepts numeric strings straight off SQL SUM()::text results", () => {
    expect(pledgeCapacity("1000.00", "-100.00", "600.33")).toBe(299.67);
    expect(pledgeCapacity("0", "0", "0")).toBe(0);
  });
});

describe("pledgeWrittenOffSumText", () => {
  it("embeds the caller alias quoted and keeps the archived-child exclusion", () => {
    const sqlText = pledgeWrittenOffSumText("o");
    expect(sqlText).toContain(`"write_off_of_pledge_id" = "o"."id"`);
    expect(sqlText).toContain(`"archived_at" IS NULL`);
    expect(sqlText).toMatch(/^COALESCE\(/);
  });

  it("rejects invalid and reserved aliases", () => {
    expect(() => pledgeWrittenOffSumText("o; DROP TABLE x")).toThrow();
    expect(() => pledgeWrittenOffSumText("O")).toThrow();
    expect(() => pledgeWrittenOffSumText("wo_ds")).toThrow(/reserved/);
    expect(() => pledgeWrittenOffSumText("wpa_ds")).toThrow(/reserved/);
  });
});
