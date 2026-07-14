# 0125 — Retroactive settlement supersede: demote double-counted QB rows

## What this fixes

The prod audit (2026-07-14) found that before `applySettlementSupersedeMany`
existed, confirming a deposit↔payout settlement link did **not** demote the
deposit's coarse counted QuickBooks ledger row when the same money was also
booked as per-charge counted Stripe rows. Source-agnostic SUM readers
(`settledGrossForGift`, gift payment summaries, analytics) therefore counted
the same dollars twice.

| Finding | Count | Amount | Action |
|---|---|---|---|
| Counted QB rows covered by the confirmed-settled payout's per-charge Stripe rows | 57 rows / 57 gifts | $20,822.13 | **Demoted** to `corroborating` (step 2) |
| D1: deposit `RS4FYIjvOXsVBv1dX_UEL` matched-pointer with ZERO ledger rows | 1 deposit | $479.20 | Ledger row **inserted directly in demoted shape** (step 3) |
| Stale `conflict_gift_id` crumbs whose kept gift is per-charge booked from that payout | 38 of 42 | — | **Cleared** (step 4); the other 4 record genuine keep-the-QB-gift resolutions and stay |
| Gifts whose derived `quickbooks_tie_status` changes post-demote | 4 | — | **Re-derived** (step 5) |
| Pure duplicates on deposits with **no confirmed settlement link** | 9 gifts | $808.85 | **NOT touched — human review, see below** |
| Pointer-less deposits (no `matched_gift_id`, no ledger rows) | 113 | — | Documented only — legacy, nothing to repair |
| Legacy Stripe charges matched without pointer-era gift links | 115 | — | Documented only — legacy, nothing to repair |

The demote predicate is byte-for-byte the app's own rule
(`settlementSupersede.ts` → `decideSupersedeActions` +
`amountWithinFeeBand` QB-only band: equal to the cent, or the Stripe sum in
`[QB amount − 0.01, QB amount × 1.1 + 1]`), so the app's next supersede pass
agrees with every row this file touches, and the demotions stay reversible by
the app if a settlement link is ever reverted.

## Apply

```
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0125_demote_double_counted_qb_rows_settlement_supersede.sql
```

Apply **after** 0124 (`lib/db/migrations/0124_swap_rue_kirby_crossed_charge_gift_links.sql`).
The two files are independent (0125's generic predicates don't touch the
Rue/Kirby rows — their deposits have no confirmed settlement link with covering
charge rows in the demote sense), but applying in numbered order keeps the
verification counts below exact.

## Expected statement tags (first run)

| Step | Statement | Expected |
|---|---|---|
| 1 | DELETE colliding corroborating rows | `DELETE 0` |
| 2 | Demote covered counted QB rows | `UPDATE 57` |
| 3 | D1 insert (deposit `RS4FY…`) | `INSERT 0 1` |
| 4 | Clear stale conflict crumbs | `UPDATE 38` |
| 5 | Re-derive `quickbooks_tie_status` | `UPDATE 4` |

Re-run: all zeros (every statement is guarded on current facts).

The counts assume no app-driven supersede runs between the audit
(2026-07-14) and apply. If the team confirms more settlement links in the
workbench first, the app demotes those rows itself and the tags come in
slightly lower — that drift is benign, not a failure. The real acceptance
test is the first verification query returning **0 rows**.

Step 5's four changes are all `tied → amount_mismatch` — the honest derived
value once the per-charge Stripe gross (incl. processor fee) is the evidence
against the human-entered amount (same shape 0124 established on the
Rue/Kirby twins):

| Gift | Name | Entered | Stored → derived |
|---|---|---|---|
| `rec3Q6VER8qmuuhHd` | $156 FY25 Webster to BWF | 156.00 | tied → amount_mismatch |
| `rec3lwPNOcPgVjoPI` | $104 FY25 Moses to BWF | 104.00 | tied → amount_mismatch |
| `recSMxOoHOywjg8RN` | $52 FY25 Robinson to BWF | 52.00 | tied → amount_mismatch |
| `recpcSW7zig28I2dG` | Allison Welch website donation | 26.00 | tied → amount_mismatch |

## Verification

Run the queries in the footer of the `.sql` file. Headlines:

- The "still double-counted behind a confirmed link" probe returns **0 rows**.
- `payment_applications` corroborating-with-amount rows: **58 / $21,301.33**
  (57 demoted + the D1 row).
- `settlement_links.conflict_gift_id IS NOT NULL`: **4**.

## Human review list — 9 pure duplicates NOT auto-fixed ($808.85)

These gifts carry both a counted QB deposit row and an equal counted Stripe
charge row, but their deposits have **no confirmed settlement link** — the
coverage fact the supersede rule (correctly) requires. **Action: open each
deposit in the Finance Reconciliation workbench and confirm the
deposit↔payout settlement link; the app's supersede then demotes the QB row
automatically.** No SQL needed.

| Gift | Name | Amount | Deposit | Deposit payer | Deposit date |
|---|---|---|---|---|---|
| `reco6oHWEdopxrzpy` | Mark and Jill Blank | 103.83 | `sEkmH4qxJDh3TDHVP-Fgq` | Jill Blank | 2021-12-16 |
| `recUpddcn0wsTIDTN` | Bussie 52.51 | 52.51 | `HwtrWVGpC2PRzJ0DkGCx5` | Clifford Bussie | 2026-02-26 |
| `recL1oVIyCAHUMNzU` | Rash 50.00 | 50.00 | `sLapSuBDTP2aR6L1nHbQ4` | Kathleen Rash | 2026-03-02 |
| `recDwxcONOidtf303` | Day 50.00 | 50.00 | `Ddjox4jzXiyyrrHmuckJ8` | NaTasha Day (Donor) | 2026-03-06 |
| `recKXTsYX0Ksr8C3K` | Tucker 52.51 | 52.51 | `3qcfYIMvoBefjN7Aq_pv1` | Danielle Tucker | 2026-03-11 |
| `recSZaUqRHXKbPtSJ` | Brown 150.00 | 150.00 | `ZQfH7I8fi5SZoRcztcPjj` | Alexander Brown | 2026-03-11 |
| `ivGb5OT41MLN8qUdATa9n` | LaTania Scott (Donor) | 50.00 | `U09y52BfvXILhL86yurkk` | LaTania Scott (Donor) | 2026-03-25 |
| `CQCTOUS6l-g85uTYdidxx` | Alexander Brown | 150.00 | `VhvzyX2-TaSY6y2aq96Ho` | Alexander Brown | 2026-04-10 |
| `mbSHFb156cyePkgdEJchx` | Alexander Brown | 150.00 | `mQODWNWnXQnA7n97PlzGe` | Alexander Brown | 2026-06-10 |

If a deposit turns out NOT to be the settled lump for a Stripe payout (a
genuinely separate second payment), the correct fix is instead to unlink the
wrong side in the workbench — do not force a settlement link just to trigger
the demote.

## Documented-only findings (no action)

- **113 pointer-less deposits**: `staged_payments` rows with no
  `matched_gift_id` and no ledger rows — ordinary unreconciled queue items.
- **115 legacy matched-no-pointer charges**: `stripe_staged_charges` marked
  `matched` from the pointer era without per-charge ledger rows; their money
  reached gifts through the QB deposit path, which remains the (single)
  counted trail for them. Creating per-charge rows for these would require
  the settlement links to exist first — same workbench flow as the review
  list, but with no double-counting today there is no urgency.
