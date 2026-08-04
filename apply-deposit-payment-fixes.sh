#!/usr/bin/env bash
set -euo pipefail

SOURCE_BRANCH="main"
TARGET_BRANCH="agent/fix-deposit-payment-actions"
LOG="/tmp/deposit-payment-actions-fix.log"
exec > >(tee "$LOG") 2>&1

cd "${REPL_HOME:-$HOME}/workspace" 2>/dev/null || cd ~/workspace

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or discard unrelated changes first." >&2
  git status --short
  exit 2
fi

git fetch origin
git switch "$SOURCE_BRANCH"
git pull --ff-only origin "$SOURCE_BRANCH"
if git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
  git branch -D "$TARGET_BRANCH"
fi
git switch -c "$TARGET_BRANCH" "origin/$SOURCE_BRANCH"

python3 - <<'PY'
from pathlib import Path
import re


def one(path: str, pattern: str, replacement: str, flags: int = re.S) -> None:
    p = Path(path)
    text = p.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"Expected exactly one match in {path}; found {count}")
    p.write_text(updated)

one(
    "artifacts/wildflower-crm/src/components/reconciliation-deposits/gift-placement.tsx",
    r'function componentAnchor\([\s\S]*?\n}\n\nfunction liveChargesOf',
    '''function componentAnchor(
  deposit: WorkbenchDeposit,
  component: WorkbenchDepositCompositionComponentsItem,
): AnchorRef | null {
  if (component.paymentUnitId) {
    return {
      kind: "component",
      id: component.componentId,
      label: component.label ?? component.kind,
      bankDepositId: deposit.anchorId,
      amount: component.amount,
      paymentUnitId: component.paymentUnitId,
    };
  }
  if (component.stagedPaymentId && component.stagedActionable === true) {
    return {
      kind: "staged",
      id: component.stagedPaymentId,
      label: component.label ?? component.kind,
    };
  }
  return null;
}

function liveChargesOf''',
)
one(
    "artifacts/wildflower-crm/src/components/reconciliation-deposits/gift-placement.tsx",
    r'return deposit\.composition\.kind === "components"\n    \?',
    'return deposit.composition.kind === "components" ||\n    deposit.composition.kind === "qbo_provisional"\n    ?',
)

rows = "artifacts/wildflower-crm/src/components/reconciliation-deposits/rows.tsx"
one(rows, r'(  openFlagRemainder\?: \(bankDepositId: string, remainder: string\) => void;\n)', r'\1  openExcludeRemainder?: (bankDepositId: string, remainder: string) => void;\n')
one(rows, r'(  openFlagRemainder: \(\) => undefined,\n)', r'\1  openExcludeRemainder: () => undefined,\n')
one(
    rows,
    r'(        Flag remainder for research\n      </button>)',
    r'''\1
      <button
        type="button"
        className="text-[10px] font-medium text-destructive hover:underline"
        onClick={() =>
          actions.openExcludeRemainder?.(
            deposit.anchorId,
            composition.unexplainedAmount,
          )
        }
      >
        Mark remainder as excluded…
      </button>''',
)
one(
    rows,
    r'  const giftColumnTarget: \{[\s\S]*?\n  const giftColumnAnchor = giftColumnTarget\?\.anchor \?\? null;',
    '''  const giftColumnTarget: {
    anchor: AnchorRef;
    prefill: CreateGiftPrefill;
  } | null = (() => {
    const charge = deposit.charges.find((item) => !item.linkedGiftId);
    if (charge) {
      return {
        anchor: {
          kind: "charge",
          id: charge.chargeId,
          label: charge.payerName ?? charge.chargeId,
        },
        prefill: {
          name: charge.payerName ?? null,
          dateReceived: charge.chargeDate?.slice(0, 10) ?? null,
        },
      };
    }
    const components =
      deposit.composition.kind === "components" ||
      deposit.composition.kind === "qbo_provisional"
        ? deposit.composition.components
        : [];
    const unit = components.find(
      (item) =>
        item.source === "bank_spine" &&
        (item.countedGiftIds?.length ?? 0) === 0 &&
        Boolean(item.paymentUnitId) &&
        !item.exclusionReason,
    );
    if (unit) {
      return {
        anchor: {
          kind: "component",
          id: unit.componentId,
          label: componentTitle(unit),
          bankDepositId: deposit.anchorId,
          amount: unit.amount,
          paymentUnitId: unit.paymentUnitId ?? undefined,
        },
        prefill: {
          name: unit.label ?? null,
          dateReceived: unit.receivedDate?.slice(0, 10) ?? null,
        },
      };
    }
    const staged = components.find(
      (item) =>
        (item.countedGiftIds?.length ?? 0) === 0 &&
        Boolean(item.stagedPaymentId) &&
        item.stagedActionable === true &&
        !item.exclusionReason,
    );
    if (staged?.stagedPaymentId) {
      return {
        anchor: {
          kind: "staged",
          id: staged.stagedPaymentId,
          label: staged.label ?? staged.kind,
        },
        prefill: {
          name: null,
          dateReceived: staged.receivedDate?.slice(0, 10) ?? null,
        },
      };
    }
    return null;
  })();
  const giftColumnAnchor = giftColumnTarget?.anchor ?? null;''',
)
one(
    rows,
    r'  const unlinkedComponents =\n    deposit\.composition\.kind === "components"[\s\S]*?\n      : \[\];',
    '''  const unlinkedComponents =
    deposit.composition.kind === "components" ||
    deposit.composition.kind === "qbo_provisional"
      ? deposit.composition.components.filter(
          (component) =>
            (component.countedGiftIds?.length ?? 0) === 0 &&
            !component.exclusionReason &&
            (Boolean(component.paymentUnitId) ||
              (Boolean(component.stagedPaymentId) &&
                component.stagedActionable === true)),
        )
      : [];''',
)

