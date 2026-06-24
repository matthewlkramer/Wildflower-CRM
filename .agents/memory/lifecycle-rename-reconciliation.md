---
name: Schema-rename reconciliation before Publish
description: How to clear a stuck post-merge column RENAME so dev catches up and the Publish diff is safe; plus the migration-file + transaction gotchas a rename exposes.
---

# Reconciling a stuck column RENAME (was_pledge→written_pledge, payment_on_pledge_id→opportunity_id)

The opportunity-lifecycle redesign renamed two columns:
`opportunities_and_pledges.was_pledge → written_pledge` and
`gifts_and_payments.payment_on_pledge_id → opportunity_id` (and ADDED a new
`opportunities_and_pledges.paid` rollup). Interactive `drizzle-kit push` in
post-merge can't answer the rename prompt → aborts → dev stalls (see
post-merge-push-abort.md). This is the settled way to clear it.

## Reconciliation recipe (dev, agent-safe, reversible)
1. Apply the renames **by hand, guarded/idempotent** via `psql "$DATABASE_URL"`:
   a `DO $$` block that renames only `IF EXISTS old AND NOT EXISTS new`.
2. Run `drizzle-kit push` (from `lib/db`). With the renames pre-done there is **no
   rename ambiguity left**, so push applies the remaining ADDITIVE changes
   non-interactively. Re-run push → "no changes" confirms dev == drizzle schema.
3. **Never** use `push-force` to get past a rename: `--force` auto-approves DROPs
   and treats an unresolved rename as drop+create (data loss). Pre-rename first.
4. Rebuild decls: `cd lib/db && pnpm exec tsc -p tsconfig.json`.

## Predict the Publish diff before telling a human to Publish
Run a dev-vs-prod diff of columns+tables+enums (information_schema + pg_enum).
**IN-PROD-NOT-IN-DEV must be EXACTLY the rename SOURCE columns** (here
`was_pledge`, `payment_on_pledge_id`) and nothing else — any other prod-only
column is a DROP the Publish would propose = abort. IN-DEV-NOT-IN-PROD is the
additive set Publish will create.

**Why:** Publish diffs dev-DB vs prod-DB. A clean diff here is the proof the
Publish is "2 renames + additive only".

## Publish UI rename confirmation (the catastrophic-if-wrong step)
Drizzle sees `was_pledge` removed and TWO new cols (`written_pledge`, `paid`),
so it asks which is the rename. The human MUST map:
- `written_pledge`  ← RENAME of `was_pledge`
- `paid`            ← **NEW column, NOT a rename** (boolean→numeric if mismapped)
- `opportunity_id`  ← RENAME of `payment_on_pledge_id`
Mismapping loses the sticky pledge flags or ALL gift→pledge links (then the
`paid` backfill derives 0).

## Gotchas a rename exposes in pending migration files
- **Stale column name in a pending data file.** A not-yet-applied data migration
  that references a column the SAME batch renames will fail when run *after*
  Publish ("column X does not exist"). After any rename, `rg` the pending
  `lib/db/migrations/*.sql` for the OLD name; fix to the NEW name and mark the
  file **post-Publish** in its runbook ordering. (Hit: `0070_copper`'s Stranahan
  payment INSERT used `payment_on_pledge_id`; fixed to `opportunity_id`, now must
  run after Publish and before the lifecycle `paid` backfill.)
- **No internal BEGIN/COMMIT in a `-1`-applied file** (repl.md preference). `-1`
  already wraps the file in one txn; an internal `BEGIN/COMMIT` yields
  "WARNING: there is no transaction in progress" and double-manages the txn.
  (Hit: `0072_reorg_backfill` carried its own BEGIN/COMMIT; stripped.)

## Prod data-file order (all idempotent, after Publish)
`0069_annie` → `0070_copper` (post-Publish; before lifecycle) →
`0070_opportunity_lifecycle_backfill` (populates `paid`) →
`0071_enum` (run WITHOUT `-1`; Publish likely already added the values) →
`0072_reorg_backfill` (needs the enum values + **repulled QB line detail** for a
complete re-code; safe but incomplete without it).
