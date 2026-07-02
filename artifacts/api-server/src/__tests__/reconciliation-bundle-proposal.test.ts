import { describe, it, expect } from "vitest";
import {
  baseRowFrom,
  deriveProposal,
  mergeOverrides,
  proposeNewDonor,
  tierFromScore,
  type BundleBase,
  type BaseChargeRow,
  type BundleFacts,
  type ScoredSourceRow,
  type StoredBundleOverrides,
} from "../lib/reconciliationBundleProposal";
import type { ScoredMatch } from "../lib/quickbooksMatch";

/**
 * Pure reactive boundary — no DB. We construct a BundleBase (the DB-loaded
 * auto-derivation) + facts + persisted overrides, then assert deriveProposal
 * recomputes donor/gift/warnings/readiness as a human edits rows. Covers the
 * T003 acceptance cases: new-donor→existing-donor, mint↔match, amount warnings,
 * research/exclude.
 */

const baseRow = (over: Partial<BaseChargeRow> = {}): BaseChargeRow => ({
  rowKey: "ch_1",
  stripeChargeId: "ch_1",
  stagedPaymentId: null,
  amount: "100.00",
  feeAmount: "3.20",
  netAmount: "96.80",
  dateReceived: "2026-02-01",
  payerName: "Jane Donor",
  payerEmail: "jane@example.com",
  autoDonorKind: "unresolved",
  autoDonorId: null,
  autoDonorRecordKind: null,
  autoNewDonor: null,
  autoIntermediaryId: null,
  autoDonorConfidence: null,
  autoDonorSource: null,
  autoGiftKind: "research",
  autoGiftId: null,
  autoMintAmount: "100.00",
  autoMintFinalSource: "stripe",
  autoExclusionReason: null,
  autoGiftConfidence: null,
  autoGiftSource: null,
  committedGiftId: null,
  ...over,
});

const makeBase = (
  rows: BaseChargeRow[],
  facts: BundleFacts = { donors: {}, gifts: {} },
): BundleBase => ({
  anchorType: "stripe_payout",
  anchorId: "po_1",
  rows,
  tie: null,
  facts,
  sourceFingerprint: "fp",
});

describe("tierFromScore", () => {
  it("buckets by threshold", () => {
    expect(tierFromScore(95)).toBe("high");
    expect(tierFromScore(90)).toBe("high");
    expect(tierFromScore(80)).toBe("medium");
    expect(tierFromScore(70)).toBe("medium");
    expect(tierFromScore(40)).toBe("low");
    expect(tierFromScore(0)).toBe("none");
    expect(tierFromScore(null)).toBe("none");
  });
});

describe("proposeNewDonor", () => {
  it("reads a 2–3 token name with no org keyword as a person", () => {
    const d = proposeNewDonor("Jane Q Donor", "jane@example.com");
    expect(d).toMatchObject({ kind: "person", firstName: "Jane", lastName: "Q Donor" });
  });
  it("reads org keywords as an organization", () => {
    expect(proposeNewDonor("Helpful Foundation", null)).toMatchObject({
      kind: "organization",
    });
    expect(proposeNewDonor("Acme Inc", null)).toMatchObject({ kind: "organization" });
  });
  it("falls back to email-as-person when only an email is present", () => {
    expect(proposeNewDonor(null, "x@y.com")).toMatchObject({ kind: "person", email: "x@y.com" });
  });
  it("returns null with nothing usable", () => {
    expect(proposeNewDonor(null, null)).toBeNull();
  });
});

describe("deriveProposal — auto derivation", () => {
  it("proposes a NEW donor + MINT when nothing matches but payer facts exist", () => {
    const base = makeBase([
      baseRow({
        autoDonorKind: "new",
        autoNewDonor: { kind: "person", name: "Jane Donor", firstName: "Jane", lastName: "Donor" },
        autoDonorSource: "email",
        autoGiftKind: "mint",
        autoMintFinalSource: "stripe",
      }),
    ]);
    const { proposal, commit } = deriveProposal(base, {});
    expect(proposal.rows[0].donor.kind).toBe("new");
    expect(proposal.rows[0].gift.kind).toBe("mint");
    expect(proposal.rows[0].gift.mintDraft).toMatchObject({
      amount: "100.00",
      finalAmountSource: "stripe",
    });
    expect(proposal.rows[0].ready).toBe(true);
    expect(proposal.summary).toMatchObject({ mintCount: 1, newDonorCount: 1, ready: true });
    expect(commit[0].alreadyCommitted).toBe(false);
  });

  it("leaves a row in research when the donor is unresolved", () => {
    const base = makeBase([baseRow({ autoDonorKind: "unresolved", autoGiftKind: "research" })]);
    const { proposal } = deriveProposal(base, {});
    expect(proposal.rows[0].gift.kind).toBe("research");
    expect(proposal.rows[0].ready).toBe(true);
    expect(proposal.summary.researchCount).toBe(1);
  });
});