dialogs = "artifacts/wildflower-crm/src/components/reconciliation-deposits/gift-column-dialogs.tsx"
one(
    dialogs,
    r'(const NO_ENTITY = "__none__";\n)',
    r'''\1
export function pledgePaymentBlockedReason(
  opp: OpportunityOrPledge,
  pledgeOnly: boolean,
): string | null {
  if (opp.archivedAt) return "Archived — restore it before recording money.";
  if (opp.lossType === "lost")
    return "Marked lost — payments can't be recorded on a lost record.";
  if (opp.lossType === "dormant")
    return "Marked dormant — reactivate the pledge to record a payment.";
  const finalized =
    opp.pledgeCommittedAt != null ||
    (opp.commitmentPath == null && opp.writtenPledge === true);
  if (pledgeOnly && !finalized)
    return "Still an open opportunity — finalize it as a written or verbal pledge before recording a payment.";
  return null;
}
''',
)
one(
    dialogs,
    r'  const pledgeOnly = anchorKind !== "staged";\n  const oppRowBlockedReason = \(opp: OpportunityOrPledge\): string \| null => \{[\s\S]*?\n  \};',
    '''  const pledgeOnly = anchorKind !== "staged";
  const oppRowBlockedReason = (opp: OpportunityOrPledge): string | null =>
    pledgePaymentBlockedReason(opp, pledgeOnly);''',
)

page = "artifacts/wildflower-crm/src/pages/reconciliation-deposits.tsx"
one(
    page,
    r'(  const \[knownPaymentFor, setKnownPaymentFor\] = useState<\{\n    depositId: string;\n    remainder: string;\n  \} \| null>\(null\);\n)',
    r'''\1  const [excludeRemainderFor, setExcludeRemainderFor] = useState<{
    depositId: string;
    remainder: string;
  } | null>(null);
''',
)
one(
    page,
    r'(  const handleFlagRemainder = async \(depositId: string, remainder: string\) => \{[\s\S]*?\n  \};\n)(  const handleAttachPaymentUnit)',
    r'''\1  const handleExcludeRemainder = async (
    reason: StagedPaymentExclusionReason,
  ) => {
    const target = excludeRemainderFor;
    if (!target) return;
    let componentId: string | null = null;
    try {
      const component = await addBankComponent.mutateAsync({
        bankDepositId: target.depositId,
        data: { mode: "create", kind: "other", amount: target.remainder },
      });
      componentId = component.id;
      await excludeComponent.mutateAsync({
        id: component.id,
        data: { exclusionReason: reason },
      });
      setExcludeRemainderFor(null);
      toast({
        title: "Remainder excluded",
        description: `${formatCurrency(target.remainder)} was excluded; the valid gifts and the rest of the deposit are unchanged.`,
      });
      invalidate();
    } catch (err) {
      if (componentId) {
        await removeManualComponent
          .mutateAsync({ id: componentId })
          .catch(() => undefined);
      }
      toast({
        title: "Couldn't exclude remainder",
        description: apiErrorMessage(err) ?? errMessage(err),
        variant: "destructive",
      });
      invalidate();
    }
  };
  \2''',
)
one(
    page,
    r'(    openFlagRemainder: \(depositId, remainder\) => \{\n      void handleFlagRemainder\(depositId, remainder\);\n    \},\n)',
    r'''\1    openExcludeRemainder: (depositId, remainder) => {
      setExcludeRemainderFor({ depositId, remainder });
    },
''',
)
one(
    page,
    r'(      <ExcludeReasonDialog\n        open=\{excludeFor != null\}[\s\S]*?onSubmit=\{\(reason\) => void handleExclude\(reason\)\}\n      />)',
    r'''\1
      <ExcludeReasonDialog
        open={excludeRemainderFor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setExcludeRemainderFor(null);
        }}
        recordLabel={
          excludeRemainderFor
            ? `${formatCurrency(excludeRemainderFor.remainder)} deposit remainder`
            : "this remainder"
        }
        busy={busy}
        onSubmit={(reason) => void handleExcludeRemainder(reason)}
      />''',
)

