from __future__ import annotations

from pathlib import Path
import re
import textwrap


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, text: str) -> None:
    Path(path).write_text(text)


def replace_exact(
    path: str,
    old: str,
    new: str,
    *,
    expected: int = 1,
) -> None:
    text = read(path)
    count = text.count(old)
    if count != expected:
        raise RuntimeError(
            f"Expected {expected} exact matches in {path}; found {count}.\nOLD:\n{old}"
        )
    write(path, text.replace(old, new))


def replace_regex(
    path: str,
    pattern: str,
    replacement: str,
    *,
    expected: int = 1,
    flags: int = 0,
) -> None:
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, flags=flags)
    if count != expected:
        raise RuntimeError(
            f"Expected {expected} regex matches in {path}; found {count}.\nPATTERN:\n{pattern}"
        )
    write(path, updated)


# ---------------------------------------------------------------------------
# 1. Core derivation: payment establishes an ACTUAL gift outcome, but it must
#    never fabricate a prior verbal commitment or overwrite cultivation stage.
# ---------------------------------------------------------------------------
pledge_stage = "artifacts/api-server/src/lib/pledgeStage.ts"
replace_exact(
    pledge_stage,
    '''  if (!isPledge && hasPayment) {
    commitmentPath = "gift";
    verbalCommitmentAt =
      verbalCommitmentAt ?? input.firstPaymentDate ?? actualCompletionDate;
    actualCompletionDate =
      actualCompletionDate ?? input.firstPaymentDate ?? verbalCommitmentAt;
  }
''',
    '''  if (!isPledge && hasPayment) {
    // Money establishes an actual gift outcome. A prior verbal commitment is a
    // separate historical fact and must not be invented from the payment date.
    actualCompletionDate = actualCompletionDate ?? input.firstPaymentDate;
  }
''',
)
replace_exact(
    pledge_stage,
    '''  const hadLifecycle =
    input.commitmentPath != null ||
    input.pledgeCommittedAt != null ||
    input.verbalCommitmentAt != null;
  const legacyOutcomeStage =
    input.stage === "complete" ||
    input.stage === "cash_in" ||
    input.stage === "written_commitment" ||
    input.stage === "conditional_commitment";
  const stage = hadLifecycle
    ? legacyOutcomeStage
      ? LEGACY_COMPLETE_STAGE
      : input.stage
    : status === "pledge" || status === "cash_in"
      ? "complete"
      : input.stage === "complete"
        ? LEGACY_COMPLETE_STAGE
        : input.stage;
''',
    '''  const legacyOutcomeStage =
    input.stage === "complete" ||
    input.stage === "cash_in" ||
    input.stage === "written_commitment" ||
    input.stage === "conditional_commitment";
  // Stage records cultivation progress, not the outcome. Normalize imported
  // outcome-like legacy stages once, then preserve the real funnel position.
  const stage = legacyOutcomeStage ? LEGACY_COMPLETE_STAGE : input.stage;
''',
)
replace_regex(
    pledge_stage,
    r'''/\*\*\n \* Pure derivation of \(status, stage, writtenPledge\).*?\n \*/\nexport function deriveOppFields''',
    '''/**
 * Pure derivation of lifecycle outputs from the stored cultivation facts and
 * linked money.
 *
 * - `pledgeCommittedAt` is the authoritative pledge boundary. The legacy
 *   `writtenPledge` boolean is accepted only as a temporary import fallback and
 *   is emitted as a read-compatible mirror.
 * - Money without a finalized pledge is an actual gift outcome. It does not
 *   manufacture `commitmentPath` or `verbalCommitmentAt`; those fields exist
 *   only when a fundraiser recorded the preceding verbal commitment.
 * - Cultivation `stage` is preserved. Deprecated outcome-like stages are
 *   normalized to `verbal_confirmation`, but pledge finalization and payment do
 *   not overwrite the funnel history.
 * - Fixed pledges complete when paid >= awarded. Cost-reimbursement awards
 *   complete only through the explicit award-close action.
 */
export function deriveOppFields''',
    flags=re.S,
)
replace_exact(
    pledge_stage,
    " * Run after any mutation that touches stage, awardedAmount, lossType,\n * conditional, written_pledge, grantLetterUrl, or after a payment is recorded /\n",
    " * Run after any mutation that touches stage, awardedAmount, lossType,\n * commitment lifecycle fields, grant documentation, or after a payment is recorded /\n",
)

# Unit expectation for a surprise/direct gift: actual gift, no invented verbal fact.
derive_test = "artifacts/api-server/src/__tests__/derive-opp-fields.test.ts"
replace_exact(
    derive_test,
    '''  it("infers a gift outcome when money arrives with no commitment path", () => {
    const result = deriveOppFields({
      ...base,
      paidAmount: 500,
      awardedAmount: 0,
      firstPaymentDate: "2026-07-25",
    });
    expect(result.commitmentPath).toBe("gift");
    expect(result.status).toBe("cash_in");
    expect(result.actualCompletionDate).toBe("2026-07-25");
  });
''',
    '''  it("records a surprise gift outcome without inventing a verbal commitment", () => {
    const result = deriveOppFields({
      ...base,
      paidAmount: 500,
      awardedAmount: 0,
      firstPaymentDate: "2026-07-25",
    });
    expect(result.commitmentPath).toBeNull();
    expect(result.verbalCommitmentAt).toBeNull();
    expect(result.status).toBe("cash_in");
    expect(result.stage).toBe("in_conversation");
    expect(result.actualCompletionDate).toBe("2026-07-25");
  });
''',
)

# ---------------------------------------------------------------------------
# 2. Migration: preserve only facts the historical data actually proves.
# ---------------------------------------------------------------------------
migration = "lib/db/migrations/0224_opportunity_commitment_lifecycle.sql"
replace_exact(
    migration,
    '''UPDATE opportunities_and_pledges o
SET
  commitment_path = 'gift'::opportunity_commitment_path,
  verbal_commitment_at = COALESCE(
    o.verbal_commitment_at,
    g.first_payment_date,
    o.actual_completion_date,
    o.created_at::date
  ),
  actual_completion_date = COALESCE(
    o.actual_completion_date,
    g.first_payment_date
  )
FROM gift_outcomes g
WHERE g.opportunity_id = o.id
  AND g.total_paid > 0
  AND o.pledge_committed_at IS NULL;
''',
    '''UPDATE opportunities_and_pledges o
SET actual_completion_date = COALESCE(
  o.actual_completion_date,
  g.first_payment_date
)
FROM gift_outcomes g
WHERE g.opportunity_id = o.id
  AND g.total_paid > 0
  AND o.pledge_committed_at IS NULL;
''',
)
replace_exact(
    migration,
    '''UPDATE opportunities_and_pledges
SET stage = 'verbal_confirmation'
WHERE stage IN (
    'complete',
    'cash_in',
    'written_commitment',
    'conditional_commitment'
  )
  AND (
    commitment_path IS NOT NULL
    OR pledge_committed_at IS NOT NULL
    OR paid > 0
  );
''',
    '''UPDATE opportunities_and_pledges
SET stage = 'verbal_confirmation'
WHERE stage IN (
  'complete',
  'cash_in',
  'written_commitment',
  'conditional_commitment'
);
''',
)

