# Runbook — 0070 Opportunity/pledge lifecycle backfill

**File:** `lib/db/migrations/0070_opportunity_lifecycle_backfill.sql`
**Type:** DATA-ONLY backfill (idempotent, re-runnable, non-destructive)
**Depends on:** the lifecycle-redesign schema diff (Publish) must be applied first.

## What it does

Re-derives the per-row lifecycle fields on `opportunities_and_pledges` to match
the new derivation in `artifacts/api-server/src/lib/pledgeStage.ts`
(`deriveOppFields` + `canonicalWinProbability`). It is the SQL mirror of that
pure function and recomputes, in order:

1. `paid` — SUM of linked **non-archived** gift `amount`s (`opportunity_id`), 0
   when none.
2. `written_pledge` — sticky-true latch (grant letter OR legacy commitment
   stage OR already-true). Never auto-cleared.
3. `status` — fully calculated: `loss_type` override → fully-paid `cash_in` →
   `written_pledge` `pledge` → `open`.
4. `stage` — pure funnel: won rows read `complete`; a stale `complete` on a
   non-won row reverts to `verbal_confirmation`; otherwise preserved.
5. `win_probability` — canonical default for `(status, stage, conditional)`.

`cash_in` is **payment-driven** in the steady state: a legacy `stage='cash_in'`
row with no full linked payment resolves to `pledge`/`open` (the underpaid
cash-in rows the redesign surfaces), not a sticky cash_in. This keeps the file a
true single-pass fixed point.

## Ordering

1. **Publish** the lifecycle-redesign schema/code first. The new columns
   (`paid`, `written_pledge`), the renamed gift column (`opportunity_id`), and
   the `complete` stage enum value must already exist in the target DB, or this
   file errors out (`ON_ERROR_STOP=1`).
2. Then apply this backfill.

## Apply

Dev:

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0070_opportunity_lifecycle_backfill.sql
```

Prod (run by a human — the agent cannot write to prod):

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0070_opportunity_lifecycle_backfill.sql
```

`-1` wraps the whole file in ONE transaction; the file has no top-level
`BEGIN`/`COMMIT`. A first run reports `UPDATE <n>`; **a second run must report
`UPDATE 0`** (idempotent).

## Verify

The SQL file ends with five verification queries (commented). All should return
0:

1. `paid_mismatch` — every `paid` matches the live non-archived linked-gift sum.
2. `stale_complete` — no non-won row left at `stage='complete'`.
3. `won_not_complete` — every won row reads `stage='complete'`.
4. `loss_mismatch` — `loss_type` override always wins on `status`.
5. Re-running the file reports `UPDATE 0`.

Dev apply (this session) result: 356 rows on first apply, single-pass idempotent
thereafter; all five checks pass; every `cash_in` row is genuinely fully paid.