test = Path("artifacts/wildflower-crm/src/components/reconciliation-deposits/gift-placement.test.ts")
text = test.read_text()
marker = '  it("links directly only when one remaining payment exactly matches", () => {'
case = '''  it("prefers the canonical unit over its actionable QB source", () => {
    const plan = buildGiftPlacementPlan(
      {
        anchorId: "deposit_1",
        composition: {
          kind: "components",
          components: [{
            componentId: "component_1",
            paymentUnitId: "unit_1",
            stagedPaymentId: "staged_1",
            stagedActionable: true,
            source: "bank_spine",
            amount: "1000.00",
            countedGiftIds: [],
          }],
        },
        charges: [],
      } as any,
      { id: "gift_1", amount: "1000.00" } as any,
    );
    expect(plan.directTarget?.anchor).toMatchObject({
      kind: "component",
      paymentUnitId: "unit_1",
    });
  });

'''
if text.count(marker) != 1:
    raise SystemExit("Could not place gift-placement regression test")
test.write_text(text.replace(marker, case + marker, 1))

Path(
  "artifacts/wildflower-crm/src/components/reconciliation-deposits/gift-column-dialogs.test.ts"
).write_text('''import { describe, expect, it } from "vitest";
import { pledgePaymentBlockedReason } from "./gift-column-dialogs";

describe("pledge payment eligibility", () => {
  it("accepts finalized verbal pledges", () => {
    expect(pledgePaymentBlockedReason({
      id: "verbal",
      pledgeCommittedAt: "2026-01-15",
      commitmentPath: "verbal_pledge",
      writtenPledge: false,
      loanOrGrant: "grant",
    } as any, true)).toBeNull();
  });

  it("blocks an opportunity that is not yet a pledge", () => {
    expect(pledgePaymentBlockedReason({
      id: "open",
      pledgeCommittedAt: null,
      commitmentPath: null,
      writtenPledge: false,
      loanOrGrant: "grant",
    } as any, true)).toContain("finalize it as a written or verbal pledge");
  });
});
''')
PY

FILES=(
  artifacts/wildflower-crm/src/components/reconciliation-deposits/gift-placement.tsx
  artifacts/wildflower-crm/src/components/reconciliation-deposits/rows.tsx
  artifacts/wildflower-crm/src/components/reconciliation-deposits/gift-column-dialogs.tsx
  artifacts/wildflower-crm/src/pages/reconciliation-deposits.tsx
  artifacts/wildflower-crm/src/components/reconciliation-deposits/gift-placement.test.ts
  artifacts/wildflower-crm/src/components/reconciliation-deposits/gift-column-dialogs.test.ts
)

pnpm exec prettier --write "${FILES[@]}"
pnpm --filter @workspace/api-spec run codegen:check
pnpm --filter @workspace/wildflower-crm exec vitest run \
  src/components/reconciliation-deposits/gift-placement.test.ts \
  src/components/reconciliation-deposits/gift-column-dialogs.test.ts
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/wildflower-crm run typecheck
git diff --check

git add "${FILES[@]}"
git commit -m "Fix deposit payment linking and remainder exclusions"
git push -u origin "$TARGET_BRANCH"

echo
echo "FIX BRANCH PUSHED: $TARGET_BRANCH"
echo "Log: $LOG"
