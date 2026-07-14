# Runbook — 0121 Remap legacy funnel stages to verbal_confirmation

## What this does

The opportunity funnel `stage` no longer uses the three legacy
commitment/outcome values (`conditional_commitment`, `written_commitment`,
`cash_in`) — the app stopped writing them when the commitment signal moved to
the sticky `written_pledge` flag and the fully calculated `status`. 10 prod
opportunities from the Copper-import era still carry them:

| Legacy stage | Rows | All closed via |
| --- | --- | --- |
| `conditional_commitment` | 4 | `loss_type` (2 lost, 2 dormant) |
| `written_commitment` | 5 | `loss_type` (5 lost) |
| `cash_in` | 1 | `loss_type` (dormant) |

This migration remaps those rows to `verbal_confirmation` — the nearest modern
pre-close funnel position — so zero rows remain on legacy stage values. The
legacy values stay in the `opportunity_stage` pg enum (removing enum values
requires a type rebuild; not worth it once nothing uses them).

## Why it is safe

- **`status` is unchanged.** Status derivation (`deriveOppFields`) never reads
  stage: precedence is `loss_type` > fully-paid > `written_pledge` > `open`.
  All 10 rows have `loss_type` set, which pins status to `lost`/`dormant`
  regardless of stage.
- **`written_pledge` is unchanged.** It is sticky-true and legacy stages no
  longer latch it; the UPDATE does not touch the column.
- **Totals are unchanged.** No money or allocation rows are touched.
- **Derivation stays a fixed point.** Re-running `applyDerivedOppFields` on
  the remapped rows changes nothing (verified on dev: the backfill script
  reported 0 changed rows after the remap).
- **Idempotent.** The WHERE clause only matches rows still on a legacy stage;
  a second run touches 0 rows.
- Win-probability semantics: closed rows weight 0 by status in every
  projection/analytics read, so the stored `win_probability` is intentionally
  left alone.

## How to apply

Run after the code that documents this state has been published (no schema
change is required — this is data-only and works against the current prod
schema):

```
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0121_remap_legacy_stage_values.sql
```

Expected: `UPDATE 10`.

## Verify

```
psql "$PROD_DATABASE_URL" -c "SELECT count(*) FROM opportunities_and_pledges WHERE stage IN ('conditional_commitment','written_commitment','cash_in');"
```

Expected: `0`.

```
psql "$PROD_DATABASE_URL" -c "SELECT id, name, stage, status, loss_type, written_pledge FROM opportunities_and_pledges WHERE id IN ('recTn2RJgppIsjgDv','recfh0YZ8e5Js1vv1','recshi9Srdid53Ch8','recx2pj8EAY25kHNY','rec2YHolVH3pXiqIU','rec8jkTO0UGC6LmiH','recYZ3qlDtZ0W9G6z','recbYxTAUssWy1e5g','recfCES9q23SnanDc','rectHemay0VaaUCbv') ORDER BY id;"
```

Expected: all 10 rows on `stage = verbal_confirmation`, with `status`,
`loss_type`, and `written_pledge` exactly as they were before the run
(2 dormant + 2 lost conditional_commitment rows, 5 lost written_commitment
rows, 1 dormant cash_in row; `written_pledge = t` on all 10).

## Rollback

Data-only and reversible by hand if ever needed (the pre-run stage of each of
the 10 ids is recorded in the table above / task notes). No schema objects are
created or dropped.
