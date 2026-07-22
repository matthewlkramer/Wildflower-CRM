#!/bin/bash
# Non-mutating codegen check.
#
# Generates the orval output into a temp mirror of the repo layout (same
# relative paths, so imports are byte-identical) and diffs it against the
# committed generated dirs. This check never touches shared source, so it is
# safe to run concurrently with any other check (the old in-place regen wiped
# lib/*/src/generated mid-run and made parallel web/test-api checks fail with
# false missing-import errors).
#
# On a clean diff it then verifies the committed generated code compiles,
# scoped to just the two generated libs (incremental, fast when warm).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
tmp="$(mktemp -d /tmp/codegen-check.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/lib/api-client-react/src" "$tmp/lib/api-zod/src"
# orval parses the fetch mutator file, so mirror it at the same relative path.
cp "$root/lib/api-client-react/src/custom-fetch.ts" \
   "$tmp/lib/api-client-react/src/custom-fetch.ts"

cd "$here"
CODEGEN_OUT_ROOT="$tmp" pnpm exec orval --config ./orval.config.ts
CODEGEN_OUT_ROOT="$tmp" node ./gen-index.mjs

status=0
diff -ru "$root/lib/api-client-react/src/generated" \
         "$tmp/lib/api-client-react/src/generated" || status=1
diff -ru "$root/lib/api-zod/src/generated" \
         "$tmp/lib/api-zod/src/generated" || status=1

if [ "$status" -ne 0 ]; then
  echo ""
  echo "codegen:check FAILED: committed generated code is stale relative to"
  echo "lib/api-spec/openapi.yaml. Run:"
  echo "  pnpm --filter @workspace/api-spec run codegen"
  echo "and commit the result. (The regen swaps output in atomically, so it"
  echo "is safe to run even while other checks are in flight.)"
  exit 1
fi

echo "codegen:check: generated output matches the committed dirs."

# Verify the committed generated code compiles (scoped: only the two
# generated libs and their upstream refs, not the whole lib solution).
# The flock serializes declaration emit with every other tsc --build /
# lib-reading typecheck (they all take the same lock), so concurrent checks
# never read half-rewritten lib declarations.
cd "$root"
flock /tmp/wf-tsc-libs.lock pnpm exec tsc --build lib/api-client-react lib/api-zod
