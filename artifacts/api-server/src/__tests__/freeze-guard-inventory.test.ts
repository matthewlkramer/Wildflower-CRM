import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * STATIC FREEZE-GUARD COVERAGE INVENTORY.
 *
 * Mirrors merge-entities.test.ts: a hand-maintained classification that a test
 * proves is EXHAUSTIVE, so a new mutation surface can't silently bypass the
 * fiscal-year freeze. Every source file that inserts/updates/deletes one of the
 * four audited money tables (gifts, opportunities/pledges, and their allocation
 * children) MUST appear here as either:
 *   - "guarded": a human-edit route whose audited-fact paths call the freeze
 *     guard (`../lib/freezeGuard`). The test also asserts the file references the
 *     guard, so a new unguarded handler added to a guarded file that removed the
 *     last guard reference would be caught.
 *   - "exempt": a derived-column applier, grant-letter artifact write, or system
 *     money writer (pull-sync / reconciliation engine) that establishes or
 *     recomputes ground truth rather than letting a human alter an audited number.
 *     Each exempt entry must carry a reason.
 *
 * When this test fails after you add a write to one of these tables, classify the
 * new file here (and wire the freeze guard if it is a human edit of an audited
 * fact) — do not just append it to make the test pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");

const WRITE_RE =
  /\.(insert|update|delete)\(\s*(giftsAndPayments|opportunitiesAndPledges|giftAllocations|pledgeAllocations)\b/;
const GENERIC_WRITE_RE = /\.(insert|update|delete)\(\s*(cfg|config)\.table\b/;

const GUARD_SYMBOLS = [
  "resolveGiftFreeze",
  "resolvePledgeFreeze",
  "resolveGiftAllocationFreeze",
  "resolvePledgeAllocationFreeze",
  "resolveGiftFreezeById",
  "resolvePledgeFreezeById",
  "respondFrozen",
  "freezeMessage",
  "freezeCheck",
  "freezeResolver",
  "FreezeDecision",
  "freezeGuard",
];

type Classification = "guarded" | "exempt";
interface FileClass {
  classification: Classification;
  reason: string;
}

const EXPECTED: Record<string, FileClass> = {
  "routes/giftsAndPayments.ts": {
    classification: "guarded",
    reason:
      "Gift create + PATCH call resolveGiftFreeze; archive/unarchive/bulk-archive wire resolveGiftFreezeById and bulk-update wires resolveGiftFreeze via freezeCheck. FOLLOW-UP (architect-agreed deferrable): revert-to-opportunity/split transforms in this file are not freeze-guarded yet.",
  },
  "routes/giftAllocations.ts": {
    classification: "guarded",
    reason:
      "Allocation create/PATCH/delete gated by the parent gift's governing FY via resolveGiftAllocationFreeze.",
  },
  "routes/opportunitiesAndPledges.ts": {
    classification: "guarded",
    reason:
      "Pledge/opportunity create + PATCH call resolvePledgeFreeze; archive/unarchive/bulk-archive wire resolvePledgeFreezeById and bulk-update wires resolvePledgeFreeze via freezeCheck.",
  },
  "routes/pledgeAllocations.ts": {
    classification: "guarded",
    reason:
      "Allocation create/PATCH/delete gated by the parent pledge's governing FY via resolvePledgeAllocationFreeze.",
  },
  "lib/bulkUpdate.ts": {
    classification: "guarded",
    reason:
      "Generic bulk-update helper: enforces the optional freezeCheck the gift/pledge routes wire in (frozen row → skipped into failed[]). Non-audited tables pass no check and are unaffected.",
  },
  "lib/archive.ts": {
    classification: "guarded",
    reason:
      "Generic archive/unarchive/bulk-archive helper: enforces the optional freezeResolver the gift/pledge routes wire in (frozen → 409, or skipped in bulk). Non-audited tables pass no resolver.",
  },
  "lib/giftQbTie.ts": {
    classification: "exempt",
    reason: "Derived-column applier: writes only the derived quickbooks_tie_status.",
  },
  "lib/pledgeStage.ts": {
    classification: "exempt",
    reason:
      "Derived-column applier: writes derived opportunity status / paid_amount / win_probability.",
  },
  "lib/grantAgreements.ts": {
    classification: "exempt",
    reason:
      "Grant-letter artifact write; grant letters are not frozen by the audit-close model.",
  },
  "lib/giftFinalAmount.ts": {
    classification: "exempt",
    reason:
      "Writes derived provenance / settlement pointers; preserves the human-entered audited amount (never overwrites it).",
  },
  "lib/giftAllocationSeed.ts": {
    classification: "exempt",
    reason:
      "Seeds the starter allocation at mint time (new record); never edits an existing audited allocation.",
  },
  "lib/reconciliationCommit.ts": {
    classification: "exempt",
    reason:
      "Reconciliation engine: mints gifts and records evidence / derived links (system ground-truth), not a human edit.",
  },
  "lib/reconciliationBundleCommit.ts": {
    classification: "exempt",
    reason: "Settlement-bundle reconciliation engine (system ground-truth).",
  },
  "lib/quickbooksSync.ts": {
    classification: "exempt",
    reason: "QuickBooks pull-sync: system money writer creating new staged records.",
  },
  "lib/stripeRefund.ts": {
    classification: "exempt",
    reason:
      "Stripe refund/chargeback propagation (system, forward-only). FOLLOW-UP: re-yearing a refund that reduces a closed-FY gift is not handled yet.",
  },
  "lib/stripeChargeRevert.ts": {
    classification: "exempt",
    reason:
      "Ledger-authoritative reversal of a Stripe charge's own application; deletes a charge-minted gift only when no other evidence still funds it.",
  },
  "lib/applyProposalActions.ts": {
    classification: "exempt",
    reason:
      "AI email-proposal apply: creates new opportunities / allocations (new records).",
  },
  "lib/codingForms.ts": {
    classification: "exempt",
    reason:
      "One-time admin coding-form import/reconciliation over historical, pre-audit data.",
  },
  "lib/giftCombine.ts": {
    classification: "exempt",
    reason:
      "Gift merge/dedup engine. FOLLOW-UP: merge freeze (archiving audited losers) is not enforced yet.",
  },
  "lib/mergeEntities.ts": {
    classification: "exempt",
    reason:
      "Entity-merge engine: repoints donor FKs on gift/pledge rows and archives duplicate orgs/people — a structural identity consolidation, not a human edit of an audited amount/date. FOLLOW-UP (architect-agreed deferrable): a merge repointing a closed-FY gift/pledge donor is not freeze-gated yet.",
  },
  "routes/adminReassign.ts": {
    classification: "exempt",
    reason:
      "Owner/assignee reassignment: CRM ownership metadata, not an audited financial fact.",
  },
  "routes/emailProposals.ts": {
    classification: "exempt",
    reason:
      "Thank-you gift linkage (derived relationship pointer), not an audited amount/date edit.",
  },
  "routes/donorbox.ts": {
    classification: "exempt",
    reason: "Donorbox pull-sync: system money writer (new records / enrich).",
  },
  "routes/grantLeads.ts": {
    classification: "exempt",
    reason: "Grant-lead → opportunity creation (new record).",
  },
  "routes/quickbooks/actions.ts": {
    classification: "exempt",
    reason: "QuickBooks approve/mint engine (system ground-truth).",
  },
  "routes/quickbooks/matching.ts": {
    classification: "exempt",
    reason: "QuickBooks matching/mint engine (system ground-truth).",
  },
  "routes/quickbooks/shared.ts": {
    classification: "exempt",
    reason: "QuickBooks revert hard-delete (system reversal of its own mint).",
  },
  "routes/stripe.ts": {
    classification: "exempt",
    reason: "Stripe reconciliation engine mint/revert (system ground-truth).",
  },
  "routes/reconciliation/approve.ts": {
    classification: "exempt",
    reason:
      "Unified reconciler approve: the charge-anchored escape hatch latches an OPEN opportunity into a pledge at mint time (writtenPledge/awardedAmount) — the exact write the exempt mint engine (lib/reconciliationCommit.ts mintGiftInTx) performs on the QB-anchored path; system ground-truth booking, not a human edit of an audited fact.",
  },
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      out.push(...walk(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function relKey(full: string): string {
  return relative(SRC, full).split(sep).join("/");
}

describe("freeze-guard inventory", () => {
  const writers = new Map<string, string>();
  for (const full of walk(SRC)) {
    const src = readFileSync(full, "utf8");
    if (WRITE_RE.test(src) || GENERIC_WRITE_RE.test(src)) {
      writers.set(relKey(full), src);
    }
  }

  it("every gift/pledge/allocation write surface is classified", () => {
    const actual = [...writers.keys()].sort();
    const expected = Object.keys(EXPECTED).sort();
    expect(actual).toEqual(expected);
  });

  it("every guarded file references the freeze guard", () => {
    for (const [rel, meta] of Object.entries(EXPECTED)) {
      if (meta.classification !== "guarded") continue;
      const src = writers.get(rel);
      expect(src, `${rel} is classified guarded but has no write surface`).toBeDefined();
      const usesGuard = GUARD_SYMBOLS.some((symbol) => src!.includes(symbol));
      expect(
        usesGuard,
        `${rel} is classified guarded but never references the freeze guard`,
      ).toBe(true);
    }
  });

  it("every exempt file documents a reason", () => {
    for (const [rel, meta] of Object.entries(EXPECTED)) {
      if (meta.classification !== "exempt") continue;
      expect(meta.reason.trim().length, `${rel} needs an exempt reason`).toBeGreaterThan(0);
    }
  });
});
