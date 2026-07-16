import { describe, expect, it } from "vitest";
import {
  chargeTieSupersedeMarker,
  decideChargeTieSupersede,
  qbRowAmountMatchesCharge,
  type TieChargeLedgerRow,
  type TieQbLedgerRow,
} from "../lib/chargeTieSupersede";

/**
 * Pure decision core of the charge-grain tie supersede
 * (lib/chargeTieSupersede.ts). No DB — every case feeds facts in and asserts
 * the exact decisions out. The tx applier is covered by
 * charge-tie-supersede.integration.test.ts.
 */

const QB_ID = "qb_row_1";
const MARKER = chargeTieSupersedeMarker(QB_ID);

const qbRow = (over: Partial<TieQbLedgerRow> = {}): TieQbLedgerRow => ({
  id: "pa_qb_1",
  giftId: "gift_1",
  giftAllocationId: null,
  amountApplied: "100.00",
  linkRole: "counted",
  matchMethod: "human",
  confirmedByUserId: "user_1",
  confirmedAt: new Date("2026-01-15T00:00:00Z"),
  ...over,
});

const chargeRow = (over: Partial<TieChargeLedgerRow> = {}): TieChargeLedgerRow => ({
  id: "pa_ch_1",
  giftId: "gift_1",
  note: null,
  ...over,
});

const base = {
  tieConfirmed: true,
  qbStagedPaymentId: QB_ID,
  qbRowAmount: "100.00",
  chargeGross: "100.00",
  chargeNet: "96.80",
  qbLedgerRows: [] as TieQbLedgerRow[],
  chargeCountedRows: [] as TieChargeLedgerRow[],
};

describe("qbRowAmountMatchesCharge (exact cents, NO fee band)", () => {
  it("matches the charge gross to the cent", () => {
    expect(
      qbRowAmountMatchesCharge({
        qbRowAmount: "100.00",
        chargeGross: "100.00",
        chargeNet: "96.80",
      }),
    ).toBe(true);
  });

  it("matches the charge net to the cent", () => {
    expect(
      qbRowAmountMatchesCharge({
        qbRowAmount: "96.80",
        chargeGross: "100.00",
        chargeNet: "96.80",
      }),
    ).toBe(true);
  });

  it("tolerates numeric-string formatting noise (96.8 vs 96.80)", () => {
    expect(
      qbRowAmountMatchesCharge({
        qbRowAmount: "96.8",
        chargeGross: "100.00",
        chargeNet: "96.80",
      }),
    ).toBe(true);
  });

  it("rejects a one-cent difference — deliberately no band", () => {
    expect(
      qbRowAmountMatchesCharge({
        qbRowAmount: "96.79",
        chargeGross: "100.00",
        chargeNet: "96.80",
      }),
    ).toBe(false);
    expect(
      qbRowAmountMatchesCharge({
        qbRowAmount: "100.01",
        chargeGross: "100.00",
        chargeNet: "96.80",
      }),
    ).toBe(false);
  });

  it("rejects when the QB amount is unknown", () => {
    expect(
      qbRowAmountMatchesCharge({
        qbRowAmount: null,
        chargeGross: "100.00",
        chargeNet: "96.80",
      }),
    ).toBe(false);
  });

  it("handles a null gross or net side independently", () => {
    expect(
      qbRowAmountMatchesCharge({
        qbRowAmount: "96.80",
        chargeGross: null,
        chargeNet: "96.80",
      }),
    ).toBe(true);
    expect(
      qbRowAmountMatchesCharge({
        qbRowAmount: "96.80",
        chargeGross: null,
        chargeNet: null,
      }),
    ).toBe(false);
  });
});

