# 0157 — Recode the counted-duplicate clusters (ADR linear-money-model §6/§7 step 4)

## What this does

Recodes the 10 production clusters where ONE evidence unit (QB payment /
deposit line) carried counted `payment_applications` rows to MULTIPLE gifts.
After it runs, every evidence unit has at most one counted row — the
precondition for the counted-uniqueness index (separate later migration).

- **7 merges** — one survivor gift absorbs the cluster: allocations move to
  the survivor, loser gifts are archived (never deleted), loser counted rows
  are deleted, the survivor's counted row becomes the full unit amount.
- **2 splits** — Omidyar's 2019 $1M wire (covers two *different* pledges) and
  Kao's $10k deposit (two distinct $5k checks) get deterministic split-unit
  children (`<parent>:split:1/2`), exactly the shape the runtime split action
  produces; each counted row re-anchors to its child.
- **1 re-point (Frey)** — not a merge: prod also holds a matched-but-uncounted
  $30k Frey check from 2024-05-30. The FY24 gift becomes a standalone gift
  counted against that check (detached from the pledge, NOT archived); the
  pledge becomes FY25–FY26, paid in full by the single $60k wire — one gift
  with fy2025 + fy2026 allocations.
- **Expected-payment backfill** — the two Omidyar pledges and the Frey pledge
  get their historical installment schedules (fiscal-year-anchored planned
  dates; the actual receipt dates live on the gifts).
- **Re-derivation** — paid/status/stage/written_pledge/win_probability are
  re-derived for the 4 affected pledges, mirroring the current
  `deriveOppFields`.

## Apply (human-run, from the repo root)

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0157_recode_counted_duplicate_units.sql
```

- Single transaction (`-1`); the postflight block RAISEs on any invariant
  failure and everything rolls back.
- Idempotent: a second run writes zero rows everywhere.
- Pure DML — no Publish/schema dependency. Must run BEFORE the future
  counted-uniqueness index migration.

**Expect a possible clean abort.** The dev database does not contain these
production rows, so this file could only be parse/plan-checked against the
schema, never executed end-to-end — prod is the first true execution. Every
row fact was verified read-only against prod on 2026-07-23, and the
pre/postflight blocks make any surprise a full rollback with a labeled
`0157 …` error message rather than a partial apply. If it aborts, nothing
changed — report the error message back instead of retrying.

## Expected outcome

- 9 loser gifts archived; 13 surviving gifts each with allocations summing
  exactly to the gift amount (incl. the standalone Frey FY24 gift).
- 4 split-unit children created; the two parents derive as terminal "split"
  rows with no claims.
- Global counted-duplicate count = 0 (postflight E1 enforces this globally,
  so it also proves no cluster was missed).
- The formerly matched-but-unaccounted Frey check `2fDjAxyTfYL0h1Jx8xyd1`
  now carries the FY24 gift's counted row (its stamped 'matched' status
  becomes truthful).
- Pledges: `recL1luStEQ05Ca9r`, `recmvAyYs3BB65oET` unchanged
  (cash_in/complete, paid as before); `recXg24nW0jTUOyE4` paid becomes
  **$50,799.50** (+50¢, see LISC below); `receJJXlRMjmar0y6` renamed
  **Frey FY25-26**, still cash_in/complete, paid stays $60,000 (now one $60k
  gift instead of two $30k gifts; the FY24 $30k moves off-pledge).

## Judgment calls to be aware of (all ratified 2026-07-23, recorded in the ADR)

1. **Omidyar 2019 (`4Jn9…`) is SPLIT, not merged** — its two gifts sit on two
   different pledges; a merge would corrupt one pledge's `paid` rollup.
2. **Nash donor attribution shifts** — two of the three former gifts were
   attributed to the **Indira Foundation**; the merged gift lives under the
   **Avi and Sandra Nash household** (the actual wire payer, per the QB
   payer name). Org-level giving history for Indira Foundation loses these
   rows (they remain visible as archived gifts). All six school-designation
   allocations are preserved intact.
3. **LISC Q1 FY24 gains 50¢** — the two former gifts summed $7,712.00 but the
   money received is $7,712.50; the gift is corrected UP to the money and the
   GV direct-to-school allocation absorbs the difference.
4. **Kamvar keeps 4 allocation rows** (not the ADR's "3") — Rising Tide
   consolidates to $326,436.14, but the $15,000 partnership passthrough
   (counts_toward_goal = false), AZ gen-ops, and Northern-NJ gen-ops rows move
   intact so region analytics keep their grain.
5. **Frey is two real money events, not one** (user ruling 2026-07-23) — QB
   shows a $30k check received 2024-05-30 (stamped matched but carrying no
   counted row) *and* the $60k wire of 2025-04-08. The FY24 renewal was paid
   by the check, so the FY24 gift becomes a **standalone** gift (detached
   from the pledge, not archived, dated 2024-05-30) whose counted row
   re-points onto the check. The gift dates previously in CRM (2024-03-15 /
   2025-03-25) were hand-entered, not money dates.
6. **The pledge is FY25–FY26** — $60,000 paid in full, upfront, by the single
   wire: one gift with fy2025 + fy2026 $30k allocations (the FY26 one
   Wildflower-restricted, per the next-fiscal-year rule). The pledge header is
   renamed **Frey FY25-26** and its fy2024 plan allocation retags to fy2026;
   expected payments backfill as fiscal-year-anchored FY25/FY26 installments.

## Verify after apply

Run the queries in the trailing comment block of the SQL file. Quick pass:

```bash
psql "$PROD_DATABASE_URL" -c "SELECT count(*) FROM (SELECT payment_id FROM payment_applications WHERE payment_id IS NOT NULL AND link_role='counted' GROUP BY payment_id HAVING count(*)>1) d;"   # expect 0
psql "$PROD_DATABASE_URL" -c "SELECT count(*) FROM pledge_expected_payments WHERE id LIKE '0157-pep-%';"  # expect 8
```

Then re-run the full file once more — every statement must report
`UPDATE 0` / `INSERT 0 0` / `DELETE 0`.

## Rollback

Nothing to do on failure: any postflight violation aborts the single
transaction. After a successful apply, reversal would be a new reviewed
migration (the file records every changed id).
