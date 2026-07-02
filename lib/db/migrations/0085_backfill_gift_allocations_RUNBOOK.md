# 0085 — Backfill gift allocations + fix LaTania donor + flag Alia Peera

Data-only production backfill. Gives every active gift the one `gift_allocations`
row it must have (that child row is where all money scope + revenue coding live),
and makes two small companion fixes. **No schema changes** — the mint-path
allocation seeding + backstop guard ship as ordinary application code via Publish.

## What this does

1. **Backfills 32 orphan allocations.** Inserts exactly one `gift_allocations`
   row for each of the 32 active gifts that currently have zero allocations, per
   the owner-reviewed booking (see below). Each row: `sub_amount` = the gift
   amount, `grant_year` = the Wildflower fiscal year of `date_received`
   (Jul 1–Jun 30, named by the ending year), `counts_toward_goal` = true.
2. **Fixes the LaTania Scott $50 donor.** Names the empty placeholder person
   `5P8Z3pGo-0bxZege5U7ME` (LaTania Scott, scott.latania7@gmail.com) from the
   linked Donorbox donation (65426035 ↔ Stripe charge `ch_3TDwClAhXr9x8yiR0oquIFPK`).
3. **Flags the Alia Peera $184 gift** (`h6aekQnUjy9OuiiC3d03z`) for research via a
   `cleanup_queue` `needs_research` item.

### Booking (result: 9 → Black Wildflowers Fund, 23 → Wildflower Foundation)

Confirmed with the product owner; **overrides the QuickBooks signal** where they
conflict (QB `(deleted)` classes/accounts are unreliable). Fully enumerated by
gift id in the SQL — not re-derived in code.

- **A. Black Wildflowers Fund (9)** — entity `black_wildflowers_fund`, usage axis
  `donor_restricted`: $5,000 Education Leaders of Color; $480 William Penn
  Foundation; $150 Alexander Brown ×4; $104.70 + $17.80 Erica Cantoni; $50 LaTania
  Scott.
- **B. Wildflower Foundation, geographically restricted (4)** — entity
  `wildflower_foundation`, regional axis `donor_restricted`, region set: $30,000
  Banco Popular → PR; $20,000 Sauer Family Foundation → MN; $5,000 Scholler
  Foundation → PA; $184 Alia Peera → CA (also flagged for research).
- **C. Wildflower Foundation, school-designated (2)** — entity
  `wildflower_foundation` **with** `school_recipient_id` (the established
  convention; NOT the `direct_to_school` entity): $50,000 Ardinger Brown Family
  Fund → Grand Valley Charter (`rec4k51mmfjrlBfEM`), CO, regional restricted;
  $16,000 J. F Maddox Foundation → Marigold (`recigTQqe0ppRlzcz`), usage
  restricted.
- **D. Wildflower Foundation, unrestricted (17)** — entity `wildflower_foundation`,
  all axes unrestricted: $500 Kramer household, $40 Betsy Symanietz, $6.45 Daniela
  Vasan, and the 14 Amazon Smile micro-payouts ($6.36–$40.54, including the $23.47
  whose QB "Other Revenue" account was wrong).

## Safety

- **Idempotent.** Each allocation has a deterministic id (`ga_0085_<giftId>`) and
  is inserted only `WHERE NOT EXISTS` an allocation for that gift; the donor
  name-fix is guarded on the name still being null; the email insert is guarded on
  the global `lower(email)` uniqueness; the cleanup item uses
  `ON CONFLICT (target_type, target_id, reason_code) DO NOTHING`. Re-running after
  a successful apply is a no-op.
- **Non-destructive.** No `DELETE`s, no overwrites of existing scope.
- **Reference data pre-verified in prod:** entities `black_wildflowers_fund` +
  `wildflower_foundation`; regions PR/MN/PA/CA/CO; schools `rec4k51mmfjrlBfEM`
  (Grand Valley Charter) + `recigTQqe0ppRlzcz` (Marigold); fiscal years
  fy2018/2020/2021/2022/2023/2024/2026 — all present.
- **Ordering.** No new schema is required, so this can run any time after the code
  Publish that ships the mint-path seeding. Run **from the repo root**.

## Apply

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0085_backfill_gift_allocations.sql
```

The file wraps nothing in `BEGIN/COMMIT` on purpose — `psql -1` runs the whole
file as one transaction. It prints a pre-state `NOTICE` and a final `RESULT`
`NOTICE`.

## Verify (by state, not clean exit)

Expected on first apply (the SQL prints these; re-run to confirm the no-op):

- orphan gifts remaining = **0**
- allocations seeded (`ga_0085_%`) = **32** (BWF 9, Foundation 23)
- LaTania named = 1, LaTania email = 1, Alia flagged = 1

Independent re-check:

```sql
-- must be 0
SELECT count(*) FROM gifts_and_payments g
 WHERE g.archived_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g.id);
```

## Rollback

Reviewed data backfill — no automatic rollback. To undo (only if booked wrong):

```sql
DELETE FROM gift_allocations WHERE id LIKE 'ga_0085_%';
-- optionally: DELETE FROM emails WHERE id = 'em_0085_latania_scott';
--             DELETE FROM cleanup_queue WHERE id = 'cleanup_nr_h6aekQnUjy9OuiiC3d03z';
-- (the people name-fix is left in place; re-null only if truly required)
```
