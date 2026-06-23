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
