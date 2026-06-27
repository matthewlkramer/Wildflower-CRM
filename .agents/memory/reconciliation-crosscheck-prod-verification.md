---
name: Reconciliation cross-check prod verification
description: What a read-only verification of the historical-transaction cross-check report against PROD money records found, and the classifier tuning it needs.
---

The Reconciliation Cross-Check (`reconciliationCrosscheck.ts`) classifies the
baked historical-sheet rows (stripe_donorbox, stripe_815, qbo_fy25 lanes) against
the CRM's synced money records. It is meaningless in dev (the dev DB is
stale/partial → nearly everything "missing"); it can only be validated against
PROD. Verify by loading the baked rows + the live `stripe_staged_charges` /
`gifts_and_payments` / `staged_payments` (read-only) and replaying the pure
classifiers — never run the DB-touching orchestrator (it points at dev).

**Prod result (read-only pass):** Stripe rows matched by charge id (strongest
key, rock solid). QBO matched all but one row. The name+amount+date matches
spot-check clean on the large grants.

**Three accuracy gaps (the tuning the report needs before the team trusts the
gap totals):**

1. **45-day window is too tight → false negatives.** The lone "missing" row was
   actually in the CRM — same donor + same amount, but the sheet date vs the CRM
   gift date was ~54 days apart, just outside `DATE_WINDOW_DAYS = 45`. Name +
   amount corroborate; only the window blocked it. The live reconciler uses
   60–90d windows; widen to ~60–90.
2. **"Amount + date only" path (uncorroborated name) is unreliable.** ~16 weak
   QBO matches; most have a blank sheet donor. It grabs the *first* same-amount
   CRM record within the window — often an unrelated donor. It also matched a $0
   sheet row (zero matches any zero) and an abs()'d negative reclassification
   journal entry to its positive staged row. Fixes: guard zero/negative sheet
   amounts out of matching; classify amount-only hits as a distinct
   "weak/uncertain" bucket, not "matched".
3. **No one-to-one consumption.** Several CRM records are each claimed by ≥2
   sheet rows. Verified most are genuine sheet self-duplicates — the same Stripe
   transfer listed twice as identical Deposit lines (same transfer memo). So the
   qbo_fy25 sheet total double-counts and the matched COUNT overstates *distinct*
   reconciled money; dedupe the sheet (or consume each CRM record once) before
   trusting aggregate totals.

**Why:** the report is a diagnostic the fundraising team wants to rely on; these
three patterns make "matched"/"missing" optimistic and the gap totals slightly
off. **How to apply:** when tuning the classifier, start with the date window
(clears the only false negative) and the zero/negative guard (clearly-correct);
the weak-bucket split and one-to-one consumption are larger judgment changes
that need their own tests.