describe("deriveProposal — new-donor → existing-donor override", () => {
  it("swaps a proposed new donor for a picked existing donor (provenance=override)", () => {
    const base = makeBase(
      [
        baseRow({
          autoDonorKind: "new",
          autoNewDonor: { kind: "person", name: "Jane Donor" },
          autoGiftKind: "mint",
        }),
      ],
      { donors: { "person:p_9": { kind: "person", name: "Jane Q. Donor" } }, gifts: {} },
    );
    const overrides: StoredBundleOverrides = {
      rows: {
        ch_1: { rowKey: "ch_1", donorKind: "existing", donorId: "p_9", donorRecordKind: "person" },
      },
    };
    const { proposal } = deriveProposal(base, overrides);
    const donor = proposal.rows[0].donor;
    expect(donor.kind).toBe("existing");
    expect(donor.donorId).toBe("p_9");
    expect(donor.donorName).toBe("Jane Q. Donor");
    expect(proposal.rows[0].provenance).toBe("override");
    // Still a mint, now to a resolved existing donor → ready.
    expect(proposal.rows[0].gift.kind).toBe("mint");
    expect(proposal.rows[0].ready).toBe(true);
    expect(proposal.summary.newDonorCount).toBe(0);
  });
});

describe("deriveProposal — mint ↔ match", () => {
  const facts: BundleFacts = {
    donors: { "person:p_1": { kind: "person", name: "Jane Donor" } },
    gifts: {
      g_1: {
        amount: "100.00",
        name: "$100.00",
        donorKind: "person",
        donorId: "p_1",
        donorName: "Jane Donor",
        linkedByStagedPaymentId: null,
        linkedByChargeId: null,
      },
    },
  };

  it("override flips an auto-mint into a match against a chosen gift", () => {
    const base = makeBase(
      [
        baseRow({
          autoDonorKind: "existing",
          autoDonorId: "p_1",
          autoDonorRecordKind: "person",
          autoGiftKind: "mint",
        }),
      ],
      facts,
    );
    const { proposal } = deriveProposal(base, {
      rows: { ch_1: { rowKey: "ch_1", giftKind: "match", giftId: "g_1" } },
    });
    expect(proposal.rows[0].gift.kind).toBe("match");
    expect(proposal.rows[0].gift.giftId).toBe("g_1");
    expect(proposal.rows[0].gift.giftAmount).toBe("100.00");
    expect(proposal.rows[0].warnings).toHaveLength(0);
    expect(proposal.rows[0].ready).toBe(true);
    expect(proposal.summary).toMatchObject({ matchCount: 1, mintCount: 0 });
  });

  it("override flips an auto-match into a mint", () => {
    const base = makeBase(
      [
        baseRow({
          autoDonorKind: "existing",
          autoDonorId: "p_1",
          autoDonorRecordKind: "person",
          autoGiftKind: "match",
          autoGiftId: "g_1",
          autoGiftConfidence: 95,
        }),
      ],
      facts,
    );
    const { proposal } = deriveProposal(base, {
      rows: { ch_1: { rowKey: "ch_1", giftKind: "mint", mintAmount: "100.00" } },
    });
    expect(proposal.rows[0].gift.kind).toBe("mint");
    expect(proposal.rows[0].gift.mintDraft?.amount).toBe("100.00");
    expect(proposal.rows[0].ready).toBe(true);
  });
});

