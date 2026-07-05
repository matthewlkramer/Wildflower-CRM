import { describe, it, expect } from "vitest";
import {
  scoreQbDepositCandidate,
  candidateGiftId,
  MIN_PROPOSE_SCORE,
  RECONCILE_WINDOW_DAYS,
  type PayoutForScore,
  type QbDepositForScore,
} from "../lib/stripeReconcile";

/**
 * Pure scoring for Stripe payout ↔ QuickBooks deposit-lump proposals. No DB.
 * Eligibility = exact amount (≤1¢) OR a near amount (≤$1) backed by a textual
 * "Stripe" signal, within ±RECONCILE_WINDOW_DAYS of the payout arrival date.
 */

const payout = (over: Partial<PayoutForScore> = {}): PayoutForScore => ({
  amount: "1000.00",
  netTotal: "1000.00",
  arrivalDate: "2026-01-10",
  ...over,
});

const deposit = (over: Partial<QbDepositForScore> = {}): QbDepositForScore => ({
  id: "sp_1",
  amount: "1000.00",
  dateReceived: "2026-01-10",
  payerName: "Stripe",
  lineDescription: null,
  qbTransactionMemo: null,
  rawReference: null,
  qbDepositToAccountName: null,
  status: "pending",
  matchedGiftId: null,
  createdGiftId: null,
  groupReconciledGiftId: null,
  ...over,
});

describe("scoreQbDepositCandidate", () => {
  it("scores an exact amount + same date + Stripe signal at the top", () => {
    const s = scoreQbDepositCandidate(payout(), deposit());
    expect(s).not.toBeNull();
    expect(s!.exactAmount).toBe(true);
    expect(s!.stripeSignal).toBe(true);
    expect(s!.dayDiff).toBe(0);
    expect(s!.score).toBe(100);
  });

  it("still proposes an exact amount with no Stripe signal", () => {
    const s = scoreQbDepositCandidate(
      payout(),
      deposit({ payerName: "Bank Deposit" }),
    );
    expect(s).not.toBeNull();
    expect(s!.stripeSignal).toBe(false);
    expect(s!.score).toBe(80);
    expect(s!.score).toBeGreaterThanOrEqual(MIN_PROPOSE_SCORE);
  });

  it("detects the Stripe signal in any text field, case-insensitively", () => {
    const s = scoreQbDepositCandidate(
      payout(),
      deposit({ payerName: null, qbTransactionMemo: "ACH from STRIPE INC" }),
    );
    expect(s!.stripeSignal).toBe(true);
  });

  // Date arithmetic off the fixed payout arrival date (2026-01-10), derived from
  // the constant so these stay correct if the window is retuned.
  const dayMs = 24 * 60 * 60 * 1000;
  const arrival = Date.parse("2026-01-10");
  const isoDaysAfter = (n: number) =>
    new Date(arrival + n * dayMs).toISOString().slice(0, 10);

  it("returns null beyond the date window", () => {
    const s = scoreQbDepositCandidate(
      payout(),
      deposit({ dateReceived: isoDaysAfter(RECONCILE_WINDOW_DAYS + 5) }),
    );
    expect(s).toBeNull();
  });

  it("accepts the edge of the date window", () => {
    const s = scoreQbDepositCandidate(
      payout(),
      deposit({ dateReceived: isoDaysAfter(RECONCILE_WINDOW_DAYS) }),
    );
    expect(s).not.toBeNull();
    expect(s!.dayDiff).toBe(RECONCILE_WINDOW_DAYS);
  });

  it("proposes at a gap that the OLD ±10-day window would have rejected", () => {
    // A QB deposit 20 days off the payout — outside the retired ±10d window but
    // inside the widened one. Regression guard for the window widening.
    const s = scoreQbDepositCandidate(
      payout(),
      deposit({ dateReceived: isoDaysAfter(20) }),
    );
    expect(s).not.toBeNull();
    expect(s!.dayDiff).toBe(20);
    expect(RECONCILE_WINDOW_DAYS).toBeGreaterThanOrEqual(20);
  });

  it("rejects an amount mismatch with no Stripe signal", () => {
    const s = scoreQbDepositCandidate(
      payout(),
      deposit({ amount: "999.50", payerName: "Bank Deposit" }),
    );
    expect(s).toBeNull();
  });

  it("accepts a near amount (≤$1) when there is a Stripe signal", () => {
    const s = scoreQbDepositCandidate(
      payout(),
      deposit({ amount: "999.50" }), // 50¢ off, payer "Stripe"
    );
    expect(s).not.toBeNull();
    expect(s!.exactAmount).toBe(false);
    expect(s!.score).toBeGreaterThanOrEqual(MIN_PROPOSE_SCORE);
  });

  it("rejects a near amount beyond the $1 band even with a Stripe signal", () => {
    const s = scoreQbDepositCandidate(
      payout(),
      deposit({ amount: "998.99" }), // $1.01 off
    );
    expect(s).toBeNull();
  });

  it("falls back to netTotal when payout.amount is null", () => {
    const s = scoreQbDepositCandidate(
      payout({ amount: null, netTotal: "1000.00" }),
      deposit(),
    );
    expect(s).not.toBeNull();
    expect(s!.exactAmount).toBe(true);
  });

  it("returns null when dates are missing", () => {
    expect(
      scoreQbDepositCandidate(payout({ arrivalDate: null }), deposit()),
    ).toBeNull();
    expect(
      scoreQbDepositCandidate(payout(), deposit({ dateReceived: null })),
    ).toBeNull();
  });

  it("penalises date distance so a closer deposit outscores a farther one", () => {
    const near = scoreQbDepositCandidate(
      payout(),
      deposit({ dateReceived: "2026-01-11" }),
    );
    const far = scoreQbDepositCandidate(
      payout(),
      deposit({ dateReceived: "2026-01-18" }),
    );
    expect(near!.score).toBeGreaterThan(far!.score);
  });
});

describe("candidateGiftId", () => {
  it("prefers created over matched over group-reconciled", () => {
    expect(candidateGiftId(deposit({ createdGiftId: "g1", matchedGiftId: "g2" }))).toBe(
      "g1",
    );
    expect(candidateGiftId(deposit({ matchedGiftId: "g2" }))).toBe("g2");
    expect(candidateGiftId(deposit({ groupReconciledGiftId: "g3" }))).toBe("g3");
  });

  it("is null when the deposit is not booked into a gift", () => {
    expect(candidateGiftId(deposit())).toBeNull();
  });
});
