#!/usr/bin/env bash
set -euo pipefail

BRANCH="agent/detail-action-lifecycle-v2"
LOG="/tmp/detail-actions-web-fix-v2.log"

exec > >(tee "$LOG") 2>&1
cd "${REPL_HOME:-$HOME}/workspace" 2>/dev/null || cd ~/workspace

if [[ "$(git branch --show-current)" != "$BRANCH" ]]; then
  echo "Expected branch $BRANCH; currently on $(git branch --show-current)." >&2
  exit 2
fi

python3 - <<'PY'
from pathlib import Path
import re

# ---------------------------------------------------------------------------
# 1. Supply the required Orval query key for the broad payment-evidence search.
# ---------------------------------------------------------------------------
picker = Path(
    "artifacts/wildflower-crm/src/components/payment-evidence-picker-dialog.tsx"
)
text = picker.read_text()
query_key_name = "getSearchReconciliationQbStagedQueryKey"

import_head = text.split('} from "@workspace/api-client-react";', 1)[0]
if query_key_name not in import_head:
    anchor = "  getGetPendingStagedMoneyForDonorQueryKey,\n"
    if anchor not in text:
        raise SystemExit("Could not find the payment-evidence query-key import anchor.")
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
        raise SystemExit("Could not find the broad payment-search query options block.")
    text = text.replace(old_query, new_query, 1)

picker.write_text(text)

# ---------------------------------------------------------------------------
# 2. Add household to FlagForResearchBody regardless of YAML formatting.
# ---------------------------------------------------------------------------
spec = Path("lib/api-spec/openapi.yaml")
lines = spec.read_text().splitlines(keepends=True)

start = None
for i, line in enumerate(lines):
    if line.startswith("    FlagForResearchBody:"):
        start = i
        break
if start is None:
    raise SystemExit("Could not find the FlagForResearchBody schema block.")

end = len(lines)
for i in range(start + 1, len(lines)):
    line = lines[i]
    if line.startswith("    ") and not line.startswith("      ") and line.strip().endswith(":"):
        end = i
        break

block = "".join(lines[start:end])
if not re.search(r"\bhousehold\b", block):
    enum_match = re.search(
        r"(?s)(\btargetType\s*:.*?\benum\s*:\s*\[)(.*?)(\])",
        block,
    )
    if not enum_match:
        raise SystemExit("Could not find the targetType enum inside FlagForResearchBody.")
    enum_body = enum_match.group(2)
    enum_body, replacements = re.subn(
        r"\bperson\b(\s*,)",
        r"person\1 household,",
        enum_body,
        count=1,
    )
    if replacements != 1:
        raise SystemExit("Could not insert household after person in the targetType enum.")
    block = (
        block[: enum_match.start(2)]
        + enum_body
        + block[enum_match.end(2) :]
    )
    lines[start:end] = [block]

spec.write_text("".join(lines))

# ---------------------------------------------------------------------------
# 3. Refresh the household detail badge after flagging for research.
# ---------------------------------------------------------------------------
flag_dialog = Path(
    "artifacts/wildflower-crm/src/components/flag-for-research-dialog.tsx"
)
flag_text = flag_dialog.read_text()
if 'household: "/api/households",' not in flag_text:
    anchor = '  organization: "/api/organizations",\n'
    if anchor not in flag_text:
        raise SystemExit("Could not find the research detail-query mapping anchor.")
    flag_text = flag_text.replace(
        anchor,
        anchor + '  household: "/api/households",\n',
        1,
    )
flag_dialog.write_text(flag_text)

# Structural assertions before running generation/type checks.
if query_key_name not in picker.read_text():
    raise SystemExit("The broad-search query key was not added.")
if not re.search(r"\bhousehold\b", "".join(lines[start:end])):
    raise SystemExit("Household was not added to FlagForResearchBody.")
if 'household: "/api/households",' not in flag_dialog.read_text():
    raise SystemExit("The household detail query mapping was not added.")
PY

rm -f \
  detail-actions-overlay.tar.gz \
  finish-detail-actions-v2.sh \
  finish-detail-actions.sh \
  scripts/finish-detail-actions-pr106.sh

printf '\n1/7 Formatting the two hand-edited React files...\n'
pnpm exec prettier --write \
  artifacts/wildflower-crm/src/components/payment-evidence-picker-dialog.tsx \
  artifacts/wildflower-crm/src/components/flag-for-research-dialog.tsx

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