describe("deriveProposal — amount-mismatch warning", () => {
  const facts: BundleFacts = {
    donors: { "person:p_1": { kind: "person", name: "Jane Donor" } },
    gifts: {
      g_big: {
        amount: "500.00",
        name: "$500.00",
        donorKind: "person",
        donorId: "p_1",
        donorName: "Jane Donor",
        linkedByStagedPaymentId: null,
        linkedByChargeId: null,
      },
    },
  };

  it("warns when a matched gift's amount is outside the fee band", () => {
    const base = makeBase(
      [
        baseRow({
          amount: "100.00",
          netAmount: "96.80",
          autoDonorKind: "existing",
          autoDonorId: "p_1",
          autoDonorRecordKind: "person",
          autoGiftKind: "match",
          autoGiftId: "g_big",
        }),
      ],
      facts,
    );
    const { proposal } = deriveProposal(base, {});
    const warn = proposal.rows[0].warnings.find((w) => w.code === "amount_mismatch");
    expect(warn?.severity).toBe("warning");
    // A non-blocking warning still leaves a match row "ready".
    expect(proposal.rows[0].ready).toBe(true);
    expect(proposal.summary.warningCount).toBeGreaterThanOrEqual(1);
  });

  it("clears the warning when the human acknowledges the mismatch", () => {
    const base = makeBase(
      [
        baseRow({
          amount: "100.00",
          autoDonorKind: "existing",
          autoDonorId: "p_1",
          autoDonorRecordKind: "person",
          autoGiftKind: "match",
          autoGiftId: "g_big",
        }),
      ],
      facts,
    );
    const { proposal } = deriveProposal(base, {
      rows: { ch_1: { rowKey: "ch_1", overrideAmountMismatchReason: "split deposit" } },
    });
    expect(proposal.rows[0].warnings.find((w) => w.code === "amount_mismatch")).toBeUndefined();
  });

  it("blocks a match to a gift already linked outside the bundle", () => {
    const linkedFacts: BundleFacts = {
      donors: {},
      gifts: {
        g_taken: {
          amount: "100.00",
          name: "$100.00",
          donorKind: "person",
          donorId: "p_1",
          donorName: "Jane Donor",
          // The anchor row is a Stripe charge, so ANOTHER charge owning the gift
          // is the double-book (a QB staged link would be parallel evidence).
          linkedByStagedPaymentId: null,
          linkedByChargeId: "ch_other",
        },
      },
    };
    const base = makeBase(
      [baseRow({ autoGiftKind: "match", autoGiftId: "g_taken" })],
      linkedFacts,
    );
    const { proposal } = deriveProposal(base, {});
    const warn = proposal.rows[0].warnings.find((w) => w.code === "gift_already_linked");
    expect(warn?.severity).toBe("blocker");
    expect(proposal.rows[0].ready).toBe(false);
    expect(proposal.summary.ready).toBe(false);
    expect(proposal.summary.blockerCount).toBeGreaterThanOrEqual(1);
  });

  it("does NOT block a Stripe charge from a gift only QB-reconciled (parallel evidence)", () => {
    // QuickBooks and Stripe are parallel evidence for one gift: a charge landing
    // on a gift already tied to a QB staged payment is expected, not a double-book.
    const linkedFacts: BundleFacts = {
      donors: {},
      gifts: {
        g_qb: {
          amount: "100.00",
          name: "$100.00",
          donorKind: "person",
          donorId: "p_1",
          donorName: "Jane Donor",
          linkedByStagedPaymentId: "sp_other",
          linkedByChargeId: null,
        },
      },
    };
    const base = makeBase(
      [baseRow({ autoGiftKind: "match", autoGiftId: "g_qb" })],
      linkedFacts,
    );
    const { proposal } = deriveProposal(base, {});
    expect(
      proposal.rows[0].warnings.find((w) => w.code === "gift_already_linked"),
    ).toBeUndefined();
    expect(proposal.rows[0].ready).toBe(true);
  });

  it("does NOT block a QB staged row from a gift only Stripe-linked (parallel evidence)", () => {
    const linkedFacts: BundleFacts = {
      donors: {},
      gifts: {
        g_stripe: {
          amount: "100.00",
          name: "$100.00",
          donorKind: "person",
          donorId: "p_1",
          donorName: "Jane Donor",
          linkedByStagedPaymentId: null,
          linkedByChargeId: "ch_other",
        },
      },
    };
    const base = makeBase(
      [
        baseRow({
          rowKey: "sp_1",
          stripeChargeId: null,
          stagedPaymentId: "sp_1",
          autoGiftKind: "match",
          autoGiftId: "g_stripe",
        }),
      ],
      linkedFacts,
    );
    const { proposal } = deriveProposal(base, {
      rows: { sp_1: { rowKey: "sp_1", giftKind: "match", giftId: "g_stripe" } },
    });
    expect(
      proposal.rows[0].warnings.find((w) => w.code === "gift_already_linked"),
    ).toBeUndefined();
    expect(proposal.rows[0].ready).toBe(true);
  });
});

