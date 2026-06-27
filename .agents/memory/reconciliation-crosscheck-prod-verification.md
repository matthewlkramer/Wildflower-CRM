---
name: Reconciliation cross-check prod verification
description: What a read-only verification of the historical-transaction cross-check report against PROD money records found, and the classifier tuning it needs.
---

The Reconciliation Cross-Check (`reconciliationCrosscheck.ts`) classifies the 140
baked historical-sheet rows (stripe_donorbox 34, stripe_815 5, qbo_fy25 101)
against the CRM's synced money records. It is meaningless in dev (the dev DB is
stale/partial → nearly everything "missing"); it can only be validated against
PROD. Verify by loading the baked rows + the live `stripe_staged_charges` /
`gifts_and_payments` / `staged_payments` (read-only) and replaying the pure
classifiers — never run the DB-touching orchestrator (it points at dev).

**Prod result (read-only pass):** Stripe 39/39 matched by charge id (strongest
key, rock solid). QBO 100 matched / 1 missing of 101. The 84 QBO
name+amount+date matches spot-check clean (Arthur Rock $1.5M, Stand Together
$500k, Imaginable Futures $300k, etc.).

**Three accuracy gaps (the tuning the report needs before the team trusts the
gap totals):**

1. **45-day window is too tight → false negatives.** The lone "missing" row
   (Chia Rodeski $7,000) is actually in the CRM — gift "Vladimir and Chia
   Rodeski" $7,000 at 2025-01-09 vs the sheet's 2024-11-16 = 54 days, just
   outside `DATE_WINDOW_DAYS = 45`. Name+amount corroborate; only the window
   blocked it. The live reconciler uses 60–90d windows; widen to ~60–90.
2. **"Amount + date only" path (uncorroborated name) is unreliable.** 16 weak
   QBO matches (~$1.18M abs); 14/16 have a blank sheet donor. It grabs the
   *first* same-amount CRM record within the window — often an unrelated donor.
   It also matched a $0 sheet row (zero matches any zero) and an abs()'d
   −$500k reclassification journal entry to the +$500k staged row. Fixes:
   guard zero/negative sheet amounts out of matching; classify amount-only
   hits as a distinct "weak/uncertain" bucket, not "matched".
3. **No one-to-one consumption.** 27 CRM records are each claimed by ≥2 sheet
   rows (one $5,000 gift claimed by 5 rows). Verified most are genuine sheet
   self-duplicates — the same Stripe transfer listed twice as identical Deposit
   lines (e.g. #57/#108, same memo `ST-…`). So the qbo_fy25 sheet total
   ($3.35M) double-counts and the matched COUNT overstates *distinct*
   reconciled money; dedupe the sheet (or consume each CRM record once) before
   trusting aggregate totals.

**Why:** the report is a diagnostic the fundraising team wants to rely on; these
three patterns make "matched"/"missing" optimistic and the gap totals slightly
off. **How to apply:** when tuning the classifier, start with the date window
(clears the only false negative) and the zero/negative guard (clearly-correct);
the weak-bucket split and one-to-one consumption are larger judgment changes
that need their own tests.
