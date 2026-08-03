#!/usr/bin/env bash
set -euo pipefail

BRANCH="agent/detail-action-lifecycle-v2"
LOG="/tmp/detail-actions-resume-final.log"

exec > >(tee "$LOG") 2>&1
cd "${REPL_HOME:-$HOME}/workspace" 2>/dev/null || cd ~/workspace

if [[ "$(git branch --show-current)" != "$BRANCH" ]]; then
  echo "Expected branch $BRANCH; currently on $(git branch --show-current)." >&2
  exit 2
fi

python3 - <<'PY'
from pathlib import Path

path = Path("artifacts/api-server/src/routes/fundraisingRecordActions.ts")
text = path.read_text()

old_import = '''import {
  CorrectionReasonBody,
  RevertPledgeToOpportunityBody,
  RevertPledgeToVerbalGiftBody,
} from "@workspace/api-zod";'''
new_import = '''import {
  RevertPledgeToOpportunityBody,
  RevertPledgeToVerbalGiftBody,
} from "@workspace/api-zod";
import { z } from "zod";'''
if old_import in text:
    text = text.replace(old_import, new_import, 1)
elif 'import { z } from "zod";' not in text:
    raise SystemExit("Could not find the expected api-zod import block.")

anchor = 'type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];'
types = '''type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ActionFailure = {
  status: number;
  body: Record<string, unknown>;
};

type PledgeConversionOutcome =
  | { ok: true; giftId: string }
  | ({ ok: false } & ActionFailure);

const CorrectionReasonBody = z.object({
  reason: z.string().nullable().optional(),
});'''
if "type ActionFailure =" not in text:
    if anchor not in text:
        raise SystemExit("Could not find the transaction type anchor.")
    text = text.replace(anchor, types, 1)

old_outcome_decl = '''    let outcome:
      | { ok: true; giftId: string }
      | { ok: false; status: number; body: Record<string, unknown> }
      | null = null;'''
if old_outcome_decl in text:
    text = text.replace(
        old_outcome_decl,
        "    let outcome: PledgeConversionOutcome | null = null;",
        1,
    )

old_outcome_use = '''    if (!outcome) throw new Error("pledge_conversion_no_outcome");
    if (!outcome.ok) {
      res.status(outcome.status).json(outcome.body);
      return;
    }
    await applyDerivedOppFields(id);
    res.json({ giftId: outcome.giftId, opportunityId: id });'''
new_outcome_use = '''    const result = outcome as PledgeConversionOutcome | null;
    if (!result) throw new Error("pledge_conversion_no_outcome");
    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    await applyDerivedOppFields(id);
    res.json({ giftId: result.giftId, opportunityId: id });'''
if old_outcome_use in text:
    text = text.replace(old_outcome_use, new_outcome_use, 1)
elif "const result = outcome as PledgeConversionOutcome | null;" not in text:
    raise SystemExit("Could not find the pledge conversion result block.")

text = text.replace(
    "let failure: { status: number; body: Record<string, unknown> } | null = null;",
    "let failure: ActionFailure | null = null;",
)

old_failure = '''    if (failure) {
      res.status(failure.status).json(failure.body);
      return;
    }'''
new_failure = '''    const result = failure as ActionFailure | null;
    if (result) {
      res.status(result.status).json(result.body);
      return;
    }'''
remaining = text.count(old_failure)
if remaining:
    if remaining != 2:
        raise SystemExit(f"Expected two pledge reversion result blocks; found {remaining}.")
    text = text.replace(old_failure, new_failure)

required = [
    'import { z } from "zod";',
    "const CorrectionReasonBody = z.object({",
    "type ActionFailure = {",
    "type PledgeConversionOutcome =",
    "const result = outcome as PledgeConversionOutcome | null;",
]
for token in required:
    if token not in text:
        raise SystemExit(f"Required correction missing after patch: {token}")
if text.count("const result = failure as ActionFailure | null;") != 2:
    raise SystemExit("The two pledge reversion result assertions are not present.")
if "  CorrectionReasonBody,\n  RevertPledge" in text:
    raise SystemExit("CorrectionReasonBody is still imported from api-zod.")

path.write_text(text)

workflow = Path(".github/workflows/validate-detail-actions-implementation.yml")
if workflow.exists():
    wf = workflow.read_text().replace(
        "branches: [agent/detail-action-lifecycle]",
        "branches: [agent/detail-action-lifecycle-v2]",
    )
    workflow.write_text(wf)
PY

rm -f \
  detail-actions-overlay.tar.gz \
  finish-detail-actions-v2.sh \
  finish-detail-actions.sh \
  scripts/finish-detail-actions-pr106.sh

printf '\n1/7 Formatting the corrected route...\n'
pnpm exec prettier --write artifacts/api-server/src/routes/fundraisingRecordActions.ts

printf '\n2/7 Regenerating canonical API outputs...\n'
pnpm --filter @workspace/api-spec run codegen

printf '\n3/7 Verifying generated API outputs...\n'
pnpm --filter @workspace/api-spec run codegen:check

printf '\n4/7 Type-checking API...\n'
pnpm --filter @workspace/api-server run typecheck

printf '\n5/7 Type-checking web application...\n'
pnpm --filter @workspace/wildflower-crm run typecheck

printf '\n6/7 Checking and committing the implementation...\n'
git diff --check
git add -A

git status --short
git diff --cached --stat

git commit -m "Implement record-local donor and fundraising actions"

printf '\n7/7 Pushing to PR #106...\n'
git push origin HEAD:"$BRANCH"

printf '\nIMPLEMENTATION PUSHED SUCCESSFULLY.\n'
