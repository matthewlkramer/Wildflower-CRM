from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = Path(path)
    text = file.read_text()
    found = text.count(old)
    if found != count:
        raise SystemExit(
            f"{path}: expected {count} matches, found {found}: {old[:100]!r}"
        )
    file.write_text(text.replace(old, new, count))


# QuickBooks evidence should mint a pledge payment directly. The old UI path
# first requested a reconciliation graph, which is not available for every
# deposit-row staged payment and made a valid pledge selection appear to do
# nothing.
quickbooks = "artifacts/api-server/src/routes/quickbooks/actions.ts"
replace(
    quickbooks,
    'import { Router, type IRouter } from "express";',
    'import { Router, type IRouter } from "express";\nimport { z } from "zod";',
)
replace(
    quickbooks,
    'import { applyPaymentApplication } from "../../lib/paymentApplications";',
    '''import { applyPaymentApplication } from "../../lib/paymentApplications";
import {
  ReconcileAbort,
  copyPledgeAllocationsToGift,
  lockAndValidatePledgeForPayment,
} from "../../lib/reconciliationCommit";
import { donorOf } from "../../lib/quickbooksLink";
import { applyDerivedOppFieldsMany } from "../../lib/pledgeStage";''',
)
replace(
    quickbooks,
    "const router: IRouter = Router();",
    '''const router: IRouter = Router();

const CreateGiftFromStagedPaymentWithPledgeBody =
  CreateGiftFromStagedPaymentBody.extend({
    opportunityId: z.string().nullable().optional(),
  });''',
)
replace(
    quickbooks,
    '''const parsedOverrides = CreateGiftFromStagedPaymentBody.safeParse(
      req.body ?? {},
    );''',
    '''const parsedOverrides = CreateGiftFromStagedPaymentWithPledgeBody.safeParse(
      req.body ?? {},
    );''',
)
replace(
    quickbooks,
    '''    const preIssues = validateGiftInvariants({
      organizationId: existing.organizationId,
      individualGiverPersonId: existing.individualGiverPersonId,
      householdId: existing.householdId,
    });
    if (preIssues.length) return respondInvariantFailure(res, preIssues);
''',
    '''    const pledgeOpportunityId = overrides.opportunityId ?? null;
    if (!pledgeOpportunityId) {
      const preIssues = validateGiftInvariants({
        organizationId: existing.organizationId,
        individualGiverPersonId: existing.individualGiverPersonId,
        householdId: existing.householdId,
      });
      if (preIssues.length) return respondInvariantFailure(res, preIssues);
    }
''',
)
replace(
    quickbooks,
    '''    let lockedIssues: InvariantIssue[] = [];
    try {''',
    '''    let lockedIssues: InvariantIssue[] = [];
    let opportunityIdToRederive: string | null = null;
    try {''',
)
replace(
    quickbooks,
    '''        const donor = {
          organizationId: locked.organizationId,
          individualGiverPersonId: locked.individualGiverPersonId,
          householdId: locked.householdId,
        };
        const issues = validateGiftInvariants(donor);
        if (issues.length) {
          lockedIssues = issues;
          throw new Error(INVARIANT);
        }
''',
    '''        const pledge = pledgeOpportunityId
          ? await lockAndValidatePledgeForPayment(tx, pledgeOpportunityId)
          : null;
        const donor = pledge
          ? donorOf(pledge)
          : {
              organizationId: locked.organizationId,
              individualGiverPersonId: locked.individualGiverPersonId,
              householdId: locked.householdId,
            };
        if (!pledge) {
          const issues = validateGiftInvariants(donor);
          if (issues.length) {
            lockedIssues = issues;
            throw new Error(INVARIANT);
          }
        }
        opportunityIdToRederive = pledge?.id ?? null;
''',
)
replace(
    quickbooks,
    '''          dateReceived: giftDateReceived,
          // Provenance is the counted ledger row (created_the_gift = true,
''',
    '''          dateReceived: giftDateReceived,
          opportunityId: pledge?.id ?? null,
          // Provenance is the counted ledger row (created_the_gift = true,
''',
)
replace(
    quickbooks,
    '''        await seedInitialGiftAllocation(tx, {
          giftId,
          amount: locked.amount,
          dateReceived: giftDateReceived,
          entityId:
            overrides.entityId !== undefined
              ? overrides.entityId
              : locked.entityId,
          countsTowardGoal:
            overrides.countsTowardGoal ?? !isGovernmentReimbursement(locked),
        });
        await assertGiftHasAllocations(tx, giftId);
''',
    '''        if (pledge) {
          await copyPledgeAllocationsToGift(
            tx,
            pledge.id,
            giftId,
            locked.amount,
          );
        }
        const seededCount = pledge
          ? Number(
              (
                (
                  await tx.execute(
                    sql`SELECT count(*)::int AS n FROM gift_allocations WHERE gift_id = ${giftId}`,
                  )
                ).rows[0] as { n: number }
              ).n,
            )
          : 0;
        if (!pledge || seededCount === 0) {
          await seedInitialGiftAllocation(tx, {
            giftId,
            amount: locked.amount,
            dateReceived: giftDateReceived,
            entityId:
              overrides.entityId !== undefined
                ? overrides.entityId
                : locked.entityId,
            countsTowardGoal:
              overrides.countsTowardGoal ?? !isGovernmentReimbursement(locked),
          });
        }
        await assertGiftHasAllocations(tx, giftId);
''',
)
replace(
    quickbooks,
    '''      if (e instanceof Error && e.message === INVARIANT) {
        return respondInvariantFailure(res, lockedIssues);
      }
      throw e;
    }

    const [gift] = await db
''',
    '''      if (e instanceof Error && e.message === INVARIANT) {
        return respondInvariantFailure(res, lockedIssues);
      }
      if (e instanceof ReconcileAbort) {
        res.status(e.httpStatus).json(e.payload);
        return;
      }
      throw e;
    }

    if (opportunityIdToRederive) {
      await applyDerivedOppFieldsMany(opportunityIdToRederive);
    }

    const [gift] = await db
''',
)
replace(
    quickbooks,
    "      extra: { giftId },",
    '''      extra: {
        giftId,
        ...(opportunityIdToRederive
          ? { opportunityId: opportunityIdToRederive }
          : {}),
      },''',
    1,
)

