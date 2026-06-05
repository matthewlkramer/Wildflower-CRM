---
name: QuickBooks staged-payment auto-exclude
description: Why noise payments still show in the Review queue and what actually clears them
---

# QuickBooks staged-payment auto-exclude

The auto-exclude classifier (`quickbooksExclusionRules.ts`) only runs **on insert**
when a row is freshly staged. It does **not** retroactively reclassify rows that
were already `pending`.

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
