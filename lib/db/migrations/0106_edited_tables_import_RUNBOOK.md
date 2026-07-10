# Runbook — 0106 Apply the reviewed `edited-tables.xlsx` import

## What this does

Applies the fundraising team's hand-reviewed data corrections from
`data-import/edited-tables.xlsx` (July 2026 review pass) as ONE idempotent,
keyed, edited-cells-only SQL file. DATA-only (the schema shipped separately —
see ordering below). Sections, in apply order:

1.  **Seed rows** — entities (`direct_to_school`, `wildflower_foundation_tsne`),
    fundable projects (incl. 11 slugs referenced by allocations but missing in
    both envs, seeded with humanized names — see flags), payment intermediaries
    (Benevity, GiveMN, Network For Good, Headwaters Foundation for Justice,
    JP Morgan Charitable Giving Fund), Chicago Trust **payment-intermediary**
    rename → "The Chicago Community Trust", charters rows, and the
    `seed_fund\t` → `seed_fund` fundable-project dup merge (FK-repoint first).
2.  **gifts_and_payments cell edits** — 81 gift edits (68 `type` →
    `reimbursement`), 146 `fundraising_campaign` fills (donorbox prefix
    stripped), Omidyar survivor amounts 500k → 1M.
3.  **Omidyar merge-loser PA consolidation** — per amendment #3: shape-assert,
    delete loser counted PA, absorb into survivor keeper PA (500k → 1M + note).
4.  **gift_allocations** — 939 keyed updates (grant_year blank-fills, charter
    mapping, school_support_type, designation axes, black_wildflowers_fund typo)
    + 44 new rows (Walton null-gift split sums exactly 284,375.00 per gift;
    Drexel $90k → 2×$45k), all inserts EXISTS-guarded on the parent gift.
5.  **Archive removed gifts** — 4 archives (`archived_at`, never DELETE):
    FY26 CMO `recuk5liHKVem9aOh` + Omidyar merge losers.
6.  **staged_payments** — 3,019 keyed cell updates (entity_id 1,111,
    payer_type/payment_type, intermediary_id, real_payer_name, regional
    normalization, seed_fund, issues_to_address incl. VELA + refunded rows).
7.  **Ruling #2 QB matches** — 4 new staged→gift matches with the full exemplar
    stamp + one counted `payment_applications` row each; WWbM $3500 split
    (2625 + 875, machine-parseable membership note).
8.  **stripe_staged_charges** — entity/regional/project/seed_fund edits;
    `py_1SddlYAhXr9x8yiRM7pymWVa` re-target rec2rmf → reckIVxI (charge + PA
    d6396180 guarded); `ch_3SfP1dAhXr9x8yiR1VZkvcxL` new link exemplar stamp +
    stripe PA at gross 1000.00.
9.  **coding_form_rows** — 3 drive-link column-shift repairs.
10. **settlement_links** — her payout↔deposit matches: 73 already agree
    (untouched), 77 new confirmed links (`provenance='human'`, note
    `import edited-tables 2026-07`, multi-deposit payouts carry
    `members=[...] qb_deposit=<ids>`), ratified conflict-3 replace
    (po_1SgxOp re-pointed 4BzB → mnQd…, po_1Sfrgd inserted), 8 drag-fill key
    corrections folded in, exception po_1T1cDO left `proposed` + payout
    `issues_to_address`.
11. **Off-books entity re-points** — allocations of the 3 direct-to-school
    gifts (`recfC2SCEY643qShl`, `recQE2y1hKmifyDPj`, `recsy6YfVFoHcDOmQ`) →
    entity `direct_to_school`; RWJF `recc9rR57VNo1tHBm` (both allocations,
    incl. the merged-in one) → `wildflower_foundation_tsne`. After the qb-tie
    backfill these 4 gifts derive `quickbooks_tie_status='exempt'`
    (off-books = all allocations on no-payment entities).

## Ordering — do these IN THIS ORDER

