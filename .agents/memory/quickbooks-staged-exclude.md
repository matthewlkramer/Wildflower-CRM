---
name: QuickBooks staged-payment auto-exclude
description: Why noise payments still show in the Review queue and what actually clears them
---

# QuickBooks staged-payment auto-exclude

The auto-exclude classifier (`quickbooksExclusionRules.ts`) only runs **on insert**
when a row is freshly staged. It does **not** retroactively reclassify rows that
were already `pending`.

## Manual exclude / reclassify from the card

A human can now exclude/reclassify from the staged-payment card via
`POST /staged-payments/:id/exclude` (`{ exclusionReason }`): allowed only from
`pending` (exclude) or `excluded` (reclassify the category) — `approved`/`rejected`
are non-excludable (409). Guarded conditional UPDATE (`WHERE id AND status IN
('pending','excluded')`, 409 on zero rows). **Donor match is left intact** so
re-include (which clears only `exclusionReason`) restores prior donor work. The
insert-time classifier's conflict-update path refreshes only line detail/updatedAt
for pending/excluded rows and never overwrites status/reason, so a manual
exclude/reclassify (and manual re-include) survives later syncs untouched.

**Frontend gotcha:** the card's `excludeReason` Select is seeded from
`row.exclusionReason` and must be resynced via `useEffect` on
`[row.id, row.exclusionReason]`, or it drifts from server truth on a persisted card
instance (re-sync / another admin / its own reclassify landing).

**Existing rows are cleared only by the backfill migration `0013`** (Part A
zero/null amount, Part B loan payer-name patterns, Part C membership). `0013` is a
manual data migration — Publish ships the *schema* (`0012`) but never runs the
data backfill, so after a deploy the historical queue stays 100% `pending` until a
human runs `0013` on prod. Symptom: user says "all the payment records are still
there without filtering."

**Why:** classifier is insert-time; backfill is the catch-up mechanism by design.

**How to apply:** if the Review queue is unfiltered in prod, check
`SELECT status, exclusion_reason, count(*) FROM staged_payments GROUP BY 1,2` — if
everything is `pending`/`excluded=0`, `0013` Parts A+B haven't been run. They are
safe immediately (run off fields present on every row), idempotent, and only touch
still-`pending` rows.

## Watermark gotcha for membership (Part C)

The sync is **watermark-based** (`quickbooksSync.ts` pulls entities updated *since*
`syncWatermark`). It does NOT re-pull historical rows, so the scheduled sync will
**not** enrich old rows' `line_item_names`/`line_account_names` — those stay NULL
forever for the back-catalog. Membership detection (Part C) and the runbook's
discovery query both depend on that line detail.

**Consequence:** to ever auto-exclude historical membership dues you must force a
**full re-pull** (reset the connection's `syncWatermark`), not just wait for the
scheduler. The runbook's step 4 ("run a sync to enrich line detail") is incomplete
for the existing back-catalog because of this watermark scoping.

## Confirmed membership marker

The membership marker is the QuickBooks Product/Service **line item**
`"School Contributions"` (member Montessori schools pay network dues under it).
There is **no** income/posting-account marker — membership is item-only.

**Why:** confirmed against prod after the full re-pull enriched line detail;
user verified "school contributions = membership fees."

**How to apply:** keep the SQL backfill (Part C) and the classifier's
`MEMBERSHIP_ITEM_NAMES` in lockstep, and keep both **case-insensitive + trimmed**
(`lower(btrim(...))` in SQL == `normalize()` in code) or the backfill silently
misses casing/spacing variants the live rule would catch. Run the runbook's
parity pre-check (normalized_hits == exact_hits) before any prod Part C run.
