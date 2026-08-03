#!/usr/bin/env bash
set -euo pipefail

BRANCH="agent/detail-action-lifecycle-v2"
OVERLAY_URL="https://filebin.net/wf-detail-actions-20260801-final-v3-c6d2/detail-actions-overlay-v3.tar.gz"
OVERLAY_SHA256="37011ad4545d055719d8752ed770ab64a4210a886020b8429e874645cbbafb06"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "The working tree has uncommitted changes. Commit or stash them, then rerun this script." >&2
  git status --short >&2
  exit 1
fi

git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

archive="$(mktemp --suffix=.tar.gz)"
trap 'rm -f "$archive"' EXIT

curl --fail --location --silent --show-error "$OVERLAY_URL" -o "$archive"
echo "$OVERLAY_SHA256  $archive" | sha256sum --check -
tar -xzf "$archive"

rm -f \
  .github/workflows/apply-detail-actions-v2.yml \
  .github/workflows/validate-detail-actions-implementation.yml \
  detail-actions-trigger.txt \
  scripts/finish-detail-actions-pr106.sh

pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen

changed="$(git status --short | awk '{print $2}' | grep -E '\.(ts|tsx|js|jsx|json|ya?ml|md)$' || true)"
if [[ -n "$changed" ]]; then
  pnpm exec prettier --write $changed
  pnpm exec prettier --check $changed
fi

pnpm --filter @workspace/api-spec run codegen:check
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/wildflower-crm run typecheck
git diff --check

git add -A
git commit -m "Implement record-local donor and fundraising actions"
git push origin "$BRANCH"

echo
echo "Implementation pushed to PR #106."