# A gift that is already backed by a same-money QuickBooks unit should not get
# a second counted Stripe payment. Confirm the charge↔QB evidence tie and move
# the one counted application to charge grain, preserving the QB row as
# corroborating evidence.
stripe = "artifacts/api-server/src/routes/stripe.ts"
replace(
    stripe,
    '''  chargeCountedLedgerRow,
} from "../lib/paymentApplications";''',
    '''  chargeCountedLedgerRow,
} from "../lib/paymentApplications";
import {
  applyChargeTieSupersedePairs,
  qbRowAmountMatchesCharge,
} from "../lib/chargeTieSupersede";
import { upsertConfirmedChargeTie } from "../lib/sourceLinkWrites";''',
)
replace(
    stripe,
    '''    let alreadyLinked = false;
    try {''',
    '''    let alreadyLinked = false;
    let linkedThroughExistingQbSource = false;
    try {''',
)
replace(
    stripe,
    '''        if (!isPendingStatus(chargeStatus)) {
          throw new ReconcileAbort(409, {
            error: "not_pending",
            message:
              "This staged charge is no longer open for reconciliation. Refresh and try again.",
          });
        }

        // ── Incumbent Stripe source (one gift ↔ one backing charge) ────────
''',
    '''        if (!isPendingStatus(chargeStatus)) {
          throw new ReconcileAbort(409, {
            error: "not_pending",
            message:
              "This staged charge is no longer open for reconciliation. Refresh and try again.",
          });
        }

        const qbBackedUnits = await tx
          .select({
            id: paymentUnits.id,
            sourceStagedPaymentId: paymentUnits.sourceStagedPaymentId,
            grossAmount: paymentUnits.grossAmount,
            netAmount: paymentUnits.netAmount,
          })
          .from(paymentUnits)
          .where(
            and(
              eq(paymentUnits.giftId, giftId),
              isNotNull(paymentUnits.sourceStagedPaymentId),
              isNull(paymentUnits.stripeChargeId),
            ),
          )
          .for("update");
        const sameMoneyQbUnits = qbBackedUnits.filter(
          (unit) =>
            unit.sourceStagedPaymentId != null &&
            qbRowAmountMatchesCharge({
              qbRowAmount: unit.grossAmount ?? unit.netAmount,
              chargeGross: charge.grossAmount,
              chargeNet: charge.netAmount,
            }),
        );
        if (sameMoneyQbUnits.length === 1) {
          const qbStagedPaymentId =
            sameMoneyQbUnits[0]!.sourceStagedPaymentId!;
          await upsertConfirmedChargeTie(
            tx,
            charge.id,
            qbStagedPaymentId,
            user.id,
          );
          supersedeGiftIds.push(
            ...(await applyChargeTieSupersedePairs(tx, [
              { chargeId: charge.id, qbStagedPaymentId },
            ])),
          );
          await tx
            .update(stripeStagedCharges)
            .set({
              ...donorOf(gift),
              matchStatus: "matched",
              matchMethod: "manual",
              matchConfirmedByUserId: user.id,
              matchConfirmedAt: new Date(),
              approvedByUserId: user.id,
              approvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(stripeStagedCharges.id, charge.id));
          linkedThroughExistingQbSource = true;
          return;
        }

        // ── Incumbent Stripe source (one gift ↔ one backing charge) ────────
''',
)
replace(
    stripe,
    '''        summary: `Linked the Stripe charge from ${payerLabel(row?.payerName)} (${fmtMoney(row?.grossAmount)}) to gift "${linkedGift?.name ?? giftId}"`,
        undo: { kind: "revert_stripe_charge", targetId: id },
        extra: { giftId },
''',
    '''        summary: linkedThroughExistingQbSource
          ? `Matched the Stripe charge from ${payerLabel(row?.payerName)} (${fmtMoney(row?.grossAmount)}) to the existing QuickBooks-backed gift "${linkedGift?.name ?? giftId}"`
          : `Linked the Stripe charge from ${payerLabel(row?.payerName)} (${fmtMoney(row?.grossAmount)}) to gift "${linkedGift?.name ?? giftId}"`,
        undo: linkedThroughExistingQbSource
          ? null
          : { kind: "revert_stripe_charge", targetId: id },
        extra: { giftId, linkedThroughExistingQbSource },
''',
)

