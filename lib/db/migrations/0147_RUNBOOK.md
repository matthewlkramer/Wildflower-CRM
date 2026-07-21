# Runbook — 0147 Allocation restriction cleanup (historical gifts & pledges)

## What this does

One-time, owner-reviewed data cleanup. No schema change, no app-code change,
no ongoing rule. Every row disposition below was reviewed by the owner
per-row; all allocation ids were re-verified against prod (read-only) on
2026-07-21 by gift/opportunity name, donor, and amount before this file was
written:

1. **Reference rows** (idempotent inserts): entity `partnership_passthrough`;
   fundable projects `minnesota_wei` and
   `observation_support_tech_development_deck` (nullable timeframes/goal —
   the UI shows "needs to be filled in"); regions
   `united_states__colorado__littleton` (city, parent Colorado) and
   `united_states__new_jersey__central_new_jersey` (region_within_state,
   parent New Jersey — confirmed absent in both prod and dev at build time).
2. **21 gift-allocation dispositions** — restriction-axis coding, stray
   `intended_usage='project'` cleared where no project applies, entity /
   region / purpose corrections (see the SQL comments for the per-row list).
3. **SPP FY20 gift split** — gift `recaVJheMROdraT6f` ($40k, 2019-12-17; NOT
   the $60k `KYlJxI6LgdsPHitxwFxYa`): its single allocation
   `reclDSARHtaFn68Zk` becomes $5k (Observation Support Tech Development
   Deck) + two inserted rows $15k (gen ops) and $20k (Greater Philadelphia +
   NJ donor-restricted).
4. **7 pledge-allocation dispositions** incl. the mirrored SPP FY20 pledge
   3-way split.

Out of scope (untouched by design): the 19 "Support for MN families" gift
allocations (stay `unrestricted`), the duplicate `seed_fund<TAB>` fundable
project, and any ongoing project↔restriction rule.

`display_usage` is trigger-maintained — the file never sets it; the
UPDATEs/INSERTs refresh it.

## Verified id resolutions (step-0 findings)

- Keith Tom ×5: all five allocation ids are `synth-ga-` prefixed —
  `synth-ga-recK66vALf2EAGqLz`, `synth-ga-recVzMXtinSLV7ErZ`,
  `synth-ga-reck83TRNTHlEllpz`, `synth-ga-rec4otYmrfowQAPw0`,
  `synth-ga-recIFKQo27eY4UAss`. The person (Keith Tom,
  `recgSdSGWkP7H3KhI`) has exactly these five gifts — all SSJ tech.
- CZI ×3 (`rechkRoxc9rWLdIqx` $2M, `recGjCuoB3aiwiuSA` $1M,
  `recHRlMbVvixYrnF2` $250k) all on opp "Chan Zuckerberg - large tech grant".
