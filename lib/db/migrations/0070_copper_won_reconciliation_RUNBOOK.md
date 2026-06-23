# Runbook — 0070 Copper "Won" reconciliation

## What this does

Restores and re-codes the **verified residual corrections** found by reconciling
the 793 Copper "Won" opportunities against the PRODUCTION CRM. It is **data only**
(no schema change) and is delivered as one idempotent SQL file applied by a human:

```bash
# dev (note: dev has drifted from prod for a few of these rows — see below)
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0070_copper_won_reconciliation.sql
```

```bash
# prod
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0070_copper_won_reconciliation.sql
```

`psql -1` wraps the whole file in ONE transaction; the file has **no** top-level
`BEGIN/COMMIT`.

## Step 1 — Reconciliation summary (the headline finding)

There was **no mass disappearance** of Copper "Won" gifts. Of 793 Copper "Won"
opportunities:

- **~687 are present** in prod 1:1.
- **~106 "unmatched" are ~95% consolidation** — the same dollars are already in
  prod, folded into a *parent* or *merged* gift (multi-year pledges collapsed to
  one record; hub regrants rolled up under the funder's gift; a matching grant
  merged into the matched gift). The money is there; only the granular Copper row
  is "missing".
- The genuine residue handled by this file: **3 re-codes / splits**, **1 missing
  allocation**, **7 truly-absent gifts restored** (incl. Klau), **1 un-merge**,
  **3 Nash hub regrants linked to schools** + a Nash split, and the **Stranahan
  pledge restructure** (1 payment → 2 × $300k with a full 21-row regrant rebuild).

A small set is **intentionally deferred** (see "Deferred / not done" at the end).

## What each step changes

| Step | Change | Net effect |
| --- | --- | --- |
| 2 | Mackenzie Scott $7M gift `recEYnjOAlCR4a5Lu` — re-distribute 3 of 6 allocations to $1.5M / $1.25M / $1.75M | **NET-ZERO**, header stays $7M |
| 3 | Valhalla FY23 payment gift `F-mLU13c5LshbcHAt2dwC` — add the missing $500k allocation | gift now has scope |
| 4 | Restore **7** absent Copper gifts (Maddox, Sauer ×2, Mortenson, 20/22, Anonymous stock, Klau) | +7 gifts, +7 allocations |
| 5 | Gates / Tosha — un-merge the $3,500 merged gift into a $875 Tosha gift + a $2,625 Gates **matching** gift | 1 gift → 2 gifts |
| 6a | Nash FY21 hub `rec2twqm58PjFRhhf` — link Sundrops / Flame Lily / Lotus | 3 allocations get a school |
| 6b | Nash FY23 hub `reci8qgNnjGYbC1os` — split $70k → $60k + new $10k to Jun Zi Lan | +1 allocation, parent total unchanged |
| 7 | Stranahan pledge `rec8J1Lbc9jYMzG5d` — raise `recwKC3JHKRY2QYHe` to $300k (FY21, QB date 2021-01-26), mint `stranahan-fy22-payment` $300k (FY22, 2021-12-13), drop 9 legacy allocations and rebuild 10 FY21 + 11 FY22 regrants | 1 payment → 2 × $300k; pledge header unchanged at $600k |

### Restored gifts (step 4)

| Gift PK | Copper id | Name | Amount | Donor | FY | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `copper-8002495` | 8002495 | Zinnia Gift FY18 | $24,000 | org J.F Maddox `recnmL7uNKTAQpZg2` | fy2018 | alloc → Zinnia Fields `recWDdzadbfzlnLlF`, school_startup |
| `copper-19826757` | 19826757 | Sauer Renewal (ECE/K-12) | $20,000 | org Sauer `recXsKWPyEdi4MW0f` | fy2021 | gen_ops |
| `copper-26819504` | 26819504 | Sauer FY24 Renewal | $20,000 | org Sauer `recXsKWPyEdi4MW0f` | **fy2024** | receipt date 2023-06-28 falls 2 days inside fy2023; booked fy2024 per the gift name — **verify the intended FY** |
| `copper-26273518` | 26273518 | Mortenson Renewal FY23 | $20,000 | org Mortenson `recIDJIhAo1tuXS3A` | fy2023 | gen_ops |
| `copper-36666461` | 36666461 | 20/22 Act FY26 | $20,000 | org 20/22 `recRGn3fb67g5TCuH` | fy2026 | gen_ops |
| `copper-35272606` | 35272606 | Anonymous stock gift | $20,071 | **person** Anonymous Seed Fund Donor `reckcWrAIWUfuh8mU` | fy2026 | payment_method = `stock` |
| `copper-23839978` | 23839978 | Klau gift (step 4.7) | $20,000 | **household** Rick & Molly Klau `recE2xUxjviG0RowP` | fy2021 | alloc → Flame Lily `recMfJhJlMpnYzQ0x`, school_startup. Donor decided: household (not the Fidelity DAF) |

