---
name: opp lifecycle derivation must be a true fixed point
description: deriveOppFields + its SQL backfill must converge in one pass; legacy stage='cash_in' is a written_pledge latch, NOT a status trigger.
---

# deriveOppFields must be idempotent, and the backfill SQL must mirror it exactly

`deriveOppFields` (pledgeStage.ts) is applied once per mutation by
`applyDerivedOppFields`, so it MUST be a true fixed point: feeding its own
output back in must change nothing. The prod backfill SQL
(`0070_opportunity_lifecycle_backfill.sql`) is the SQL mirror of the same
function and must produce identical results.

**The trap:** `status` reaching `cash_in` from `stage === 'cash_in'` is NOT a
fixed point, because a won row also overwrites `stage → 'complete'`. So pass 2
no longer sees `stage='cash_in'`, the status falls back to open/pledge, and the
`complete` stage reverts to `verbal_confirmation` — the row oscillates.

**The rule (matches task-360 spec):**
- `status='cash_in'` is **payment-driven only** (`paid >= awarded > 0`). Never a
  status trigger from the deprecated `stage='cash_in'` value.
- **UPDATED 2026-06-25:** the pure `deriveOppFields` no longer latches
  `written_pledge` from any stage value. It auto-latches `written_pledge=true`
  ONLY when an **unpaid grant letter** exists (`grantLetterUrl && !fullyPaid`);
  otherwise the flag is whatever was explicitly set. Status precedence stays
  `loss_type > cash_in (paid≥awarded>0) > pledge (written_pledge) > open`.
  ⚠️ The old prod backfill SQL (`0070_opportunity_lifecycle_backfill.sql`)
  predates this and mirrors the STAGE-latch logic — it must be re-mirrored to the
  grant-letter-unpaid rule before any re-backfill, or it will re-introduce
  over-pledging.
- A won row (`status` pledge|cash_in) ⇒ `stage='complete'`; a stale `complete`
  on a non-won row reverts to `verbal_confirmation`. lost/dormant keep their
  cultivation stage (loss_type override wins, stage never overwritten).

**Why it matters for verification:** applying a *non-idempotent* derivation to a
DB permanently destroys legacy `stage='cash_in'` signals (they become
`complete`/`verbal_confirmation`), so you cannot re-test the corrected backfill
on an already-migrated dev DB. Verify the corrected logic against synthetic
`VALUES` rows instead, and trust that prod runs once on pristine data.

**How to apply:** any change to status/stage/written_pledge derivation must be
made in BOTH `pledgeStage.ts` and the backfill SQL in lockstep, and proven
idempotent (second `psql` run reports `UPDATE 0`). A won pledge's stage is
`complete` even when only partially paid — integration tests that assert a
seeded `written_commitment`/`cash_in` stage *survives* a re-derive are stale.
