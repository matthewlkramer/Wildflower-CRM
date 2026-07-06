# Runbook — `loan_or_grant` read cutover (A002) PROD parity gate

## What this is

The A002 read cutover flips the loan-vs-grant READS onto the authoritative
`loan_or_grant` column. The analytics buckets (`giftCategorySql` /
`oppCategorySql` / `goalCategorySql`), the goals filter
(`fiscalYearEntityGoals.ts`), and the revenue-coding loan branch
(`revenue-coding.ts`) all now read `loan_or_grant` instead of the legacy signals
they supersede:

- gifts_and_payments — legacy `type='loan_fund_investment'`
- opportunities_and_pledges — legacy `fundraising_category='loan_capital'`
- fiscal_year_entity_goals — legacy `category='loan_capital'`

**This is a CODE-only cutover — there is NO new SQL to apply.** The schema column
was added by `0067` and backfilled by `0068`. The dual-write from A001 stays
intact, so `loan_or_grant` keeps tracking the legacy signals on every write.

## Why a gate (and not just Publish)

Because the reads now trust `loan_or_grant`, any row where the persisted flag
disagrees with what the legacy signal would derive is a row whose analytics
bucket / goal / revenue-coding SILENTLY changes at the cutover. The parity gate
proves that set is empty **on PROD** before we trust the flip. Dev parity is not
sufficient — PROD holds the live data the flip actually affects.

## The gate

`artifacts/api-server/src/scripts/parity-loan-or-grant.ts` derives
`loan_or_grant` from the legacy signal for EVERY row (through the same pure
mappers the dual-write uses) and compares it to the persisted column. Zero drift
on all three tables ⇒ the flipped reads produce byte-identical results to the
legacy reads. It exits `0` only on zero drift (`GATE: PASS`).

## Run it against PROD (read-only)

The script reads through `@workspace/db`, which connects via `DATABASE_URL`, so
point that at the prod connection string for this one invocation. The script only
issues `SELECT`s — it never writes.

```bash
# From the repo root. Read-only: only SELECTs are issued.
DATABASE_URL="$PROD_DATABASE_URL" \
  pnpm --filter @workspace/api-server run parity:loan-or-grant -- --out /tmp/loan-or-grant-parity-prod.json
```

Expected tail:

```
gifts:         <N>    mismatches: 0
opportunities: <N>    mismatches: 0
goals:         <N>    mismatches: 0

GATE: PASS
```

`--out` writes the full machine-readable report (per-row mismatches) for the
record.

## Interpreting the result

- **`GATE: PASS` (zero drift)** — the read cutover is safe to trust on PROD;
  proceed with Publish.
- **`GATE: FAIL` (any mismatch)** — do NOT trust the flip yet. Each mismatch is a
  real disagreement between the legacy signal and the persisted flag. Reconcile
  first: re-run the `0068` backfill (idempotent) to re-sync any rows the legacy
  signal reclassifies, or apply a targeted data correction (like the Gary fix in
  `0068`) for intentional legacy/flag divergences, then re-run this gate until it
  passes.

## Dev gate (same script, no prod)

The same script runs against dev (`DATABASE_URL` unset override) as the local
gate, and the read-source integration tests
(`artifacts/api-server/src/__tests__/loan-or-grant-dualwrite.integration.test.ts`,
the "read source (A002)" block) prove the buckets follow the flag even when the
legacy signal is deliberately desynced:

```bash
pnpm --filter @workspace/api-server run parity:loan-or-grant
pnpm --filter @workspace/api-server run test
```

## Out of scope

Dropping the legacy `type` column and retiring the dual-write are follow-ups —
NOT part of this cutover. The `type` column stays a real, editable field and
keeps dual-writing `loan_or_grant`.