# The workbench should call the direct staged-payment write endpoints for
# existing gifts and finalized pledges rather than constructing a graph-based
# approval request.
page = "artifacts/wildflower-crm/src/pages/reconciliation-deposits.tsx"
replace(
    page,
    '''      } else {
        const done = await approveStagedAgainst(
          anchor.id,
          { opp },
          "create_gift_from_opportunity",
        );
        if (!done) return false;
      }
''',
    '''      } else {
        await createStagedGift.mutateAsync({
          id: anchor.id,
          data: { opportunityId: opp.id } as MintGiftOverridesBody,
        });
      }
''',
    1,
)
start = page
text = Path(page).read_text()
old_start = text.index("  const handleLinkEvidenceGift = async (gift: GiftOrPayment) => {")
old_end = text.index("  const handleLinkEvidenceOpp = async", old_start)
new_handler = '''  const handleLinkEvidenceGift = async (gift: GiftOrPayment) => {
    const target = linkEvidenceFor;
    if (!target) return;
    try {
      await linkAnchorToGift(target.anchor, gift.id);
      setLinkEvidenceFor(null);
      invalidate();
      toast({
        title: "Gift linked",
        description: `“${target.anchor.label}” now pays the selected gift.`,
      });
    } catch (err) {
      toast({
        title: "Couldn't link gift",
        description: apiErrorMessage(err) ?? errMessage(err),
        variant: "destructive",
      });
      if (is409(err)) invalidate();
    }
  };
'''
Path(page).write_text(text[:old_start] + new_handler + text[old_end:])
replace(
    page,
    '''    try {
      const done = await approveStagedAgainst(
        target.anchor.id,
        { opp },
        "create_gift_from_opportunity",
      );
      if (!done) return;
      setLinkEvidenceFor(null);
''',
    '''    try {
      const finalizedPledge =
        opp.pledgeCommittedAt != null ||
        (opp.commitmentPath == null && opp.writtenPledge === true);
      if (finalizedPledge) {
        const done = await mintPledgePaymentAt(target.anchor, opp);
        if (!done) return;
      } else {
        const done = await approveStagedAgainst(
          target.anchor.id,
          { opp },
          "create_gift_from_opportunity",
        );
        if (!done) return;
      }
      setLinkEvidenceFor(null);
''',
    1,
)

print("record-local payment linking source patched")