All restored allocations are `entity_id = wildflower_foundation`,
`restriction_type = unclear`, and `intended_usage = gen_ops` unless the table notes
`school_startup`. Derived revenue-coding columns (`object_code`, `revenue_*`,
`coding_flags`) are left NULL — code these later in-app if desired. These are
historical pre-QuickBooks gifts, so each will show `quickbooks_tie_status = missing`
(expected; they have no QB record).

## dev vs prod drift (important)

All record IDs were verified against **production** and are authoritative. The
**dev** DB has independently drifted from prod for a few rows; the file is written
to converge **both** environments:

- **Gates / Tosha (step 5)** — already un-merged in dev (two gifts) but still
  merged in prod (one $3,500 gift). The `INSERT … WHERE NOT EXISTS` of the matching
  gift is a no-op in dev; the convergence `UPDATE`s fix the donor on the $875 gift
  and set `gift_being_matched_id` (NULL in dev).
- **Valhalla (step 3)** — the payment gift does not exist in dev, so the allocation
  INSERT is a clean no-op there (it is `WHERE EXISTS` the parent gift). In prod the
  gift exists and gets its $500k allocation.

Every INSERT that depends on a parent row is **FK-safe** (no-ops if the parent is
absent); every UPDATE sets an **absolute** target and is guarded so a re-run
touches 0 rows.

## Ordering

Independent — **no Publish step required**. Every column, enum value
(`payment_method = stock`, `restriction_type = unclear`), entity slug
(`wildflower_foundation`), and `fiscal_years` id used here already exists in prod.

## Idempotency

Safe to re-run. Verified on dev: a second and third apply report **all 0-row
no-ops** (`UPDATE 0` / `INSERT 0 0`) across every statement.

- Gift INSERTs are guarded `NOT EXISTS` on **both** the synthetic PK and the
  `legacy_gift_id`, so a later Airtable re-import under a rec-id cannot duplicate.
- Allocation INSERTs are guarded `NOT EXISTS` on the allocation id **and**
  `EXISTS` the parent gift.
- Money re-codes (step 2) and the $70k→$60k split (6b) are guarded on the expected
  current value.
- School links (6a) are guarded on `school_recipient_id IS NULL`.
- Stranahan restructure (step 7): the gift `UPDATE` is on an absolute target, the
  FY22 gift `INSERT` is `NOT EXISTS`-guarded, the legacy-allocation `DELETE`
  excludes the rebuilt rows (`id NOT LIKE 'ga-stranahan-fy21-%'`), and both rebuild
  `INSERT`s are `NOT EXISTS`-guarded — so a re-run deletes 0 / inserts 0.

## Verify (by STATE, not clean exit)

