import { describe, it, expect } from "vitest";
import {
  fiscalYearSlugForDate,
  assertGiftHasAllocations,
} from "../lib/giftAllocationSeed";
import type { Tx } from "../lib/reconciliationCommit";

describe("fiscalYearSlugForDate", () => {
  it("maps Jul–Dec to NEXT year's FY (named by ending year)", () => {
    expect(fiscalYearSlugForDate("2025-07-01")).toBe("fy2026");
    expect(fiscalYearSlugForDate("2025-11-17")).toBe("fy2026");
    expect(fiscalYearSlugForDate("2024-12-31")).toBe("fy2025");
  });

  it("maps Jan–Jun to the SAME calendar year's FY", () => {
    expect(fiscalYearSlugForDate("2026-03-25")).toBe("fy2026");
    expect(fiscalYearSlugForDate("2025-06-30")).toBe("fy2025");
    expect(fiscalYearSlugForDate("2024-01-01")).toBe("fy2024");
  });

  it("tolerates a trailing time component (ISO timestamp)", () => {
    expect(fiscalYearSlugForDate("2025-08-15T12:34:56Z")).toBe("fy2026");
  });

  it("returns null for missing / unparseable / out-of-range input", () => {
    expect(fiscalYearSlugForDate(null)).toBeNull();
    expect(fiscalYearSlugForDate(undefined)).toBeNull();
    expect(fiscalYearSlugForDate("")).toBeNull();
    expect(fiscalYearSlugForDate("garbage")).toBeNull();
    expect(fiscalYearSlugForDate("2026-13-40")).toBeNull();
  });
});

// Minimal drizzle-select mock: assertGiftHasAllocations only calls
// tx.select({...}).from(...).where(...) and awaits the [{ n }] result.
function mockTx(count: number): Tx {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ n: count }]),
      }),
    }),
  } as unknown as Tx;
}

describe("assertGiftHasAllocations (zero-allocation backstop)", () => {
  it("throws when a gift would be committed with zero allocations", async () => {
    await expect(assertGiftHasAllocations(mockTx(0), "gift_x")).rejects.toThrow(
      /zero allocations/,
    );
  });

  it("passes when the gift has one or more allocations", async () => {
    await expect(
      assertGiftHasAllocations(mockTx(1), "gift_x"),
    ).resolves.toBeUndefined();
    await expect(
      assertGiftHasAllocations(mockTx(3), "gift_x"),
    ).resolves.toBeUndefined();
  });
});