# ---------------------------------------------------------------------------
# 3. Reconciliation: money may pay a finalized pledge or create a direct gift.
#    It can never convert an unfinalized opportunity into a pledge.
# ---------------------------------------------------------------------------
recon_commit = "artifacts/api-server/src/lib/reconciliationCommit.ts"
replace_exact(
    recon_commit,
    '''  /** Latch the opportunity into a pledge (open-only → written_commitment). */
  convert: boolean;
''',
    "",
)
replace_exact(recon_commit, "    convert,\n", "")
replace_regex(
    recon_commit,
    r'''\n  // convert: latch the opportunity into a pledge.*?\n  // Mint the gift HEADER\.''',
    '''
  // The opportunity's lifecycle is not rewritten here. If it was already a
  // finalized pledge, this gift is a pledge payment; otherwise the arriving
  // money is a direct gift produced by the opportunity.

  // Mint the gift HEADER.''',
    flags=re.S,
)
replace_exact(
    recon_commit,
    "    // The opp outcomes tie the gift to the\n  // opportunity via opportunityId so the pledge derives cash_in when fully paid.\n",
    "    // The opportunity outcome ties the gift to the source record. A finalized\n  // pledge derives paid/cash-in; an unfinalized opportunity records a direct gift.\n",
)

approve = "artifacts/api-server/src/routes/reconciliation/approve.ts"
replace_regex(
    approve,
    r'''interface MintOpts \{.*?\n\}\n\n/\*\*''',
    '''interface MintOpts {
  /** The create-* outcome being applied; echoed back in the response + audit. */
  outcome: "create_gift" | "create_gift_from_opportunity";
  /** Require + lock an opportunity, and DERIVE the gift donor from it. */
  requireOpportunity: boolean;
}

/**''',
    flags=re.S,
)
replace_exact(
    approve,
    ''' * Shared in-tx mint path for the three create-* approve outcomes (create_gift,
 * create_gift_from_opportunity, convert_to_pledge_and_first_payment). Minting is
''',
    ''' * Shared in-tx mint path for the two create-* approve outcomes (create_gift
 * and create_gift_from_opportunity). Minting is
''',
)
replace_regex(
    approve,
    r'''\n \*   - convert_to_pledge_and_first_payment:.*?\n \*/\nasync function mintGiftFromEvidence''',
    '''
 * An unfinalized opportunity always produces a direct gift. A payment is treated
 * as a pledge payment only when the selected record was finalized previously
 * through the pledge workflow.
 */
async function mintGiftFromEvidence''',
    flags=re.S,
)
replace_regex(
    approve,
    r'''\n      // convert_to_pledge_and_first_payment is an OPEN→pledge transition:.*?\n      let charge:''',
    '''
      let charge:''',
    flags=re.S,
)
replace_regex(
    approve,
    r'''\n        // convert: latch the OPEN opportunity into a pledge exactly like the.*?\n        await createGiftFromChargeInTx''',
    '''
        await createGiftFromChargeInTx''',
    flags=re.S,
)
replace_exact(approve, "        convert: opts.convert,\n", "")
replace_exact(
    approve,
    '''  // Re-derive the opportunity from the committed gift amounts (the new payment, or
  // the latched pledge, shifts its derived status/paid totals + latches
  // was_pledge). Runs outside the tx on its own connection.
''',
    '''  // Re-derive the opportunity from committed gift amounts. This updates paid
  // and the actual gift/pledge outcome without changing commitment history.
''',
)
replace_exact(approve, "    createdPledge: opts.createdPledge,\n", "    createdPledge: false,\n")
replace_exact(
    approve,
    '''// QB staged amount. The opportunity outcomes (create_gift_from_opportunity /
// convert_to_pledge_and_first_payment) are added in E5.
''',
    '''// QB staged amount. An opportunity target either receives a payment on an
// already-finalized pledge or produces a direct gift.
''',
)
replace_exact(
    approve,
    '''    // The three create-* outcomes all MINT a new gift from the QB evidence
    // (human-only); they share one in-tx helper. link_existing_gift falls through
    // to the linker below. create_gift uses the human-chosen body donor; the two
    // opportunity outcomes derive the donor from the chosen opp.
''',
    '''    // The two create-* outcomes MINT a new gift from the QB evidence and
    // share one in-tx helper. create_gift uses the chosen body donor;
    // create_gift_from_opportunity derives the donor from the selected record.
''',
)
replace_exact(
    approve,
    '''        outcome: "create_gift",
        requireOpportunity: false,
        convert: false,
        createdPledge: false,
''',
    '''        outcome: "create_gift",
        requireOpportunity: false,
''',
)
replace_exact(
    approve,
    '''        outcome: "create_gift_from_opportunity",
        requireOpportunity: true,
        convert: false,
        createdPledge: false,
''',
    '''        outcome: "create_gift_from_opportunity",
        requireOpportunity: true,
''',
)
replace_regex(
    approve,
    r'''\n    if \(body\.outcome === "convert_to_pledge_and_first_payment"\) \{.*?\n    \}\n\n    // ── link_existing_gift''',
    '''

    // ── link_existing_gift''',
    flags=re.S,
)
if "opts.convert" in read(approve) or "convert_to_pledge_and_first_payment" in read(approve):
    raise RuntimeError("Obsolete pledge-conversion reconciliation path remains")

# ---------------------------------------------------------------------------
# 4. Web reconciliation: no booking-choice dialog; arriving money is direct
#    unless the selected record is already a finalized pledge.
# ---------------------------------------------------------------------------
recon_client = "artifacts/wildflower-crm/src/lib/reconciliation.ts"
replace_exact(
    recon_client,
    '''export type OutcomeChoice =
  | "create_gift_from_opportunity"
  | "convert_to_pledge_and_first_payment";
''',
    '''export type OutcomeChoice = "create_gift_from_opportunity";
''',
)
replace_exact(
    recon_client,
    '''      summary:
        outcomeChoice === "convert_to_pledge_and_first_payment"
          ? `Convert “${opportunity.label}” to a pledge and record this as the first payment.`
          : `Create a one-time gift from opportunity “${opportunity.label}”.`,
''',
    '''      summary: `Record the arriving money from “${opportunity.label}”. It is a pledge payment only if the pledge was finalized before the payment arrived.`,
''',
)

