# Runbook — 0077 Pledge cleanup (mis-flagged written pledges)

## What this does

Cleans up **44** opportunities/pledges that were wrongly flagged as written
pledges (`written_pledge = true`) and therefore pollute the **Pledges page**
(whose filter is purely `written_pledge = true`,
`routes/opportunitiesAndPledges.ts`). It is **data only** (no schema change) and
is delivered as one idempotent SQL file applied by a human. The friendly
"Research needed" badge label is a **separate frontend change** that ships via
Publish (`cleanup-queue.tsx` `REASON_LABEL`).

The reopened opportunities and the one kept-but-outstanding pledge are surfaced
for follow-up via the **existing** `cleanup_queue` table (the left-nav "Cleanup
Queue"), using `reason_code = 'needs_research'` — **no schema change** (the
unique index on `(target_type, target_id, reason_code)` makes seeding
idempotent). This mirrors `0059`, which seeds the same queue for
`conditional_commitment_stage` pledges.

## Decision provenance

All 44 ids were cross-checked against PRODUCTION and given a per-record decision.
The evidence + decisions live in:

- `exports/flagged-pledges-evidence.csv`
- `exports/flagged-pledges-remaining.csv`

## Record groups (ids verified against PROD)

| Group | Count | Change |
| --- | --- | --- |
| A — fully paid | 15 | `written_pledge = false` only; stays `cash_in` / `complete` / `1.0000` |
| B — dormant/lost | 3 | `written_pledge = false` only; `loss_type` still drives status (unchanged) |
| C — unpaid → reopen + research | 25 | `written_pledge=false`, `status='open'`, `stage='verbal_confirmation'`, `win_probability=0.9000` + one `cleanup_queue` row (`target_type='opportunity'`) |
| Gates Family $85k — keep + research | 1 | **No field change** (stays `pledge` / `written_pledge=true`); one `cleanup_queue` row (`target_type='pledge'`), $45k of $85k still outstanding |
| Keep, no change | 4 | untouched (`ahaxEJ3Nv3Gsc63vYzqS-`, `recIvPUfgyRv0F1KJ`, `recshOnvUb0A390qj`, `recx2pj8EAY25kHNY`) |
| Already archived | 1 | `recdkOIzI6ZQKTH2D` — left as-is, **not** resurrected |

**Net writes:** `written_pledge=false` on 43 rows (A 15 + B 3 + C 25); the
status/stage/win_probability update on the 25 Group C rows; 26 `cleanup_queue`
inserts (25 opportunity + 1 pledge).

## Why the explicit derived values

The hand-applied SQL bypasses `applyDerivedOppFields`, so it must set the derived
fields (`status`, `stage`, `win_probability`) itself. They mirror
`deriveOppFields` / `canonicalWinProbability`
(`artifacts/api-server/src/lib/pledgeStage.ts`):

- **Group A** (fully paid): `paid ≥ awarded > 0` ⇒ `status='cash_in'` regardless
  of `written_pledge`, so clearing the flag changes nothing derived — touch
  `written_pledge` only.
- **Group B** (dormant/lost): `loss_type` drives status, so the row stays
  dormant/lost — touch `written_pledge` only.
- **Group C** (reopen): not won, not paid, no loss, **and no grant letter** ⇒
  `status='open'`; `stage='verbal_confirmation'` whose canonical
  win-probability is `0.9000`. All 25 have `paid=0`, no `loss_type`, and no
  `grant_letter_url`, so `written_pledge` will **not** re-latch (a guard at the
  top of the file re-asserts this and aborts otherwise).

Re-deriving via the app afterward is a **fixed point** (no drift) — verified on
dev.

## Safety

- **Non-destructive** — only `UPDATE`s the 43 flagged rows and `INSERT`s into
  `cleanup_queue`; no `DELETE`s.
- **Idempotent** — the three `UPDATE`s are id-scoped **and guarded on
  `written_pledge = true`**, so a re-run after a successful apply matches 0 rows;
  the `cleanup_queue` inserts use deterministic ids
  (`'cleanup_nr_' || target_id`) and `ON CONFLICT (target_type, target_id,
  reason_code) DO NOTHING`, so an item a human has already resolved/dismissed is
  NOT resurrected.
- **Scoped** — the 5 "keep" rows and the already-archived `recdkOIzI6ZQKTH2D`
  are never touched (the Gates row gets only its single queue insert).