1. **Publish first.** The file needs the 2026-07 schema (gift_type
   `reimbursement`, new staged/charge/allocation columns, `charters` table,
   `issues_to_address` columns). Running the file before Publish dies with
   "column/relation does not exist" and rolls back cleanly (single txn).
2. **Apply the data file** (single transaction; any error rolls back all of it):

   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0106_edited_tables_import.sql
   ```

3. **Re-run the derivations** (raw SQL bypasses the app's derivation hooks).
   Both scripts are idempotent full-table backfills that call the same helpers
   the write paths use:

   ```bash
   DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/api-server run backfill:gift-qb-tie
   DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/api-server run backfill:derived-opps
   ```

4. **Verify** (queries below).

## Why it is safe

- **Idempotent** — every UPDATE is keyed by PK and guarded; inserts are
  EXISTS-guarded on their parents and `ON CONFLICT … DO NOTHING`; archives
  guard `archived_at IS NULL`; status flips carry prior-status guards. Re-runs
  are no-ops.
- **Non-destructive** — archive-only (invariant #6); the sole DELETEs are the
  two Omidyar loser PA rows, each guarded by id + gift + amount and preceded by
  a shape assert (amendment #3, giftCombine precedent).
- **Edited cells only** — untouched columns are never written; Excel export
  artifacts (mojibake, `$` formats, date serials, formula spill, empty tags)
  were identified and excluded.
- **Single transaction** — `psql -1 -v ON_ERROR_STOP=1`; no partial applies.

## Expected dev↔prod differences

Dev was the rehearsal target and is stale relative to prod:

- 32 of the 44 new gift_allocations rows skipped on dev (parent gifts are
  prod-only) — all 44 parent gift ids verified present on prod → full apply.
- Most of sections 6–8 and 10 no-op on dev (QBO staged rows, stripe charges,
  payouts are prod-only). Prod coverage was verified read-only: all 3,019
  staged ids, 287 charge ids, 939 allocation ids, 153 payout keys exist.
- `UPDATE 1` on re-apply is normal (rows matched, values already equal).

## Flags / exceptions (surface, don't fix)

- **`rec2rmfIruZyp45QG` will derive `amount_mismatch`** (gift 1025.52 vs QB
  1000.00) after the qb-tie backfill. Expected and correct — the gift amount
  includes a processor-fee gross-up; leave for finance review.
- **`sEkmH4qxJDh3TDHVP-Fgq` matched_gift_id re-point SKIPPED** — ratified as a
  spreadsheet drag-fill error.
- **40/45 of her `matched_gift_id` cells are live-prod no-ops** — her export
  pre-dates the historical-group backfill and omitted
  `group_reconciled_gift_id`; the live links already agree.
- **FY26 CMO allocation left in place** — the gift `recuk5liHKVem9aOh` is
  archived; its allocation row survives by design (allocations have no
  archive column; archived gifts are already excluded from all rollups).
- **UNRESOLVED settlement conflict `po_1I5i1cAhXr9x8yiR69t8ZwmN`** — system
  proposed deposit `S6324tsnsorXe9onb1F_B` (qb_deposit 14240), her sheet says
  `4I_2kIso35-_ymt2YAl6c` (qb_deposit 14248); both $479.20, both pending. Not
  covered by the ratified conflict list, so per "insert only where absent" the
  file touches nothing. **Resolve in-app** in the reconciliation workbench.
- **Settlement conflicts 1&2: her matches dropped** (ratified) —
  `po_1LesMu…→XFeS5x…` and `po_1OUKPQ…→4itPl…`: those deposits are already
  linked (system-proposed) to other payouts; existing links kept.
- **`po_1T1cDOAhXr9x8yiRVWlrF59U` left `proposed`** — spans 3 QB deposits with
  a $14.41 total mismatch; payout `issues_to_address` set; confirm in-app.
- **11 fundable_projects seeded with humanized slug names** (cbd_exploration,
  mn_wei, mn_wei_startup_grants, mn_wei_scholarships, corina_training,
  bwf_philly_ece_expansion, nj_kyds, cathy_casserly, ss_ci,
  sep_alumni_grant_program, bwf_exchange) — rename to proper display names in
  the app when known.
- **`ftJ2Z_ceRs9xZrh5PKZao` flagged "refunded"** — its matched gift
  `recpNEvGy4bGmkOrh` may need reducing; finance to review.
- **VELA staged row** — `issues_to_address` notes "shrink allocs to 300k";
  allocation change deliberately NOT applied here.
- **Drift-window protection on the 5 new payment_applications inserts**
  (sections 7/8) — each PA insert only fires when its staged/charge row's
  `matched_gift_id` equals the import's intended gift. If a reviewer or the
  sync worker matched any of `p87NEtMPYvuC7LZ3lclXc`,
  `KARnoZ1FxoZTBU8lju6_3`, `WWbM-Xk_oxrSHO4zm6NT6`, or
  `ch_3SfP1dAhXr9x8yiR1VZkvcxL` to a DIFFERENT gift between file authoring
  and apply, both the stamp UPDATE and the PA insert no-op (no double-book).
  Optionally spot-check those 4 rows are still unmatched right before apply:
  `SELECT id, status, matched_gift_id FROM staged_payments WHERE id IN
  ('p87NEtMPYvuC7LZ3lclXc','KARnoZ1FxoZTBU8lju6_3','WWbM-Xk_oxrSHO4zm6NT6');`
  and `SELECT id, status, matched_gift_id FROM stripe_staged_charges WHERE
  id='ch_3SfP1dAhXr9x8yiR1VZkvcxL';` — if any already point at the intended
  gift, that portion is simply a no-op re-apply.

## Verification queries

```sql
-- section rollups (expected prod counts)
SELECT count(*) FROM gifts_and_payments WHERE type = 'reimbursement';            -- >= 68
SELECT count(*) FROM gifts_and_payments WHERE fundraising_campaign IS NOT NULL;  -- >= 146
SELECT count(*) FROM gifts_and_payments
  WHERE archived_at IS NOT NULL
    AND id IN ('recuk5liHKVem9aOh');                                             -- 1 (+ Omidyar losers)