recon_page = "artifacts/wildflower-crm/src/pages/reconciliation-deposits.tsx"
replace_exact(recon_page, "  type OutcomeChoice,\n", "")
replace_exact(
    recon_page,
    '''  const [oppOutcomeFor, setOppOutcomeFor] =
    useState<OpportunityOrPledge | null>(null);
''',
    "",
)
replace_exact(
    recon_page,
    '''  const handleLinkEvidenceOpp = async (
    opp: OpportunityOrPledge,
    choice?: OutcomeChoice,
  ) => {
''',
    '''  const handleLinkEvidenceOpp = async (opp: OpportunityOrPledge) => {
''',
)
replace_regex(
    recon_page,
    r'''\n    // An OPEN opportunity has two booking outcomes — ask the human which one\..*?\n    try \{\n      const done = await approveStagedAgainst\(\n        target\.anchor\.id,\n        \{ opp \},\n        outcome,\n      \);''',
    '''
    try {
      const done = await approveStagedAgainst(
        target.anchor.id,
        { opp },
        "create_gift_from_opportunity",
      );''',
    flags=re.S,
)
replace_exact(recon_page, "      setOppOutcomeFor(null);\n", "")
replace_exact(
    recon_page,
    '''        title:
          outcome === "convert_to_pledge_and_first_payment"
            ? "Pledge created with first payment"
            : "Payment recorded",
''',
    '''        title: opp.pledgeCommittedAt
          ? "Pledge payment recorded"
          : "Gift recorded",
''',
)
replace_regex(
    recon_page,
    r'''\n      <AlertDialog\n        open=\{oppOutcomeFor != null\}.*?\n      </AlertDialog>''',
    "",
    flags=re.S,
)
for obsolete in ("oppOutcomeFor", "setOppOutcomeFor", "convert_to_pledge_and_first_payment"):
    if obsolete in read(recon_page):
        raise RuntimeError(f"Obsolete reconciliation UI symbol remains: {obsolete}")

