#!/usr/bin/env bash
set -u

run_validation() {
  python .agent/apply-app-feedback.py
  python .agent/refine-app-feedback.py

  pnpm install --no-frozen-lockfile

  pnpm exec prettier --write \
    lib/db/src/schema/appFeedback.ts \
    artifacts/api-server/src/routes/appFeedback.ts \
    artifacts/api-server/src/__tests__/app-feedback.integration.test.ts \
    artifacts/wildflower-crm/src/lib/feedback-api.ts \
    artifacts/wildflower-crm/src/lib/feedback-capture.ts \
    artifacts/wildflower-crm/src/lib/feedback-capture.test.ts \
    artifacts/wildflower-crm/src/components/feedback-dialog.tsx \
    artifacts/wildflower-crm/src/pages/admin-feedback.tsx \
    artifacts/wildflower-crm/package.json

  pnpm --filter @workspace/db run push-force
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0219_app_feedback.sql

  pnpm run check:api
  pnpm run check:web

  pnpm --filter @workspace/api-server exec vitest run \
    src/__tests__/app-feedback.integration.test.ts
  pnpm --filter @workspace/wildflower-crm exec vitest run \
    src/lib/feedback-capture.test.ts
}

set +e
run_validation > /tmp/app-feedback-validation.log 2>&1
status=$?
set -e

configure_git() {
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
}

if [ "$status" -ne 0 ]; then
  tail -n 600 /tmp/app-feedback-validation.log > .agent/validation-error.txt
  configure_git
  git add .agent/validation-error.txt
  git commit -m "Record app feedback validation failure"
  git push origin HEAD:agent/app-feedback-workflow-v2
  cat /tmp/app-feedback-validation.log
  exit "$status"
fi

rm -rf .agent
rm -f .github/workflows/validate-app-feedback.yml
rmdir .github/workflows 2>/dev/null || true
configure_git
git add -A
git commit -m "Add in-app feedback capture and admin review"
git push origin HEAD:agent/app-feedback-workflow-v2
cat /tmp/app-feedback-validation.log
