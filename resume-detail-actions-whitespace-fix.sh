#!/usr/bin/env bash
set -euo pipefail

BRANCH="agent/detail-action-lifecycle-v2"
LOG="/tmp/detail-actions-whitespace-fix.log"

exec > >(tee "$LOG") 2>&1
cd "${REPL_HOME:-$HOME}/workspace" 2>/dev/null || cd ~/workspace

if [[ "$(git branch --show-current)" != "$BRANCH" ]]; then
  echo "Expected branch $BRANCH; currently on $(git branch --show-current)." >&2
  exit 2
fi

python3 - <<'PY'
from pathlib import Path

replacement = '''# Orval can emit trailing spaces in generated operation templates.
# Normalize every generated TypeScript file so output remains byte-stable,
# reproducible, and clean under git diff --check.
find "$tmp/lib/api-client-react/src/generated" \\
     "$tmp/lib/api-zod/src/generated" \\
     -type f -name '*.ts' -exec sed -i 's/[[:space:]]*$//' {} +'''

for filename in ("codegen.sh", "codegen-check.sh"):
    path = Path("lib/api-spec") / filename
    text = path.read_text()

    if "Normalize every generated TypeScript file" in text:
        continue

    old = '''# Orval emits trailing spaces in this file's bodyless mutation templates.
# Normalize the whole file so output is byte-stable and future mutation
# operations need no per-operation handling.
sed -i 's/[[:space:]]*$//' \\
  "$tmp/lib/api-client-react/src/generated/reconciliation/reconciliation.ts"'''

    if old not in text:
        old = '''sed -i 's/[[:space:]]*$//' \\
  "$tmp/lib/api-client-react/src/generated/reconciliation/reconciliation.ts"'''

    if old not in text:
        raise SystemExit(f"Could not find the generated-whitespace normalization block in {path}.")

    path.write_text(text.replace(old, replacement, 1))
PY

printf '\n1/8 Validating codegen shell scripts...\n'
bash -n lib/api-spec/codegen.sh
bash -n lib/api-spec/codegen-check.sh

printf '\n2/8 Regenerating whitespace-clean API outputs...\n'
pnpm --filter @workspace/api-spec run codegen

printf '\n3/8 Verifying generated API outputs...\n'
pnpm --filter @workspace/api-spec run codegen:check

printf '\n4/8 Type-checking API...\n'
pnpm --filter @workspace/api-server run typecheck

printf '\n5/8 Type-checking web application...\n'
pnpm --filter @workspace/wildflower-crm run typecheck

printf '\n6/8 Checking final diff...\n'
git diff --check

printf '\n7/8 Committing complete implementation...\n'
git add -A
git status --short
git diff --cached --stat
git commit -m "Implement record-local donor and fundraising actions"

printf '\n8/8 Synchronizing and pushing PR #106...\n'
git fetch origin
git rebase "origin/$BRANCH"
git push origin HEAD:"$BRANCH"

printf '\nIMPLEMENTATION PUSHED SUCCESSFULLY.\n'