# ---------------------------------------------------------------------------
# 5. Historical correction routes create real finalized VERBAL pledges with a
#    reconstructed schedule; attaching payments requires a finalized pledge.
# ---------------------------------------------------------------------------
gifts_route = "artifacts/api-server/src/routes/giftsAndPayments.ts"
replace_exact(
    gifts_route,
    "  pledgeAllocations,\n  bulkOperations,\n",
    "  pledgeAllocations,\n  pledgeExpectedPayments,\n  bulkOperations,\n",
)
replace_exact(
    gifts_route,
    '''            householdId: opportunitiesAndPledges.householdId,
          })
''',
    '''            householdId: opportunitiesAndPledges.householdId,
            commitmentPath: opportunitiesAndPledges.commitmentPath,
            pledgeCommittedAt: opportunitiesAndPledges.pledgeCommittedAt,
            writtenPledge: opportunitiesAndPledges.writtenPledge,
            archivedAt: opportunitiesAndPledges.archivedAt,
            lossType: opportunitiesAndPledges.lossType,
          })
''',
)
replace_exact(
    gifts_route,
    '''        if (!pledge) {
          return {
            ok: false,
            status: 409,
            json: { error: "pledge_not_found", message: "Target pledge not found." },
          };
        }
''',
    '''        if (!pledge) {
          return {
            ok: false,
            status: 409,
            json: { error: "pledge_not_found", message: "Target pledge not found." },
          };
        }
        const finalizedPledge =
          pledge.pledgeCommittedAt != null ||
          (pledge.commitmentPath == null && pledge.writtenPledge === true);
        if (!finalizedPledge) {
          return {
            ok: false,
            status: 409,
            json: {
              error: "not_finalized_pledge",
              message:
                "Finalize this written or verbal pledge before attaching payments to it.",
            },
          };
        }
        if (pledge.archivedAt != null || pledge.lossType != null) {
          return {
            ok: false,
            status: 409,
            json: {
              error: "pledge_not_active",
              message:
                "Restore or reopen this pledge before attaching payments to it.",
            },
          };
        }
''',
)
replace_exact(
    gifts_route,
    '''        await tx.insert(opportunitiesAndPledges).values({
          id: pledgeId,
          name: body.name ?? null,
          organizationId: donor.organizationId,
          individualGiverPersonId: donor.individualGiverPersonId,
          householdId: donor.householdId,
          awardedAmount: summedAmount,
          // Cultivation stage is a pure funnel now; the commitment outcome is the
          // writtenPledge latch. applyDerivedOppFieldsMany below advances stage to
          // `complete` (won) and derives status/paid — never written by hand.
          stage: "verbal_confirmation",
          writtenPledge: true,
          // Inherit loan-vs-grant from the source gift(s) so loan-fund money
          // doesn't create a grant pledge; if any source gift is loan the
          // pledge is loan.
          loanOrGrant: gifts.some((g) => g.loanOrGrant === "loan") ? "loan" : "grant",
        });
''',
    '''        const commitmentDate =
          gifts
            .map((g) => g.dateReceived)
            .filter((date): date is string => date != null)
            .sort()[0] ?? todayInChicago();
        await tx.insert(opportunitiesAndPledges).values({
          id: pledgeId,
          name: body.name ?? null,
          organizationId: donor.organizationId,
          individualGiverPersonId: donor.individualGiverPersonId,
          householdId: donor.householdId,
          awardedAmount: summedAmount,
          stage: "verbal_confirmation",
          commitmentPath: "verbal_pledge",
          verbalCommitmentAt: commitmentDate,
          pledgeCommittedAt: commitmentDate,
          writtenPledge: true,
          // This correction reconstructs a historical pledge from received
          // gifts. Without a pledge document, it is explicitly a verbal pledge.
          loanOrGrant: gifts.some((g) => g.loanOrGrant === "loan") ? "loan" : "grant",
        });
''',
)
replace_exact(
    gifts_route,
    '''        await tx.insert(pledgeAllocations).values({
          id: newId(),
          pledgeOrOpportunityId: pledgeId,
          subAmount: summedAmount,
        });
''',
    '''        await tx.insert(pledgeAllocations).values({
          id: newId(),
          pledgeOrOpportunityId: pledgeId,
          subAmount: summedAmount,
          status: "committed",
        });
        for (const gift of gifts) {
          if (Number(gift.amount ?? 0) <= 0) continue;
          await tx.insert(pledgeExpectedPayments).values({
            id: newId(),
            pledgeId,
            expectedDate: gift.dateReceived ?? commitmentDate,
            amount: gift.amount,
          });
        }
''',
)
replace_exact(
    gifts_route,
    '''      // 1. Create the pledge: awarded = gift amount, donor inherited.
      const pledgeId = newId();
      await tx.insert(opportunitiesAndPledges).values({
        id: pledgeId,
        name: body.name ?? gift.name ?? null,
        organizationId: donor.organizationId,
        individualGiverPersonId: donor.individualGiverPersonId,
        householdId: donor.householdId,
        awardedAmount: gift.amount,
        // Cultivation stage is a pure funnel now; the commitment outcome is the
        // writtenPledge latch. Derived fields (status/stage→complete/paid) are
        // recomputed afterward — never written by hand (invariant #3).
        stage: "verbal_confirmation",
        writtenPledge: true,
        // Inherit loan-vs-grant from the source gift so a loan-fund gift
        // doesn't create a grant pledge.
        loanOrGrant: gift.loanOrGrant,
      });
''',
    '''      // 1. Reconstruct a finalized verbal pledge from the received gift.
      const pledgeId = newId();
      const commitmentDate = gift.dateReceived ?? todayInChicago();
      await tx.insert(opportunitiesAndPledges).values({
        id: pledgeId,
        name: body.name ?? gift.name ?? null,
        organizationId: donor.organizationId,
        individualGiverPersonId: donor.individualGiverPersonId,
        householdId: donor.householdId,
        awardedAmount: gift.amount,
        stage: "verbal_confirmation",
        commitmentPath: "verbal_pledge",
        verbalCommitmentAt: commitmentDate,
        pledgeCommittedAt: commitmentDate,
        writtenPledge: true,
        // Inherit loan-vs-grant from the source gift so a loan-fund gift
        // doesn't create a grant pledge.
        loanOrGrant: gift.loanOrGrant,
      });
''',
)
replace_exact(
    gifts_route,
    '''      // 3. Transform-in-place. The original gift becomes the payment for the
''',
    '''      for (const allocation of allocs) {
        await tx.insert(pledgeExpectedPayments).values({
          id: newId(),
          pledgeId,
          expectedDate: gift.dateReceived ?? commitmentDate,
          amount: allocation.subAmount,
        });
      }

      // 3. Transform-in-place. The original gift becomes the payment for the
''',
)
replace_exact(
    gifts_route,
    '''      // 1. Mint the opportunity / pledge. Awarded = gift amount, donor inherited.
      // Cultivation stage is a pure funnel; the commitment outcome is the
      // writtenPledge latch. Derived fields (status/stage) are recomputed
      // afterward — never written by hand (invariant #3).
      const opportunityId = newId();
      await tx.insert(opportunitiesAndPledges).values({
        id: opportunityId,
        name: body.name ?? gift.name ?? null,
        organizationId: donor.organizationId,
        individualGiverPersonId: donor.individualGiverPersonId,
        householdId: donor.householdId,
        awardedAmount: gift.amount,
        stage: asPledge ? "verbal_confirmation" : "in_conversation",
        writtenPledge: asPledge,
        // Inherit loan-vs-grant from the source gift.
        loanOrGrant: gift.loanOrGrant,
      });
''',
    '''      // 1. Mint the opportunity. When the correction explicitly asks for a
      // pledge, reconstruct a finalized verbal pledge and its expected payment;
      // a written pledge cannot be asserted without a document.
      const opportunityId = newId();
      const commitmentDate = gift.dateReceived ?? todayInChicago();
      await tx.insert(opportunitiesAndPledges).values({
        id: opportunityId,
        name: body.name ?? gift.name ?? null,
        organizationId: donor.organizationId,
        individualGiverPersonId: donor.individualGiverPersonId,
        householdId: donor.householdId,
        awardedAmount: gift.amount,
        stage: asPledge ? "verbal_confirmation" : "in_conversation",
        ...(asPledge
          ? {
              commitmentPath: "verbal_pledge" as const,
              verbalCommitmentAt: commitmentDate,
              pledgeCommittedAt: commitmentDate,
              writtenPledge: true,
            }
          : {}),
        // Inherit loan-vs-grant from the source gift.
        loanOrGrant: gift.loanOrGrant,
      });
''',
)
replace_exact(
    gifts_route,
    '''      // 3. Archive the source gift (non-destructive — the gift and its
''',
    '''      if (asPledge && Number(gift.amount ?? 0) > 0) {
        await tx.insert(pledgeExpectedPayments).values({
          id: newId(),
          pledgeId: opportunityId,
          expectedDate: gift.dateReceived ?? commitmentDate,
          amount: gift.amount,
        });
      }

      // 3. Archive the source gift (non-destructive — the gift and its
''',
)
replace_exact(
    gifts_route,
    "// (non-destructive). asPledge=true → a written PLEDGE; false → an open\n",
    "// (non-destructive). asPledge=true → a finalized VERBAL pledge; false → an open\n",
)

