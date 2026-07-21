#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push

# Warm the incremental-build + vitest caches in the background so the first
# real verify in a fresh environment doesn't pay the cold tsc --build.
# Detached (nohup + &) so it never counts against the post-merge timeout.
nohup bash -c '
  pnpm run typecheck > /tmp/warm-typecheck.log 2>&1
  pnpm --filter @workspace/api-server run test:unit > /tmp/warm-vitest.log 2>&1
' > /dev/null 2>&1 &