describe("deriveProposal — research / exclude", () => {
  it("exclude without a reason is a blocker; with a reason it is ready", () => {
    const base = makeBase([baseRow()]);
    const noReason = deriveProposal(base, {
      rows: { ch_1: { rowKey: "ch_1", giftKind: "exclude" } },
    });
    expect(noReason.proposal.rows[0].warnings[0]).toMatchObject({
      code: "exclusion_reason_required",
      severity: "blocker",
    });
    expect(noReason.proposal.summary.ready).toBe(false);

    const withReason = deriveProposal(base, {
      rows: { ch_1: { rowKey: "ch_1", giftKind: "exclude", exclusionReason: "membership" } },
    });
    expect(withReason.proposal.rows[0].gift.exclusionReason).toBe("membership");
    expect(withReason.proposal.rows[0].ready).toBe(true);
    expect(withReason.proposal.summary).toMatchObject({ excludeCount: 1, ready: true });
  });

  it("a mint with an unresolved donor is blocked until a donor is chosen", () => {
    const base = makeBase([baseRow({ autoDonorKind: "unresolved", autoGiftKind: "research" })]);
    const { proposal } = deriveProposal(base, {
      rows: { ch_1: { rowKey: "ch_1", giftKind: "mint" } },
    });
    expect(proposal.rows[0].warnings.find((w) => w.code === "donor_required")?.severity).toBe(
      "blocker",
    );
    expect(proposal.rows[0].ready).toBe(false);
  });
});

describe("deriveProposal — already-committed rows are locked + skipped", () => {
  it("reflects the existing gift and marks the commit row alreadyCommitted", () => {
    const facts: BundleFacts = {
      donors: { "person:p_1": { kind: "person", name: "Jane Donor" } },
      gifts: {
        g_done: {
          amount: "100.00",
          name: "$100.00",
          donorKind: "person",
          donorId: "p_1",
          donorName: "Jane Donor",
          linkedByStagedPaymentId: null,
          linkedByChargeId: null,
        },
      },
    };
    const base = makeBase(
      [baseRow({ committedGiftId: "g_done", autoGiftKind: "match", autoGiftId: "g_done" })],
      facts,
    );
    // Even a human override is ignored on a committed row.
    const { proposal, commit } = deriveProposal(base, {
      rows: { ch_1: { rowKey: "ch_1", giftKind: "research" } },
    });
    expect(proposal.rows[0].gift.kind).toBe("match");
    expect(proposal.rows[0].gift.giftId).toBe("g_done");
    expect(proposal.rows[0].donor.kind).toBe("existing");
    expect(commit[0].alreadyCommitted).toBe(true);
  });
});

describe("deriveProposal — tie", () => {
  it("proposes confirm_tie for a proposed payout with a deposit", () => {
    const base: BundleBase = {
      anchorType: "stripe_payout",
      anchorId: "po_1",
      rows: [baseRow({ autoDonorKind: "new", autoGiftKind: "mint" })],
      tie: {
        payoutId: "po_1",
        depositStagedPaymentId: "sp_1",
        status: "proposed",
        payoutNetAmount: "100.00",
        depositAmount: "100.00",
        chargeCount: 1,
        qbConflictGiftId: null,
      },
      facts: { donors: {}, gifts: {} },
      sourceFingerprint: "fp",
    };
    const { proposal } = deriveProposal(base, {});
    expect(proposal.tie?.action).toBe("confirm_tie");
    expect(proposal.tie?.depositStagedPaymentId).toBe("sp_1");
  });
});