# ---------------------------------------------------------------------------
# 6. Write-offs remain correction records, but carry real pledge authority so
#    they appear in pledge views and do not depend on the legacy boolean.
# ---------------------------------------------------------------------------
opps_route = "artifacts/api-server/src/routes/opportunitiesAndPledges.ts"
replace_exact(
    opps_route,
    '''      if (!original.writtenPledge) {
        return fail(409, {
          error: "invalid_write_off_target",
          message: "Only a written pledge can be written off.",
        });
      }
''',
    '''      const finalizedPledge =
        original.pledgeCommittedAt != null ||
        (original.commitmentPath == null && original.writtenPledge === true);
      if (!finalizedPledge) {
        return fail(409, {
          error: "invalid_write_off_target",
          message: "Only a finalized written or verbal pledge can be written off.",
        });
      }
''',
)
replace_exact(
    opps_route,
    '''      await tx.insert(opportunitiesAndPledges).values({
        id: writeOffId,
        name: original.name ? `Write-off — ${original.name}` : "Write-off",
        // Donor XOR: copy all three FKs (exactly one is non-null on the source).
        organizationId: original.organizationId,
        individualGiverPersonId: original.individualGiverPersonId,
        householdId: original.householdId,
        writtenPledge: true,
        isWriteOff: true,
        writeOffOfPledgeId: id,
        awardedAmount: (-amount).toFixed(2),
        // Recognised today, which falls inside the open FY window — keeps the
        // write-off itself governed by an open (mutable) FY.
        actualCompletionDate: todayInChicago(),
        loanOrGrant: original.loanOrGrant,
        usageNotes: body.reason ?? null,
      });
''',
    '''      const recognitionDate = todayInChicago();
      const writeOffCommitmentPath =
        original.commitmentPath === "written_pledge" && original.grantLetterUrl
          ? "written_pledge"
          : "verbal_pledge";
      await tx.insert(opportunitiesAndPledges).values({
        id: writeOffId,
        name: original.name ? `Write-off — ${original.name}` : "Write-off",
        // Donor XOR: copy all three FKs (exactly one is non-null on the source).
        organizationId: original.organizationId,
        individualGiverPersonId: original.individualGiverPersonId,
        householdId: original.householdId,
        stage: "verbal_confirmation",
        commitmentPath: writeOffCommitmentPath,
        verbalCommitmentAt:
          original.verbalCommitmentAt ??
          original.pledgeCommittedAt ??
          recognitionDate,
        pledgeCommittedAt: recognitionDate,
        writtenPledge: true,
        ...(writeOffCommitmentPath === "written_pledge"
          ? {
              grantLetterUrl: original.grantLetterUrl,
              grantLetterFilename: original.grantLetterFilename,
              grantLetterUploadedAt: original.grantLetterUploadedAt,
            }
          : {}),
        isWriteOff: true,
        writeOffOfPledgeId: id,
        awardedAmount: (-amount).toFixed(2),
        // Recognised today, which falls inside the open FY window — keeps the
        // write-off itself governed by an open (mutable) FY.
        actualCompletionDate: recognitionDate,
        loanOrGrant: original.loanOrGrant,
        usageNotes: body.reason ?? null,
      });
''',
)
replace_exact(
    opps_route,
    '''    // Derive status/stage/win_probability on the new write-off. writtenPledge is
    // sticky-true (never cleared) so it derives as status='pledge'; the negative
    // awarded amount keeps it out of cash_in (which needs awarded > 0).
''',
    '''    // Derive status/win probability on the finalized correction pledge. The
    // negative awarded amount keeps it out of cash_in (which needs awarded > 0).
''',
)
replace_exact(
    opps_route,
    "// under-paid written pledge. The audited original is NEVER mutated — a\n",
    "// under-paid finalized pledge. The audited original is NEVER mutated — a\n",
)

# ---------------------------------------------------------------------------
# 7. API contract and schema documentation.
# ---------------------------------------------------------------------------
openapi = "lib/api-spec/openapi.yaml"
replace_regex(
    openapi,
    r'''    OpportunityStatus:\n      type: string\n      enum: \[open, pledge, cash_in, dormant, lost\]\n      description: \|\n.*?\n    OpportunityLossType:''',
    '''    OpportunityStatus:
      type: string
      enum: [open, pledge, cash_in, dormant, lost]
      description: |
        Read-only lifecycle status derived from lossType, pledgeCommittedAt,
        linked money, awarded amount, and the disbursement model:
          lossType set                         → dormant or lost
          finalized pledge, not fully collected → pledge
          fully collected pledge               → cash_in
          direct gift fully received            → cash_in
          otherwise                             → open
        A pledge exists only when pledgeCommittedAt is populated. The deprecated
        writtenPledge field is a read-only compatibility mirror.
    OpportunityLossType:''',
    flags=re.S,
)
replace_regex(
    openapi,
    r'''    OpportunityStage:\n      type: string\n      enum: \[cold_lead, warm_lead, in_conversation, convince, conditional_commitment, probable_renewal, verbal_confirmation, written_commitment, cash_in, complete\]\n      description: \|\n.*?\n    OpportunityConditional:''',
    '''    OpportunityStage:
      type: string
      enum: [cold_lead, warm_lead, in_conversation, convince, conditional_commitment, probable_renewal, verbal_confirmation, written_commitment, cash_in, complete]
      description: |
        Cultivation funnel position, separate from commitment and actual outcome.
        Active stages end at verbal_confirmation. Pledge finalization and payment
        do not overwrite the recorded stage. conditional_commitment,
        written_commitment, cash_in, and complete remain only for historical API
        compatibility and are normalized to verbal_confirmation by migration 0224.
    OpportunityConditional:''',
    flags=re.S,
)
replace_regex(
    openapi,
    r'''    ReconciliationOutcome:\n      type: string\n      enum: \[link_existing_gift, create_gift, create_gift_from_opportunity, convert_to_pledge_and_first_payment\]\n      description: \|\n.*?\n    ApproveCompleteMatchBody:''',
    '''    ReconciliationOutcome:
      type: string
      enum: [link_existing_gift, create_gift, create_gift_from_opportunity]
      description: |
        What approving the card does.
        link_existing_gift: tie the evidence to an existing gift; no new gift.
        create_gift: mint a new gift from evidence for the chosen donor.
        create_gift_from_opportunity: record arriving money from the selected
        opportunity. It is a pledge payment only when pledgeCommittedAt was set
        before the payment arrived; otherwise it is a direct gift outcome.
    ApproveCompleteMatchBody:''',
    flags=re.S,
)
replace_exact(
    openapi,
    '        asPledge: { type: boolean, default: false, description: "When true the new record is a written PLEDGE (writtenPledge=true); otherwise an open opportunity." }\n',
    '        asPledge: { type: boolean, default: false, description: "When true, reconstruct a finalized verbal pledge with a payment schedule from the archived gift; otherwise create an open opportunity." }\n',
)
if "convert_to_pledge_and_first_payment" in read(openapi):
    raise RuntimeError("Retired reconciliation pledge-conversion outcome remains in OpenAPI")

schema_file = "lib/db/src/schema/opportunitiesAndPledges.ts"
replace_regex(
    schema_file,
    r'''// `was_pledge` \(boolean, sticky-true\).*?//\n// Partial indexes below''',
    '''// Commitment lifecycle is explicit: commitmentPath + verbalCommitmentAt
// record what the donor verbally confirmed; pledgeCommittedAt is the sole
// boundary that establishes a pledge. writtenPledge is retained only as a
// read-compatible mirror during migration of legacy readers.
//
// Partial indexes below''',
    flags=re.S,
)
replace_exact(
    schema_file,
    '''    // Grant letter (foundation pledge documentation). Lives in object
    // storage; only the URL is stored. Uploading flips written_pledge=true.
''',
    '''    // Pledge document (historically named grant letter). Uploading the file
    // does not establish a pledge; written pledges are finalized explicitly
    // after the document and pledge plan are complete.
''',
)
replace_exact(
    schema_file,
    "    // an audited (frozen) written pledge is under-paid and its money can no longer\n",
    "    // an audited (frozen) finalized pledge is under-paid and its money can no longer\n",
)