describe("decideChargeTieSupersede — tie CONFIRMED", () => {
  it("moves a counted QB row whose gift is not booked on the charge", () => {
    const row = qbRow();
    const decisions = decideChargeTieSupersede({
      ...base,
      qbLedgerRows: [row],
    });
    expect(decisions).toEqual([{ action: "move", qbRow: row }]);
  });

  it("moves on a NET-amount tie too (net bank deposit booking)", () => {
    const row = qbRow({ amountApplied: "96.80" });
    const decisions = decideChargeTieSupersede({
      ...base,
      qbRowAmount: "96.80",
      qbLedgerRows: [row],
    });
    expect(decisions).toEqual([{ action: "move", qbRow: row }]);
  });

  it("demotes only when the charge already counts the same gift (Rogers shape)", () => {
    const row = qbRow();
    const decisions = decideChargeTieSupersede({
      ...base,
      qbLedgerRows: [row],
      chargeCountedRows: [chargeRow({ giftId: "gift_1" })],
    });
    expect(decisions).toEqual([{ action: "demote_only", qbRow: row }]);
  });

  it("does NOTHING when the tie amount is inexact (override-mismatch tie)", () => {
    // The human overrode the amount mismatch on confirm — the booking
    // conservatively stays on the QB row.
    const decisions = decideChargeTieSupersede({
      ...base,
      qbRowAmount: "150.00",
      qbLedgerRows: [qbRow({ amountApplied: "150.00" })],
    });
    expect(decisions).toEqual([]);
  });

  it("re-converges a half-moved state (corroborating QB row, charge unbooked)", () => {
    const row = qbRow({ linkRole: "corroborating" });
    const decisions = decideChargeTieSupersede({
      ...base,
      qbLedgerRows: [row],
    });
    expect(decisions).toEqual([{ action: "book_only", qbRow: row }]);
  });

  it("is a no-op on the fully converged state (idempotent)", () => {
    const decisions = decideChargeTieSupersede({
      ...base,
      qbLedgerRows: [qbRow({ linkRole: "corroborating" })],
      chargeCountedRows: [chargeRow({ giftId: "gift_1", note: MARKER })],
    });
    expect(decisions).toEqual([]);
  });

  it("never touches corrections-flow annotation rows (amount NULL)", () => {
    const decisions = decideChargeTieSupersede({
      ...base,
      qbLedgerRows: [
        qbRow({ linkRole: "corroborating", amountApplied: null }),
        qbRow({ id: "pa_qb_2", linkRole: "counted", amountApplied: null }),
      ],
    });
    expect(decisions).toEqual([]);
  });

  it("handles multiple gifts on the tied row independently", () => {
    const a = qbRow({ id: "pa_a", giftId: "gift_a", amountApplied: "60.00" });
    const b = qbRow({ id: "pa_b", giftId: "gift_b", amountApplied: "40.00" });
    const decisions = decideChargeTieSupersede({
      ...base,
      qbLedgerRows: [a, b],
      chargeCountedRows: [chargeRow({ giftId: "gift_b" })],
    });
    expect(decisions).toEqual([
      { action: "move", qbRow: a },
      { action: "demote_only", qbRow: b },
    ]);
  });
});

describe("decideChargeTieSupersede — tie REVERTED", () => {
  const reverted = { ...base, tieConfirmed: false };

  it("removes ONLY this tie's marked stripe rows and promotes the demoted QB row", () => {
    const marked = chargeRow({ id: "pa_marked", note: MARKER });
    const preexisting = chargeRow({ id: "pa_manual", giftId: "gift_2" });
    const otherTie = chargeRow({
      id: "pa_other",
      giftId: "gift_3",
      note: chargeTieSupersedeMarker("qb_row_OTHER"),
    });
    const demoted = qbRow({ linkRole: "corroborating" });
    const decisions = decideChargeTieSupersede({
      ...reverted,
      qbLedgerRows: [demoted],
      chargeCountedRows: [marked, preexisting, otherTie],
    });
    expect(decisions).toEqual([
      { action: "remove_charge_row", chargeRow: marked },
      { action: "promote", qbRow: demoted },
    ]);
  });

  it("promotes regardless of amount exactness (the human ratified it originally)", () => {
    // The exactness test gates the CONFIRM direction only; a revert must
    // always restore the QB booking it demoted.
    const demoted = qbRow({ linkRole: "corroborating", amountApplied: "150.00" });
    const decisions = decideChargeTieSupersede({
      ...reverted,
      qbRowAmount: "150.00",
      qbLedgerRows: [demoted],
    });
    expect(decisions).toEqual([{ action: "promote", qbRow: demoted }]);
  });

  it("never promotes corrections-flow annotation rows (amount NULL)", () => {
    const decisions = decideChargeTieSupersede({
      ...reverted,
      qbLedgerRows: [qbRow({ linkRole: "corroborating", amountApplied: null })],
    });
    expect(decisions).toEqual([]);
  });

  it("leaves a still-counted QB row alone on revert (nothing was moved)", () => {
    // Override-mismatch tie: confirm moved nothing, so revert has nothing to
    // undo — the counted QB row must stay untouched.
    const decisions = decideChargeTieSupersede({
      ...reverted,
      qbLedgerRows: [qbRow({ linkRole: "counted" })],
    });
    expect(decisions).toEqual([]);
  });

  it("is a no-op when there is nothing tie-derived (idempotent)", () => {
    const decisions = decideChargeTieSupersede({
      ...reverted,
      chargeCountedRows: [chargeRow()],
    });
    expect(decisions).toEqual([]);
  });
});
