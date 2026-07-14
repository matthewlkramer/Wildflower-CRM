---
name: Additive ledger read-cutover prod gate
description: Why an additive dual-write→backfill→flip-reads migration is only safe once parity runs on PROD, and the test-fixture corollary after a read flip.
---

# Additive ledger read-cutover: parity must run on PROD before the flip is trusted

When migrating a linkage off scattered legacy columns onto an authoritative ledger
table via the additive sequence **dual-write → backfill → verify parity → flip
reads → (much later) deprecate**, the read flip is only safe in a given
environment once the parity gate has been run **in that environment**.

**Why:** dual-write only covers *go-forward* writes. Every row that already
existed before dual-write started is linked through the legacy columns ONLY until
the backfill inserts its ledger row. So a green parity run in **dev** does NOT
prove prod is consistent — prod has its own pre-existing rows that only the prod
backfill + a prod parity run can prove are mirrored. A premature prod flip makes
the flipped reads silently miss every legacy-only link (conflict checks read
"unlinked", amounts read as `missing`).

**How to apply:** treat the prod cutover as a human release gate — apply the
schema + backfill SQL to prod (`$PROD_DATABASE_URL`), then run the parity
script(s) against prod and require **zero blocking drift** before/with the Publish
that ships the flipped reads. Make the payment-side parity gate (per anchor row:
legacy-unlinked == ledger-unlinked) BLOCKING, not just gift/amount parity — it is
what positively rules out legacy-only rows.

## Test-fixture corollary (after a read flip)

Once reads are flipped to the ledger, any integration fixture that seeds a
pre-existing link using ONLY the legacy column (e.g. `matched_gift_id` /
`group_reconciled_gift_id`) no longer creates a valid "already-linked" state — the
flipped conflict check reads the ledger and sees nothing. Symptom: a conflict test
that expected a clean `409` instead gets `200` (op wrongly allowed) or a `500`
(the still-dual-written legacy unique index throws). **Fix the fixture, not the
read:** make the seed helper also insert the ledger row (mirroring production's
dual-write) whenever it seeds a legacy link. Keep at least one *ledger-only*
assertion (a row linked ONLY via the ledger must read as linked) as the regression
guard that proves reads consult the ledger, not the legacy columns.

## Publish-window junk pointers (audit before the parity backfill)

The window between the design cutover and the actual Publish is dangerous in a
different direction: users acting in the **old build's UI** keep writing legacy
pointer columns, and some of those writes are junk under the new model (e.g. a
deposit-level gift link on a row that is settlement-only per-charge in the target
design). The parity backfill cannot tell junk from real — it faithfully converts
every legacy pointer into a counted ledger row, which can double-count once the
proper per-charge/fine-grained link is (re)made.

**How to apply:** before running the parity backfill on prod, census the legacy
links written during the publish window (by `updated_at`) and inspect each one:
is it a link the new model would have written? Clear stale ones with a small
guarded migration ordered BEFORE the parity file (guard on exact id + exact stale
value + no counted ledger row, so it no-ops if parity already ran).

## Go-live ordering (parity gate vs derived-persisted recompute)

When the same release also recomputes a **derived-persisted** rollup that is sourced
from the ledger (e.g. `quickbooks_tie_status` via `backfill:gift-qb-tie`), the order
is: re-apply backfill SQL → **parity (must pass)** → recompute the rollup. Never run
the rollup recompute against an unverified ledger.

**Why:** the recompute overwrites the cached status from `SUM(amount_applied)`; if the
ledger is missing legacy-only links, it bakes wrong statuses (mass `missing`) into the
column, turning a recoverable gap into a persisted regression.

**How to apply:** re-apply the idempotent backfill SQL on **both** sides of Publish
(old non-dual-writing code keeps writing legacy-only links right up to the deploy
swap, incl. the 30-min QB worker; the post-Publish re-apply closes the deploy window).
Run the full parity script (not an inline spot-check subset — only it proves the
status-mismatch / link-presence / final-amount-coverage blocking checks) and require
exit 0 before the recompute. Caveat: a one-directional backfill (e.g. promotes
legacy-loan→`loan` only) cannot repair a publish-window *reverse* legacy edit, so the
parity gate — not the backfill — is the real guarantee. Rollback after the recompute
must freeze finance writes (old buggy deriver re-stales touched rows) and fix-forward
+ re-run the recompute, not just revert.