```sql
-- Step 2: three re-coded rows + unchanged total = $7,000,000
SELECT id, sub_amount FROM gift_allocations WHERE gift_id = 'recEYnjOAlCR4a5Lu' ORDER BY sub_amount DESC;
SELECT sum(sub_amount) FROM gift_allocations WHERE gift_id = 'recEYnjOAlCR4a5Lu';  -- 7000000.00

-- Step 3: Valhalla allocation present
SELECT id, sub_amount, entity_id, grant_year FROM gift_allocations WHERE gift_id = 'F-mLU13c5LshbcHAt2dwC';

-- Step 4: six restored gifts, each with exactly one allocation summing to the header
SELECT g.id, g.amount, count(a.id) allocs, sum(a.sub_amount) alloc_sum
  FROM gifts_and_payments g LEFT JOIN gift_allocations a ON a.gift_id = g.id
 WHERE g.id LIKE 'copper-%' GROUP BY 1,2 ORDER BY 1;

-- Step 5: Gates/Tosha un-merge (Donor XOR holds on each)
SELECT id, amount, organization_id, individual_giver_person_id, type, gift_being_matched_id
  FROM gifts_and_payments WHERE id IN ('recGpltnPNwQQXuQ3','recYeA9b5NLTUTWUE');
-- Expect: recGpltnPNwQQXuQ3 = $875, person rec5mpAQy007hRwoW, standard_gift
--         recYeA9b5NLTUTWUE = $2625, org recmFiVt4H3XWM4dE, matching_gift, matched→recGpltnPNwQQXuQ3
SELECT id, gift_id, sub_amount FROM gift_allocations
 WHERE id IN ('synth-ga-recGpltnPNwQQXuQ3','synth-ga-recYeA9b5NLTUTWUE');
-- Expect: $875 alloc on recGpltnPNwQQXuQ3, $2625 alloc on recYeA9b5NLTUTWUE

-- Step 6: hub regrant links
SELECT id, gift_id, sub_amount, school_recipient_id FROM gift_allocations
 WHERE id IN ('recdbFJZ0KbLBNwak','rece7Ccdyy0nKcfcq','reco8ENNbxNwTimot',
              'synth-ga-reci8qgNnjGYbC1os','ga-copper-25936948')
 ORDER BY gift_id, sub_amount DESC;
-- Expect: Sundrops/Flame Lily/Lotus on Nash FY21; $60k + new $10k (Jun Zi Lan) on
--         reci8qgNnjGYbC1os.

-- Step 7: Stranahan restructure — two $300k payments, each allocation set = $300k
SELECT id, amount, date_received, grant_year FROM gifts_and_payments
 WHERE id IN ('recwKC3JHKRY2QYHe','stranahan-fy22-payment') ORDER BY date_received;
-- Expect: recwKC3JHKRY2QYHe $300k 2021-01-26 fy2021;
--         stranahan-fy22-payment $300k 2021-12-13 fy2022
SELECT gift_id, count(*) n, sum(sub_amount) total,
       count(*) FILTER (WHERE school_recipient_id IS NULL) null_school
  FROM gift_allocations
 WHERE gift_id IN ('recwKC3JHKRY2QYHe','stranahan-fy22-payment')
 GROUP BY gift_id ORDER BY gift_id;
-- Expect: recwKC3JHKRY2QYHe 10 rows / $300k / 1 null school (= Wildwood, see flag);
--         stranahan-fy22-payment 11 rows / $300k / 0 null.
SELECT ask_amount, awarded_amount FROM opportunities_and_pledges
 WHERE id = 'rec8J1Lbc9jYMzG5d';  -- 600000 / 600000 (unchanged)
```

## Deferred / NOT done in this file

These were **intentionally left out** — each needs a decision or a Copper
reconciliation that could not be done blind. Surface, don't guess.

1. **Stranahan FY21 "Wildwood" $30k regrant — school link is NULL.** The dollars
   are booked (step 7, FY21) and tie to $300k, but `school_recipient_id` is NULL
   because **Wildwood does not exist in the CRM `schools` table in either dev or
   prod**. `schools` was a one-time Airtable seed (there is **no live Airtable→
   schools sync**), so a school added or renamed in Airtable after the seed never
   landed. Link the school once a Wildwood record exists — e.g. via a future
   Airtable→`schools` sync, or by inserting the school manually. Find the booked
   row with:
   `SELECT id, sub_amount FROM gift_allocations WHERE id = 'ga-stranahan-fy21-wildwood';`
2. **Stranahan regrant `intended_usage` was defaulted uniformly to `school_startup`**
   (region left null; the school link is the precise scope). If any line is actually
   general-operating support, change it per-row in the app.
3. **Nash FY21 remaining $10k** (`recg5uQrZgnWm9FQf`, MA) and the **separate $7k
   "Goldenrod" gift** (`rec6B0yqPIR47JbIa`) — not in the Copper FY21 Nash regrant
   list; reconcile against Copper first.
4. **Government grants** — CMO Replication FY27/FY28 and the USDOE pass-through —
   out of scope; deferred to the separate government-grants discussion.
5. **Wildflower → Ivy $7k outbound** — outbound grant, not donor revenue; out of
   scope.
