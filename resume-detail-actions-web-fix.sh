#!/usr/bin/env bash
set -euo pipefail

BRANCH="agent/detail-action-lifecycle-v2"
LOG="/tmp/detail-actions-web-fix.log"

exec > >(tee "$LOG") 2>&1
cd "${REPL_HOME:-$HOME}/workspace" 2>/dev/null || cd ~/workspace

if [[ "$(git branch --show-current)" != "$BRANCH" ]]; then
  echo "Expected branch $BRANCH; currently on $(git branch --show-current)." >&2
  exit 2
fi

python3 - <<'PY'
from pathlib import Path

picker = Path(
    "artifacts/wildflower-crm/src/components/payment-evidence-picker-dialog.tsx"
)
text = picker.read_text()

query_key_name = "getSearchReconciliationQbStagedQueryKey"
if query_key_name not in text.split('} from "@workspace/api-client-react";', 1)[0]:
    anchor = "  getGetPendingStagedMoneyForDonorQueryKey,\n"
    if anchor not in text:
        raise SystemExit("Could not find the pending-money query-key import anchor.")
    text = text.replace(anchor, anchor + f"  {query_key_name},\n", 1)

old_query = '''      query: {
        enabled: open && debouncedSearch.length >= 2,
      },'''
new_query = '''      query: {
        enabled: open && debouncedSearch.length >= 2,
        queryKey: getSearchReconciliationQbStagedQueryKey({
          q: debouncedSearch || undefined,
          amount: expectedAmount || undefined,
          includeStripe: true,
          limit: 50,
        }),
      },'''
if "queryKey: getSearchReconciliationQbStagedQueryKey({" not in text:
    if old_query not in text:
        raise SystemExit("Could not find the broad-search query options block.")
    text = text.replace(old_query, new_query, 1)

picker.write_text(text)

spec = Path("lib/api-spec/openapi.yaml")
spec_text = spec.read_text()
old_enum = (
    "enum: [opportunity, pledge, organization, person, gift, "
    "staged_payment, stripe_payout]"
)
new_enum = (
    "enum: [opportunity, pledge, organization, person, household, gift, "
    "staged_payment, stripe_payout]"
)
if old_enum in spec_text:
    spec_text = spec_text.replace(old_enum, new_enum, 1)
elif new_enum not in spec_text:
    raise SystemExit("Could not find the FlagForResearchBody targetType enum.")
spec.write_text(spec_text)

corrected = picker.read_text()
if query_key_name not in corrected:
    raise SystemExit("The generated broad-search query key was not added.")
if "household, gift, staged_payment" not in spec.read_text():
    raise SystemExit("Household was not added to the research target enum.")
PY

rm -f \
  detail-actions-overlay.tar.gz \
  finish-detail-actions-v2.sh \
  finish-detail-actions.sh \
  scripts/finish-detail-actions-pr106.sh

printf '\n1/7 Formatting the hand-edited component...\n'
pnpm exec prettier --write \
  artifacts/wildflower-crm/src/components/payment-evidence-picker-dialog.tsx

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