-- Walton split sums exactly (each must return 284375.00)
SELECT gift_id, sum(sub_amount) FROM gift_allocations
  WHERE gift_id IN ('recPgCDRqPMXPLRoY','recGK4rLK85kyhUCK') GROUP BY gift_id;
-- Omidyar survivors at 1M with a single absorbed counted PA each
SELECT g.id, g.amount, pa.amount FROM gifts_and_payments g
  JOIN payment_applications pa ON pa.gift_id = g.id AND pa.link_role = 'counted'
  WHERE g.id IN (SELECT id FROM gifts_and_payments WHERE amount = 1000000.00 AND payer ILIKE '%omidyar%');
-- settlement links from this import
SELECT lifecycle, count(*) FROM settlement_links
  WHERE note LIKE 'import edited-tables 2026-07%' GROUP BY lifecycle;            -- confirmed 77(+1 replace upd), proposed 1
-- staged entity attribution fill
SELECT count(*) FROM staged_payments WHERE entity_id IS NOT NULL;                -- +1111 vs pre-import
-- expected mismatch flag after backfills
SELECT id, quickbooks_tie_status FROM gifts_and_payments WHERE id='rec2rmfIruZyp45QG';  -- amount_mismatch (expected)
-- off-books gifts derive exempt after backfills
SELECT id, quickbooks_tie_status FROM gifts_and_payments
  WHERE id IN ('recc9rR57VNo1tHBm','recfC2SCEY643qShl','recQE2y1hKmifyDPj','recsy6YfVFoHcDOmQ');  -- all 'exempt'
```

Verify by affected-row counts / post-states, not by clean exit
(id-keyed UPDATEs can COMMIT while matching zero rows).
