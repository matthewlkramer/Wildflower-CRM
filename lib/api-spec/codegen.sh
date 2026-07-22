#!/bin/bash
# Atomic codegen.
#
# The old in-place regen (orval clean:true) deleted lib/*/src/generated and
# rewrote it over several seconds. Any concurrently running check that imports
# those dirs (typecheck, vitest, api-server build) failed with a false
# "Cannot find module './generated'" during that window.
#
# This script generates into a temp mirror on the SAME filesystem as the repo
# (so directory moves are atomic rename syscalls), then swaps each generated
# dir in with a single atomic exchange (mv --exchange -T, renameat2
# RENAME_EXCHANGE). The dirs are never absent — not even for a syscall gap —
# and never observable in a half-written state.
# If the freshly generated output is byte-identical to the committed dir, the
# swap is skipped entirely (keeps mtimes and tsc's incremental cache warm).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

tmp="$here/.codegen-out"
rm -rf "$tmp"
mkdir -p "$tmp/lib/api-client-react/src" "$tmp/lib/api-zod/src"
trap 'rm -rf "$tmp"' EXIT

# orval parses the fetch mutator file, so mirror it at the same relative path.
cp "$root/lib/api-client-react/src/custom-fetch.ts" \
   "$tmp/lib/api-client-react/src/custom-fetch.ts"

cd "$here"
CODEGEN_OUT_ROOT="$tmp" pnpm exec orval --config ./orval.config.ts
CODEGEN_OUT_ROOT="$tmp" node ./gen-index.mjs

swap_in() {
  local rel="$1"
  local src="$tmp/$rel"
  local dst="$root/$rel"
  if [ -d "$dst" ] && diff -rq "$dst" "$src" >/dev/null 2>&1; then
    echo "codegen: $rel unchanged (no swap)"
    return
  fi
  if [ -d "$dst" ]; then
    # Atomic exchange: dst always exists, pointing at either the old or the
    # new tree. After the exchange, $src holds the old tree (cleaned by trap).
    # Fallback (non-GNU coreutils or no renameat2 support): two renames, with
    # a syscall-gap window where dst is briefly absent.
    if mv --exchange -T "$src" "$dst" 2>/dev/null; then
      echo "codegen: $rel updated (atomic exchange)"
    else
      echo "codegen: WARNING — mv --exchange unsupported; using two-rename" >&2
      echo "codegen: fallback (brief window where $rel is absent)" >&2
      local stale="$dst.stale.$$"
      mv "$dst" "$stale"
      mv "$src" "$dst"
      rm -rf "$stale"
      echo "codegen: $rel updated (two-rename fallback)"
    fi
  else
    mv "$src" "$dst"
    echo "codegen: $rel created"
  fi
}

swap_in "lib/api-client-react/src/generated"
swap_in "lib/api-zod/src/generated"
