import { describe, it, expect } from "vitest";
import {
  deriveSettlementLinkFields,
  type SettlementLinkFields,
} from "../lib/settlementLink";
import {
  reverseSettlementLink,
  proposeSettlementLink,
} from "../lib/settlementWriter";

/**
 * `reverseSettlementLink` must be the EXACT inverse of `deriveSettlementLinkFields`
 * over the four states the authoritative writer can produce. This is what keeps the
 * forward parity gate (`derive(legacy) == link`) valid with NO direction flip during
 * the Phase-4 write-flip: the writer expresses intent as a link, reverse-derives the
 * legacy columns, and the deriver maps them right back to the same link.
 */
describe("reverseSettlementLink ∘ deriveSettlementLinkFields is identity", () => {
  const CONFIRMED_AT = new Date("2026-02-01T12:00:00.000Z");
  // A DIFFERENT updatedAt proves confirmed rows carry confirmedAt from the link,
  // never falling back to updatedAt (kills the drift carve-out for new rows).
  const UPDATED_AT = new Date("2026-06-15T09:30:00.000Z");

  const canonical: Array<[string, SettlementLinkFields]> = [
    [
      "proposed (clean)",
      {
        lifecycle: "proposed",
        provenance: "system",
        depositStagedPaymentId: "dep_1",
        conflictGiftId: null,
        confirmedByUserId: null,
        confirmedAt: null,
      },
    ],
    [
      "proposed (conflict → conflict_approved)",
      {
        lifecycle: "proposed",
        provenance: "system",
        depositStagedPaymentId: "dep_1",
        conflictGiftId: "gift_c",
        confirmedByUserId: null,
        confirmedAt: null,
      },
    ],
    [
      "confirmed (human, clean)",
      {
        lifecycle: "confirmed",
        provenance: "human",
        depositStagedPaymentId: "dep_1",
        conflictGiftId: null,
        confirmedByUserId: "user_1",
        confirmedAt: CONFIRMED_AT,
      },
    ],
    [
      "confirmed (human, from conflict — retains gift discriminator)",
      {
        lifecycle: "confirmed",
        provenance: "human",
        depositStagedPaymentId: "dep_1",
        conflictGiftId: "gift_c",
        confirmedByUserId: "user_1",
        confirmedAt: CONFIRMED_AT,
      },
    ],
    [
      "confirmed (system_confirmed — no user)",
      {
        lifecycle: "confirmed",
        provenance: "system_confirmed",
        depositStagedPaymentId: "dep_1",
        conflictGiftId: null,
        confirmedByUserId: null,
        confirmedAt: CONFIRMED_AT,
      },
    ],
  ];

  for (const [name, link] of canonical) {
    it(`round-trips: ${name}`, () => {
      const roundTripped = deriveSettlementLinkFields({
        ...reverseSettlementLink(link),
        updatedAt: UPDATED_AT,
      });
      expect(roundTripped).toEqual(link);
    });
  }

  it("null link ⇒ unmatched ⇒ no link (null)", () => {
    const write = reverseSettlementLink(null);
    expect(write.qbReconciliationStatus).toBe("unmatched");
    expect(write.proposedQbStagedPaymentId).toBeNull();
    expect(write.matchedQbStagedPaymentId).toBeNull();
    expect(write.qbConflictStagedPaymentId).toBeNull();
    expect(write.qbConflictGiftId).toBeNull();
    expect(write.qbReconciliationConfirmedByUserId).toBeNull();
    expect(write.qbReconciliationConfirmedAt).toBeNull();
    expect(
      deriveSettlementLinkFields({ ...write, updatedAt: UPDATED_AT }),
    ).toBeNull();
  });
});

describe("reverseSettlementLink legacy-column mapping", () => {
  it("clean proposal → proposed with only proposedQbStagedPaymentId set", () => {
    const w = reverseSettlementLink(proposeSettlementLink("dep_9", null));
    expect(w).toEqual({
      qbReconciliationStatus: "proposed",
      proposedQbStagedPaymentId: "dep_9",
      matchedQbStagedPaymentId: null,
      qbConflictStagedPaymentId: null,
      qbConflictGiftId: null,
      qbReconciliationConfirmedByUserId: null,
      qbReconciliationConfirmedAt: null,
    });
  });

  it("conflict proposal → conflict_approved with deposit on both proposed + conflict pointers", () => {
    const w = reverseSettlementLink(proposeSettlementLink("dep_9", "gift_x"));
    expect(w).toEqual({
      qbReconciliationStatus: "conflict_approved",
      proposedQbStagedPaymentId: "dep_9",
      matchedQbStagedPaymentId: null,
      qbConflictStagedPaymentId: "dep_9",
      qbConflictGiftId: "gift_x",
      qbReconciliationConfirmedByUserId: null,
      qbReconciliationConfirmedAt: null,
    });
  });

  it("throws on an 'exempt' lifecycle (no legacy enum mapping)", () => {
    expect(() =>
      reverseSettlementLink({
        lifecycle: "exempt",
        provenance: "system",
        depositStagedPaymentId: "dep_1",
        conflictGiftId: null,
        confirmedByUserId: null,
        confirmedAt: null,
      }),
    ).toThrow(/exempt/);
  });
});

describe("proposeSettlementLink", () => {
  it("builds a clean proposed link", () => {
    expect(proposeSettlementLink("dep_1", null)).toEqual({
      lifecycle: "proposed",
      provenance: "system",
      depositStagedPaymentId: "dep_1",
      conflictGiftId: null,
      confirmedByUserId: null,
      confirmedAt: null,
    });
  });

  it("carries the conflict gift when the deposit is already booked", () => {
    expect(proposeSettlementLink("dep_1", "gift_c")).toEqual({
      lifecycle: "proposed",
      provenance: "system",
      depositStagedPaymentId: "dep_1",
      conflictGiftId: "gift_c",
      confirmedByUserId: null,
      confirmedAt: null,
    });
  });
});