# ---------------------------------------------------------------------------
# 8. Integration tests: authenticate cleanly, retire old outcome tests, and
#    assert lifecycle authority/schedules on correction-created pledges.
# ---------------------------------------------------------------------------
clerk_mock = '''
vi.mock("@clerk/express", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clerk/express")>();
  return {
    ...actual,
    clerkMiddleware:
      () =>
      (_req: unknown, _res: unknown, next: () => void): void =>
        next(),
  };
});
'''

recon_test = "artifacts/api-server/src/__tests__/reconciliation-approve.integration.test.ts"
text = read(recon_test)
if 'vi.mock("@clerk/express"' not in text:
    marker = "\nconst RUN = `reconapv_${Date.now()}`;"
    if marker not in text:
        raise RuntimeError("Reconciliation test setup marker not found")
    text = text.replace(marker, clerk_mock + marker, 1)
# Seed helper supports authoritative lifecycle fields.
text, count = re.subn(
    r'''async function seedOpp\(opts: \{.*?\n\}\nasync function readOpp''',
    '''async function seedOpp(opts: {
  stage:
    | "in_conversation"
    | "verbal_confirmation"
    | "conditional_commitment"
    | "written_commitment"
    | "cash_in"
    | "complete";
  status?: "open" | "pledge" | "cash_in" | "dormant" | "lost";
  awardedAmount?: string | null;
  writtenPledge?: boolean;
  commitmentPath?: "gift" | "written_pledge" | "verbal_pledge" | null;
  verbalCommitmentAt?: string | null;
  pledgeCommittedAt?: string | null;
  grantLetterUrl?: string | null;
  lossType?: "dormant" | "lost" | null;
}): Promise<string> {
  const id = nextId("opp");
  await db.insert(schema.opportunitiesAndPledges).values({
    id,
    name: `Opp ${id}`,
    organizationId: ORG_ID,
    stage: opts.stage,
    ...(opts.status ? { status: opts.status } : {}),
    awardedAmount: opts.awardedAmount ?? null,
    commitmentPath: opts.commitmentPath ?? null,
    verbalCommitmentAt: opts.verbalCommitmentAt ?? null,
    pledgeCommittedAt: opts.pledgeCommittedAt ?? null,
    grantLetterUrl: opts.grantLetterUrl ?? null,
    writtenPledge: opts.writtenPledge ?? opts.pledgeCommittedAt != null,
    lossType: opts.lossType ?? null,
  });
  oppIds.push(id);
  return id;
}
async function readOpp''',
    text,
    flags=re.S,
)
if count != 1:
    raise RuntimeError(f"Could not replace seedOpp helper; found {count}")
# All pledge fixtures in this suite use a finalized verbal pledge unless a test
# intentionally seeds a legacy row.
text = text.replace(
    '''      stage: "written_commitment",
      writtenPledge: true,
''',
    '''      stage: "verbal_confirmation",
      commitmentPath: "verbal_pledge",
      verbalCommitmentAt: "2026-03-01",
      pledgeCommittedAt: "2026-03-01",
      writtenPledge: true,
''',
)
text = text.replace('expect(opp.stage).toBe("complete");', 'expect(opp.stage).toBe("verbal_confirmation");')
# Remove the obsolete conversion tests and replace them with the two governing
# behaviors: direct gift from open opp, and old-client outcome rejection.
first_convert = text.find('  it("convert_to_pledge_and_first_payment')
if first_convert < 0:
    raise RuntimeError("Obsolete conversion tests were not found")
removed = 0
while True:
    start = text.find('  it("convert_to_pledge_and_first_payment')
    if start < 0:
        break
    next_test = text.find("\n\n  it(", start + 4)
    describe_end = text.find("\n});", start + 4)
    candidates = [x for x in (next_test, describe_end) if x >= 0]
    if not candidates:
        raise RuntimeError("Could not find end of conversion test")
    end = min(candidates)
    text = text[:start] + text[end + 2 :]
    removed += 1
if removed < 4:
    raise RuntimeError(f"Expected several obsolete conversion tests; removed {removed}")
insert_marker = '  it("create_gift_from_opportunity requires an opportunityId (validation_error)", async () => {'
if insert_marker not in text:
    raise RuntimeError("Opportunity test insertion marker not found")
new_tests = '''  it("records arriving money from an open opportunity as a direct gift, not a pledge", async () => {
    const oppId = await seedOpp({
      stage: "in_conversation",
      awardedAmount: "100.00",
    });
    const stagedId = await seedStaged("100.00");

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift_from_opportunity",
      opportunityId: oppId,
    });
    expect(res.status).toBe(201);
    giftIds.push(res.json.giftId as string);

    const opp = await readOpp(oppId);
    expect(opp.status).toBe("cash_in");
    expect(opp.stage).toBe("in_conversation");
    expect(opp.commitmentPath).toBeNull();
    expect(opp.verbalCommitmentAt).toBeNull();
    expect(opp.pledgeCommittedAt).toBeNull();
    expect(opp.writtenPledge).toBe(false);
    expect(opp.actualCompletionDate).toBe("2026-03-15");
  }, 30_000);

  it("rejects the retired convert-to-pledge reconciliation outcome", async () => {
    const oppId = await seedOpp({
      stage: "in_conversation",
      awardedAmount: "100.00",
    });
    const stagedId = await seedStaged("100.00");

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "convert_to_pledge_and_first_payment",
      opportunityId: oppId,
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("validation_error");
    expect((await readStaged(stagedId)).status).toBe("pending");
    const opp = await readOpp(oppId);
    expect(opp.pledgeCommittedAt).toBeNull();
    expect(opp.writtenPledge).toBe(false);
  }, 30_000);

'''
text = text.replace(insert_marker, new_tests + insert_marker, 1)
write(recon_test, text)

# Audit-close tests use real finalized pledge authority and verify the child.
audit_test = "artifacts/api-server/src/__tests__/audit-close-resolution.integration.test.ts"
text = read(audit_test)
if 'vi.mock("@clerk/express"' not in text:
    marker = "\n// ── 1. Pure helper: proRataNegativeShares"
    if marker not in text:
        raise RuntimeError("Audit test setup marker not found")
    text = text.replace(marker, clerk_mock + marker, 1)
text = text.replace(
    '''    writtenPledge: opts.writtenPledge ?? false,
    isWriteOff: opts.isWriteOff ?? false,
    actualCompletionDate: opts.actualCompletionDate ?? null,
''',
    '''    ...(opts.writtenPledge
      ? {
          commitmentPath: "verbal_pledge" as const,
          verbalCommitmentAt:
            opts.actualCompletionDate ?? todayChicago(),
          pledgeCommittedAt:
            opts.actualCompletionDate ?? todayChicago(),
          writtenPledge: true,
        }
      : { writtenPledge: false }),
    isWriteOff: opts.isWriteOff ?? false,
    actualCompletionDate: opts.actualCompletionDate ?? null,
''',
)
text = text.replace(
    'it("409 invalid_write_off_target when the target is not a written pledge",',
    'it("409 invalid_write_off_target when the target is not a finalized pledge",',
)
happy_marker = '''    expect(writeOff.isWriteOff).toBe(true);
'''
if happy_marker not in text:
    raise RuntimeError("Audit write-off assertion marker not found")