- `p4B2CXohYnJ0JD_jEDFJ4` confirmed Imaginable Futures (opp "MN emergency
  relief - immigration", $10k).
- `synth-ga-recLUda8QWJMtoHa0` (Fidelity) was already
  `usage_restriction_type='donor_restricted'`; the Group-1 UPDATE re-asserts
  the same value (still counts as 1 affected row).

## Dev drift (known, expected)

- Dev's SPP FY20 world diverged: dev has ONE merged $100k gift
  `recaVJheMROdraT6f` carrying both the $60k and $40k allocations, and the
  SPP FY20 **pledge** (opp `ahaxEJ3Nv3Gsc63vYzqS-` and allocation
  `h17sjkVVYjdiDMMj4F8Zc`) does not exist in dev at all.
- Consequences: in dev the gift ends with **4** allocations
  ($60k + $5k + $15k + $20k = $100k), and Step 5 (pledge split) affects
  **0 rows** in dev. Both are correct; the "exactly 3 allocations summing to
  $40k" check applies to prod only.

## Expected affected-row counts

| Statement | Prod | Dev | Re-run |
|---|---|---|---|
| entities insert | 1 | 1 | 0 |
| fundable_projects insert | 2 | 2 | 0 |
| regions insert | 2 | 2 | 0 |
| Group 1 (donor_restricted ×4) | 4 | 4 | 4* |
| Group 2 (wf_restricted ×2) | 2 | 2 | 2* |
| Group 3 (clear project usage ×5) | 5 | 5 | 5* |
| Sep NJ Gift | 1 | 1 | 1* |
| Sep FY21 KYDS slice | 1 | 1 | 1* |
| Ledley → Allium | 1 | 1 | 1* |
| Borealis → Minnesota WEI | 1 | 1 | 1* |
| Telluray ×2 | 2 | 2 | 2* |
| Amy Gips → MCM | 1 | 1 | 1* |
| Keith Tom ×5 | 5 | 5 | 5* |
| Penn ×2 | 2 | 2 | 2* |
| SPP gift 3a (update → $5k) | 1 | 1 | 0 |
| SPP gift 3b ($15k insert) | 1 | 1 | 0 |
| SPP gift 3c ($20k insert) | 1 | 1 | 0 |
| Pledge donor_restricted ×6 | 6 | 6 | 6* |
| Pledge SSJ project link | 1 | 1 | 1* |
| SPP pledge 5a (update → $5k) | 1 | 0 | 0 |
| SPP pledge 5b ($15k insert) | 1 | 0 | 0 |
| SPP pledge 5c ($20k insert) | 1 | 0 | 0 |

\* Plain UPDATEs re-assert the same absolute values on re-run — same row
count, no data change. Verify by row STATE (queries below), not row counts
or clean exit.

## Apply

Dev was applied by the agent on 2026-07-21 and verified. Prod is human-run:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0147_allocation_restriction_cleanup.sql
```

`psql -1` wraps the file in ONE transaction — do not add BEGIN/COMMIT inside.

No Publish ordering constraint: this file touches data only (no columns), so
it can be applied before or after the next Publish.

## Verify (read-only, after applying)

```sql
-- 1. Reference rows exist (expect 5 rows):
SELECT 'entity' kind, id FROM entities WHERE id = 'partnership_passthrough'
UNION ALL SELECT 'project', id FROM fundable_projects
  WHERE id IN ('minnesota_wei', 'observation_support_tech_development_deck')
UNION ALL SELECT 'region', id FROM regions
  WHERE id IN ('united_states__colorado__littleton',
               'united_states__new_jersey__central_new_jersey');

-- 2. SPP FY20 gift has exactly 3 allocations summing to $40,000 (prod;
--    dev shows 4 rows / $100,000 due to the merged-gift drift):
SELECT id, sub_amount, entity_id, intended_usage::text, fundable_project_id,
       regional_restriction_type::text, region_ids, display_usage
FROM gift_allocations WHERE gift_id = 'recaVJheMROdraT6f' ORDER BY sub_amount;
SELECT count(*), sum(sub_amount) FROM gift_allocations
WHERE gift_id = 'recaVJheMROdraT6f';

-- 3. SPP FY20 pledge mirrors the split (prod only; expect 3 rows, $40k):
SELECT id, sub_amount, entity_id, intended_usage::text, fundable_project_id,
       regional_restriction_type::text, region_ids
FROM pledge_allocations
WHERE pledge_or_opportunity_id =
  (SELECT pledge_or_opportunity_id FROM pledge_allocations
   WHERE id = 'h17sjkVVYjdiDMMj4F8Zc')
  AND sub_amount IN (5000.00, 15000.00, 20000.00)
ORDER BY sub_amount;

-- 4. Restriction-axis spot check (expect: every row donor_restricted except
--    the two wf_restricted ones):
SELECT id, usage_restriction_type::text FROM gift_allocations
WHERE id IN ('synth-ga-recbirvqCdEmatP5x','synth-ga-recLUda8QWJMtoHa0',
  'synth-ga-recKW139NRqZMhOL4','synth-ga-recI0soD5YTwzRP3H',
  'synth-ga-recReHXt8wdJxqRwL','synth-ga-recq19tTWDNtZgsKr')
ORDER BY id;

-- 5. Stray project usage cleared (expect intended_usage NULL on all 5,
--    with the new purpose_verbatim):
SELECT id, intended_usage::text, purpose_verbatim FROM gift_allocations
WHERE id IN ('synth-ga-reclJ7VAMQe17JylC','synth-ga-recuRLvecG7IgHgY6',
  'synth-ga-recC60zMGSevcjLgG','synth-ga-recMtzet0KyZdto6t',
  'synth-ga-recgVF3rooMZfTZYY');

-- 6. Keith Tom ×5 now on the SSJ project, donor_restricted (expect 5 rows):
SELECT id, fundable_project_id, usage_restriction_type::text,
       intended_usage::text
FROM gift_allocations
WHERE id IN ('synth-ga-recK66vALf2EAGqLz','synth-ga-recVzMXtinSLV7ErZ',
  'synth-ga-reck83TRNTHlEllpz','synth-ga-rec4otYmrfowQAPw0',
  'synth-ga-recIFKQo27eY4UAss');

-- 7. The 19 "MN families" allocations untouched (expect 0 rows changed —
--    every allocation on that gift still unrestricted):
--    (spot check: no gift_allocations rows updated today outside the
--    disposition set — optional.)

-- 8. Pledge dispositions (expect all donor_restricted; recXalWRvBNXgcfdv
--    also fundable_project_id = 'ssj'):
SELECT id, usage_restriction_type::text, fundable_project_id
FROM pledge_allocations
WHERE id IN ('synth-pa-rec3CKquETtrZrKQX-wildflower_foundation-fy2026',
  'rechkRoxc9rWLdIqx','recGjCuoB3aiwiuSA','recHRlMbVvixYrnF2',
  'p4B2CXohYnJ0JD_jEDFJ4','recXalWRvBNXgcfdv');
```

## Rollback

Data-only. The pre-change state of every touched row is captured in the
step-0 verification queries in the task record; reversing requires
re-applying the old values by hand (or restoring from a checkpoint/backup).
The two inserted rows per split can be deleted by their deterministic ids
(`ga0147-spp-fy20-*`, `pa0147-spp-fy20-*`) and the $5k allocation restored
to $40k.
