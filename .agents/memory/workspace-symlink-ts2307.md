---
name: Missing workspace symlink reads as TS2307, not stale decls
description: When a leaf artifact typecheck fails with "Cannot find module '@workspace/...'", the workspace symlink is missing — run pnpm install, don't rebuild lib decls.
---

A leaf artifact (e.g. `artifacts/wildflower-crm`) can suddenly fail typecheck
with `error TS2307: Cannot find module '@workspace/<lib>' or its corresponding
type declarations` even though the lib builds fine and is listed in the
artifact's `package.json` as `workspace:*`.

**Root cause:** the pnpm symlink under
`artifacts/<app>/node_modules/@workspace/<lib>` is missing. pnpm sometimes drops
a workspace symlink (e.g. after codegen / partial installs) while leaving the
others intact. The whole module is unresolvable, so every downstream use of its
exports also errors (e.g. `loc` params go implicit-`any` → TS7006 cascade).

**Diagnostic:** `ls -la artifacts/<app>/node_modules/@workspace/` — a declared
dep with no symlink confirms it.

**Fix:** `pnpm install` (regenerates symlinks; lockfile stays up to date).

**Why this matters:** TS2307 is easy to misread as a stale composite-lib
declaration problem (the usual "property does not exist" / rebuild-decls advice
in this repo). It is NOT — `tsc --build` / rebuilding `dist` won't help when the
symlink itself is gone.

**How to tell them apart:**
- TS2307 "Cannot find module" → missing symlink → `pnpm install`.
- TS2305 "Module has no exported member" / "property does not exist" → stale lib
  declarations → rebuild decls (`tsc --build` / per-lib `tsc -p`).