text = text.replace(
    happy_marker,
    happy_marker
    + '''    expect(writeOff.commitmentPath).toBe("verbal_pledge");
    expect(writeOff.pledgeCommittedAt).toBe(todayChicago());
    expect(writeOff.writtenPledge).toBe(true);
''',
    1,
)
write(audit_test, text)

# Gift revert test: finalized verbal pledge + reconstructed schedule.
revert_test = "artifacts/api-server/src/__tests__/gift-revert-to-opportunity.integration.test.ts"
text = read(revert_test)
if 'vi.mock("@clerk/express"' not in text:
    marker = "\ntype Db = typeof import(\"@workspace/db\");"
    if marker not in text:
        raise RuntimeError("Gift revert test setup marker not found")
    text = text.replace(marker, clerk_mock + marker, 1)
text = text.replace(
    "  pledgeAllocations: Db[\"pledgeAllocations\"];\n",
    "  pledgeAllocations: Db[\"pledgeAllocations\"];\n  pledgeExpectedPayments: Db[\"pledgeExpectedPayments\"];\n",
    1,
)
text = text.replace(
    "    pledgeAllocations: dbMod.pledgeAllocations,\n",
    "    pledgeAllocations: dbMod.pledgeAllocations,\n    pledgeExpectedPayments: dbMod.pledgeExpectedPayments,\n",
    1,
)
text = text.replace(
    '''    stage: "verbal_confirmation",
    writtenPledge: true,
    awardedAmount: "400.00",
''',
    '''    stage: "verbal_confirmation",
    commitmentPath: "verbal_pledge",
    verbalCommitmentAt: "2099-04-01",
    pledgeCommittedAt: "2099-04-01",
    writtenPledge: true,
    awardedAmount: "400.00",
''',
    1,
)
cleanup_marker = '''  if (mintedOppIds.length) {
    await db
      .delete(schema.pledgeAllocations)
'''
if cleanup_marker not in text:
    raise RuntimeError("Gift revert cleanup marker not found")
text = text.replace(
    cleanup_marker,
    '''  if (mintedOppIds.length) {
    await db
      .delete(schema.pledgeExpectedPayments)
      .where(
        inArrayFn(schema.pledgeExpectedPayments.pledgeId, mintedOppIds),
      );
    await db
      .delete(schema.pledgeAllocations)
''',
    1,
)
text = text.replace(
    'it("asPledge=true mints a WRITTEN pledge whose derived status is \'pledge\'",',
    'it("asPledge=true reconstructs a finalized verbal pledge and schedule",',
)
text = text.replace(
    '''    expect(opp.writtenPledge).toBe(true);
    // Derivation promotes a won pledge's funnel stage to terminal 'complete'.
    expect(opp.stage).toBe("complete");
    expect(opp.status).toBe("pledge"); // derived from the writtenPledge latch
    expect(opp.name).toBe(`GiftRevert as pledge ${RUN}`);
''',
    '''    expect(opp.commitmentPath).toBe("verbal_pledge");
    expect(opp.verbalCommitmentAt).toBe("2099-05-02");
    expect(opp.pledgeCommittedAt).toBe("2099-05-02");
    expect(opp.writtenPledge).toBe(true);
    expect(opp.stage).toBe("verbal_confirmation");
    expect(opp.status).toBe("pledge");
    expect(opp.name).toBe(`GiftRevert as pledge ${RUN}`);
    const expected = await db
      .select()
      .from(schema.pledgeExpectedPayments)
      .where(eqFn(schema.pledgeExpectedPayments.pledgeId, opp.id));
    expect(expected).toHaveLength(1);
    expect(expected[0]?.expectedDate).toBe("2099-05-02");
    expect(expected[0]?.amount).toBe("250.00");
''',
    1,
)
write(revert_test, text)