describe("mergeOverrides", () => {
  it("merges per-row fields and keeps prior values for omitted fields", () => {
    const stored: StoredBundleOverrides = {
      rows: { ch_1: { rowKey: "ch_1", giftKind: "mint", mintAmount: "50.00" } },
      tie: null,
    };
    const merged = mergeOverrides(stored, {
      rows: [{ rowKey: "ch_1", donorKind: "existing", donorId: "p_1" }],
    });
    expect(merged.rows?.ch_1).toMatchObject({
      giftKind: "mint",
      mintAmount: "50.00",
      donorKind: "existing",
      donorId: "p_1",
    });
  });

  it("clear:true drops a row override", () => {
    const stored: StoredBundleOverrides = {
      rows: { ch_1: { rowKey: "ch_1", giftKind: "mint" } },
    };
    const merged = mergeOverrides(stored, { rows: [{ rowKey: "ch_1", clear: true }] });
    expect(merged.rows?.ch_1).toBeUndefined();
  });

  it("merges and clears the tie override", () => {
    const stored: StoredBundleOverrides = { rows: {}, tie: null };
    const set = mergeOverrides(stored, { tie: { action: "confirm_tie", depositStagedPaymentId: "sp_2" } });
    expect(set.tie).toMatchObject({ action: "confirm_tie", depositStagedPaymentId: "sp_2" });
    const cleared = mergeOverrides(set, { tie: { clear: true } });
    expect(cleared.tie).toBeNull();
  });
});

/**
 * baseRowFrom is the pure DB→proposal mapping that turns a scored source row into
 * the auto gift outcome. Its gift-kind decision is the guard against the reported
 * bug: a settlement bundle must NOT auto-mint when the donor already has plausible
 * existing gifts (they may be the very money waiting to be matched) — it must fall
 * to "research" so a human links or mints deliberately.
 */
describe("baseRowFrom — auto gift outcome", () => {
  const scored = (over: Partial<ScoredMatch> = {}): ScoredMatch => ({
    donor: {
      organizationId: null,
      individualGiverPersonId: null,
      householdId: null,
    },
    intermediaryId: null,
    matchedGiftId: null,
    giftCandidateCount: 0,
    score: 0,
    method: null,
    tier: "none",
    ...over,
  });

  const scoredRow = (over: Partial<ScoredSourceRow> = {}): ScoredSourceRow => ({
    rowKey: "ch_1",
    stripeChargeId: "ch_1",
    stagedPaymentId: null,
    amount: "100.00",
    feeAmount: "3.20",
    netAmount: "96.80",
    dateReceived: "2026-02-01",
    payerName: "Jane Donor",
    payerEmail: "jane@example.com",
    status: "pending",
    exclusionReason: null,
    committedGiftId: null,
    match: scored(),
    ...over,
  });

  it("mints when the donor is resolved and has NO existing candidate gifts", () => {
    const row = baseRowFrom(
      scoredRow({
        match: scored({
          donor: { organizationId: "org_1", individualGiverPersonId: null, householdId: null },
          method: "name",
          giftCandidateCount: 0,
        }),
      }),
    );
    expect(row.autoDonorKind).toBe("existing");
    expect(row.autoGiftKind).toBe("mint");
  });

  it("researches (never mints) when candidate gifts exist but none is an unambiguous target", () => {
    const row = baseRowFrom(
      scoredRow({
        match: scored({
          donor: { organizationId: "org_1", individualGiverPersonId: null, householdId: null },
          method: "name",
          matchedGiftId: null,
          // The donor already has same-amount gifts in the window — the money may
          // already be recorded, so this must NOT auto-mint.
          giftCandidateCount: 2,
        }),
      }),
    );
    expect(row.autoDonorKind).toBe("existing");
    expect(row.autoGiftKind).toBe("research");
  });

  it("matches when the scorer found an unambiguous existing gift", () => {
    const row = baseRowFrom(
      scoredRow({
        match: scored({
          donor: { organizationId: "org_1", individualGiverPersonId: null, householdId: null },
          method: "name",
          matchedGiftId: "g_1",
          giftCandidateCount: 1,
        }),
      }),
    );
    expect(row.autoGiftKind).toBe("match");
    expect(row.autoGiftId).toBe("g_1");
  });

  it("also researches a proposed NEW donor when candidate gifts exist", () => {
    // No existing donor match, but payer facts propose a new donor. Even here, a
    // plausible existing gift blocks the auto-mint.
    const row = baseRowFrom(
      scoredRow({
        match: scored({ method: null, matchedGiftId: null, giftCandidateCount: 1 }),
      }),
    );
    expect(row.autoDonorKind).toBe("new");
    expect(row.autoGiftKind).toBe("research");
  });

  it("researches when the donor is unresolved (no payer facts)", () => {
    const row = baseRowFrom(
      scoredRow({ payerName: null, payerEmail: null, match: scored() }),
    );
    expect(row.autoDonorKind).toBe("unresolved");
    expect(row.autoGiftKind).toBe("research");
  });
});