- **No `BEGIN`/`COMMIT`** — `psql -1` wraps the whole file in one transaction.

## Ordering

**Run AFTER Publish**, so the `cleanup_queue` table and the `needs_research`
badge label both exist. Every column used here already exists in prod.

## How to apply (production, by a human)

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0077_pledge_cleanup_mis_flagged.sql
```

The script `RAISE NOTICE`s before/after counts and a `0077 RESULT:` line with
the Group C, Gates, and `needs_research` counts so you can confirm the apply.

## Verify (by STATE) — run against prod after applying

```sql
-- Group C: all 25 reopened to open / verbal_confirmation / 0.9000
SELECT count(*) AS group_c_ok
FROM opportunities_and_pledges
WHERE written_pledge = false AND status = 'open'
  AND stage = 'verbal_confirmation' AND win_probability = 0.9000
  AND id IN (
    'rec0tyHATW1ntJA2D','rec39bWJVTDMmjwJh','rec3b1aly76zyeTdB','rec7kG6cJS6SOdb36',
    'recBZEm5IiE1IVLxk','recDuRwwzbgvsdNX8','recJh2jKA518aKvJJ','recK7gM3V9LSyQtEW',
    'recKNFnTdqWP6PQjU','recKurWNUmaLKTPlS','recOPn9HqPXCh097M','recRSZv2pRjTTyXV9',
    'recRxJVXpdT5QXkul','recSsLaVJjroL8Geb','recTFwj85oZP5VpsM','recU3ZlMQlCvQCg3h',
    'recbibJ4IB42Hhj5l','recd7VQZgCFPH3rlt','recdatu1WvYvO8oVu','recdpCTCJZAxv8qIm',
    'rececEiHHbxiRwrZ4','reciUdH6HwyzTkpx8','recmIKHDe8gXWazKy','recpEld2qjbdbOD7W',
    'recuetGdqrbtuJo5A'
  );  -- expect 25

-- Group A + B: flag cleared, status/stage untouched
SELECT id, status, stage, written_pledge, win_probability
FROM opportunities_and_pledges
WHERE id IN (
  -- A (15)
  'rec4XbW1UwjSGadHq','rec6xawrr24Wow3cn','recBUCBv816oLVcha','recCGCtAhiQWmJ8qu',
  'recGCXle5ZhCSdYbg','recHps5zYSSo1IKoO','recNiNwhw2c5LJTuq','recRvbMm19YncE3Lc',
  'recVh9o52xmTJ3mKA','recbulsRLbAKB2YpC','reccb1gbLB9gEzFWm','reck3ikZdklICf4ma',
  'recmuYoQ1aheant6K','recohEH4lZm5yixFm','recqFg4sHhrsj5rz6',
  -- B (3)
  'recshi9Srdid53Ch8','rectHemay0VaaUCbv','recfh0YZ8e5Js1vv1'
)
ORDER BY status, id;  -- all written_pledge = false; A=cash_in, B=dormant/lost

-- Gates $85k: unchanged pledge
SELECT id, status, stage, written_pledge, awarded_amount, paid
FROM opportunities_and_pledges WHERE id = 'rec3MTMlSE06qaL2L';
  -- status=pledge, written_pledge=true, awarded 85000, paid 40000

-- 26 open needs_research cleanup items (25 opportunity + 1 pledge)
SELECT target_type, count(*)
FROM cleanup_queue
WHERE reason_code = 'needs_research' AND status = 'open'
GROUP BY target_type;  -- opportunity: 25, pledge: 1

-- The keep + archived rows must be untouched (spot check)
SELECT id, status, written_pledge, archived_at
FROM opportunities_and_pledges
WHERE id IN ('ahaxEJ3Nv3Gsc63vYzqS-','recIvPUfgyRv0F1KJ','recshOnvUb0A390qj',
             'recx2pj8EAY25kHNY','recdkOIzI6ZQKTH2D')
ORDER BY id;
```

## Out of scope (deliberately NOT done here)

- No schema change (no `needs_research` column on opportunities — we reuse
  `cleanup_queue`).
- No loan-vs-grant reclassification of the "loan, not a pledge" rows — they are
  only being unflagged; `loan_or_grant` is a separate concern.
- The already-archived `recdkOIzI6ZQKTH2D` (PPP DC) is left untouched — do NOT
  resurrect it.