# A compact route suite for the merge/split historical reconstruction paths.
reconstruction_test = "artifacts/api-server/src/__tests__/opportunity-commitment-reconstruction.integration.test.ts"
write(
    reconstruction_test,
    textwrap.dedent(
        r'''
        import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
        import type { AddressInfo } from "node:net";
        import type { Server } from "node:http";

        const RAW_DB_URL = process.env.DATABASE_URL;
        const HAS_DB =
          !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
        const RUN = `opp_reconstruct_${Date.now()}`;
        const USER_ID = `${RUN}_user`;
        const ORG_ID = `${RUN}_org`;

        vi.mock("@clerk/express", async (importOriginal) => {
          const actual = await importOriginal<typeof import("@clerk/express")>();
          return {
            ...actual,
            clerkMiddleware:
              () =>
              (_req: unknown, _res: unknown, next: () => void): void =>
                next(),
          };
        });
        vi.mock("../middlewares/requireAuth", () => ({
          requireAuth: (
            req: { appUser?: { id: string; role: string } },
            _res: unknown,
            next: () => void,
          ) => {
            req.appUser = { id: USER_ID, role: "admin" };
            next();
          },
        }));

        type Db = typeof import("@workspace/db");
        let db: Db["db"];
        let schema: {
          users: Db["users"];
          organizations: Db["organizations"];
          opportunitiesAndPledges: Db["opportunitiesAndPledges"];
          pledgeAllocations: Db["pledgeAllocations"];
          pledgeExpectedPayments: Db["pledgeExpectedPayments"];
          giftsAndPayments: Db["giftsAndPayments"];
          giftAllocations: Db["giftAllocations"];
          bulkOperations: Db["bulkOperations"];
        };
        let eqFn: (typeof import("drizzle-orm"))["eq"];
        let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
        let likeFn: (typeof import("drizzle-orm"))["like"];
        let server: Server;
        let baseUrl = "";
        let sequence = 0;
        const giftIds: string[] = [];
        const opportunityIds: string[] = [];
        const nextId = (kind: string) => `${RUN}_${kind}_${++sequence}`;

        async function post(path: string, body: unknown) {
          const response = await fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          return { status: response.status, json: await response.json() };
        }

        async function seedGift(
          amount: string,
          dateReceived: string,
          allocations: string[] = [amount],
        ): Promise<string> {
          const id = nextId("gift");
          giftIds.push(id);
          await db.insert(schema.giftsAndPayments).values({
            id,
            name: `Gift ${id}`,
            organizationId: ORG_ID,
            amount,
            dateReceived,
          });
          for (const subAmount of allocations) {
            await db.insert(schema.giftAllocations).values({
              id: nextId("allocation"),
              giftId: id,
              subAmount,
            });
          }
          return id;
        }

        beforeAll(async () => {
          if (!HAS_DB) return;
          const dbMod = await import("@workspace/db");
          const drizzle = await import("drizzle-orm");
          db = dbMod.db;
          schema = {
            users: dbMod.users,
            organizations: dbMod.organizations,
            opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
            pledgeAllocations: dbMod.pledgeAllocations,
            pledgeExpectedPayments: dbMod.pledgeExpectedPayments,
            giftsAndPayments: dbMod.giftsAndPayments,
            giftAllocations: dbMod.giftAllocations,
            bulkOperations: dbMod.bulkOperations,
          };
          eqFn = drizzle.eq;
          inArrayFn = drizzle.inArray;
          likeFn = drizzle.like;
          await db.insert(schema.users).values({
            id: USER_ID,
            clerkId: `clerk_${USER_ID}`,
            email: `${USER_ID}@wildflowerschools.org`,
            role: "admin",
          });
          await db.insert(schema.organizations).values({
            id: ORG_ID,
            name: `Reconstruction ${RUN}`,
          });
          const { default: app } = await import("../app");
          server = await new Promise<Server>((resolve) => {
            const running = app.listen(0, () => resolve(running));
          });
          const address = server.address() as AddressInfo;
          baseUrl = `http://127.0.0.1:${address.port}`;
        }, 60_000);

        afterAll(async () => {
          if (!HAS_DB) return;
          if (server) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
          if (opportunityIds.length) {
            await db
              .delete(schema.pledgeExpectedPayments)
              .where(inArrayFn(schema.pledgeExpectedPayments.pledgeId, opportunityIds));
          }
          await db
            .delete(schema.bulkOperations)
            .where(likeFn(schema.bulkOperations.entity, "gifts-and-payments/%pledge%"));
          await db
            .delete(schema.giftAllocations)
            .where(likeFn(schema.giftAllocations.id, `${RUN}%`));
          if (giftIds.length) {
            await db
              .delete(schema.giftsAndPayments)
              .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
          }
          if (opportunityIds.length) {
            await db
              .delete(schema.pledgeAllocations)
              .where(
                inArrayFn(
                  schema.pledgeAllocations.pledgeOrOpportunityId,
                  opportunityIds,
                ),
              );
            await db
              .delete(schema.opportunitiesAndPledges)
              .where(inArrayFn(schema.opportunitiesAndPledges.id, opportunityIds));
          }
          await db
            .delete(schema.organizations)
            .where(eqFn(schema.organizations.id, ORG_ID));
          await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
        }, 60_000);

        describe.skipIf(!HAS_DB)("historical pledge reconstruction", () => {
          it("merge-into-pledge creates a finalized verbal pledge with a schedule", async () => {
            const first = await seedGift("40.00", "2099-06-01");
            const second = await seedGift("60.00", "2099-06-15");
            const result = await post("/api/gifts-and-payments/merge-into-pledge", {
              giftIds: [first, second],
              name: `Merged pledge ${RUN}`,
            });
            expect(result.status).toBe(200);
            const pledgeId = result.json.pledgeId as string;
            opportunityIds.push(pledgeId);

            const [pledge] = await db
              .select()
              .from(schema.opportunitiesAndPledges)
              .where(eqFn(schema.opportunitiesAndPledges.id, pledgeId));
            expect(pledge.commitmentPath).toBe("verbal_pledge");
            expect(pledge.verbalCommitmentAt).toBe("2099-06-01");
            expect(pledge.pledgeCommittedAt).toBe("2099-06-01");
            expect(pledge.writtenPledge).toBe(true);
            expect(pledge.stage).toBe("verbal_confirmation");
            expect(pledge.status).toBe("cash_in");

            const schedule = await db
              .select()
              .from(schema.pledgeExpectedPayments)
              .where(eqFn(schema.pledgeExpectedPayments.pledgeId, pledgeId));
            expect(schedule.map((row) => row.amount).sort()).toEqual([
              "40.00",
              "60.00",
            ]);
            expect(schedule.map((row) => row.expectedDate).sort()).toEqual([
              "2099-06-01",
              "2099-06-15",
            ]);
          }, 30_000);

          it("refuses to attach payments to an unfinalized pledge setup", async () => {
            const giftId = await seedGift("25.00", "2099-07-01");
            const opportunityId = nextId("opportunity");
            opportunityIds.push(opportunityId);
            await db.insert(schema.opportunitiesAndPledges).values({
              id: opportunityId,
              name: `Unfinalized ${RUN}`,
              organizationId: ORG_ID,
              stage: "verbal_confirmation",
              commitmentPath: "verbal_pledge",
              verbalCommitmentAt: "2099-06-20",
              awardedAmount: "25.00",
            });

            const result = await post("/api/gifts-and-payments/merge-into-pledge", {
              giftIds: [giftId],
              pledgeId: opportunityId,
            });
            expect(result.status).toBe(409);
            expect(result.json.error).toBe("not_finalized_pledge");
          }, 30_000);

          it("split-into-pledge creates lifecycle authority and installment rows", async () => {
            const giftId = await seedGift("100.00", "2099-08-01", [
              "40.00",
              "60.00",
            ]);
            const result = await post(
              `/api/gifts-and-payments/${giftId}/split-into-pledge`,
              { name: `Split pledge ${RUN}` },
            );
            expect(result.status).toBe(200);
            const pledgeId = result.json.pledgeId as string;
            opportunityIds.push(pledgeId);
            for (const id of result.json.giftIds as string[]) {
              if (!giftIds.includes(id)) giftIds.push(id);
            }

            const [pledge] = await db
              .select()
              .from(schema.opportunitiesAndPledges)
              .where(eqFn(schema.opportunitiesAndPledges.id, pledgeId));
            expect(pledge.commitmentPath).toBe("verbal_pledge");
            expect(pledge.pledgeCommittedAt).toBe("2099-08-01");
            expect(pledge.stage).toBe("verbal_confirmation");
            expect(pledge.status).toBe("cash_in");

            const schedule = await db
              .select()
              .from(schema.pledgeExpectedPayments)
              .where(eqFn(schema.pledgeExpectedPayments.pledgeId, pledgeId));
            expect(schedule.map((row) => row.amount).sort()).toEqual([
              "40.00",
              "60.00",
            ]);
          }, 30_000);
        });
        '''
    ).lstrip(),
)

print("Opportunity commitment lifecycle follow-up patch applied")
