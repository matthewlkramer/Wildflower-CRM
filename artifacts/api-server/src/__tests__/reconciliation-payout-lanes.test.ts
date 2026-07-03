import { describe, it, expect } from "vitest";
import { derivePayoutLanes } from "../lib/reconciliationLanes";
import { deriveSettlementLinkFields } from "../lib/settlementLink";

// S5 read-flip equivalence guard. `derivePayoutLanes` now reads the
// `settlement_links` mirror (its `lifecycle`) instead of the legacy 7-value
// `qb_reconciliation_status`. For every legacy status, deriving the mirror fields
// (`deriveSettlementLinkFields` — the SAME pure mapping the dual-write, the 0089
// backfill, and the prod parity gate all use) and THEN the lanes must reproduce
// the OLD status-based lane mapping — with ONE ratified exception:
// `confirmed_excluded` mirrors as a CONFIRMED settlement link and so now reads
// funding=confirmed (the old mapping read it as exempt).

type LegacyStatus =
  | "unmatched"
  | "proposed"
  | "conflict_approved"
  | "confirmed_reconciled"
  | "confirmed_excluded"
  | "confirmed_keep"
  | "confirmed_replace";

// The pre-flip status→funding mapping, inlined verbatim as the equivalence
// baseline (this is exactly what `derivePayoutLanes(status)` returned before S5).
function legacyPayoutFunding(status: LegacyStatus) {
  return status === "confirmed_excluded"
    ? "exempt"
    : status === "confirmed_reconciled" ||
        status === "confirmed_keep" ||
        status === "confirmed_replace"
      ? "confirmed"
      : status === "proposed" || status === "conflict_approved"
        ? "proposed"
        : "unlinked";
}

const DEPOSIT = "sp_deposit_1";

// A representative payout source for each legacy status, mirroring how the propose
// / confirm passes populate the pointer columns (`deriveSettlementLinkFields`
// reads these to produce the settlement_links row). The propose pass always sets
// `proposedQbStagedPaymentId`; confirm additionally stamps `matched`; a conflict
// additionally stamps `qbConflict` (== the proposed id in practice).
function sourceFor(status: LegacyStatus) {
  const confirmed = status.startsWith("confirmed_");
  return {
    qbReconciliationStatus: status,
    proposedQbStagedPaymentId: status === "unmatched" ? null : DEPOSIT,
    matchedQbStagedPaymentId: confirmed ? DEPOSIT : null,
    qbConflictStagedPaymentId: status === "conflict_approved" ? DEPOSIT : null,
    qbReconciliationConfirmedByUserId: null,
    qbReconciliationConfirmedAt: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

const ALL_STATUSES: LegacyStatus[] = [
  "unmatched",
  "proposed",
  "conflict_approved",
  "confirmed_reconciled",
  "confirmed_excluded",
  "confirmed_keep",
  "confirmed_replace",
];

describe("derivePayoutLanes (settlement_links-sourced)", () => {
  it("crmRecord is always null for a batch payout", () => {
    expect(derivePayoutLanes(null).crmRecord).toBeNull();
    expect(derivePayoutLanes({ lifecycle: "confirmed" }).crmRecord).toBeNull();
  });

  it("orphan (no link) reads funding=unlinked", () => {
    expect(derivePayoutLanes(null).funding).toBe("unlinked");
    expect(derivePayoutLanes(undefined).funding).toBe("unlinked");
  });

  it("maps lifecycle straight onto the funding lane", () => {
    expect(derivePayoutLanes({ lifecycle: "proposed" }).funding).toBe(
      "proposed",
    );
    expect(derivePayoutLanes({ lifecycle: "confirmed" }).funding).toBe(
      "confirmed",
    );
    expect(derivePayoutLanes({ lifecycle: "exempt" }).funding).toBe("exempt");
  });

  it("reproduces the legacy status→lane mapping via the mirror, except confirmed_excluded", () => {
    for (const status of ALL_STATUSES) {
      const link = deriveSettlementLinkFields(sourceFor(status));
      const lanes = derivePayoutLanes(link);
      if (status === "confirmed_excluded") {
        // Ratified delta: a confirmed settlement, not exempt.
        expect(legacyPayoutFunding(status)).toBe("exempt");
        expect(lanes.funding).toBe("confirmed");
      } else {
        expect(lanes.funding).toBe(legacyPayoutFunding(status));
      }
    }
  });
});
