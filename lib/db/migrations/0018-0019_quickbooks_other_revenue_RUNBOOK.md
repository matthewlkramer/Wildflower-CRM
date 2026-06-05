# Runbook: 0018 + 0019 — QuickBooks `other_revenue` auto-exclude reason

Extends the QuickBooks review-queue noise classifier with one more "this is not a
gift" category for the **Other Revenue (4030)** income account. The classifier
(`artifacts/api-server/src/lib/quickbooksExclusionRules.ts`) already filters
**new** pulls automatically once the code ships; these two SQL files reclassify
the **existing** queue.

## Why this is narrow

Account **4030 "Other Revenue"** is a grab-bag bucket. It is mostly non-gift
noise, but a real donation is occasionally **miscoded** into it. Per the user's
decision we exclude **only the clear non-gifts** and leave everything else in the
queue to review:

| Caught (excluded `other_revenue`)                          | Left in queue (review)                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| 4030 row whose memo says **credit-card rewards** (`reward`/`rewards`) | Legal settlements, refunds, unidentified deposits |
| 4030 row whose memo says **bank-account activity** (`business checking`) | Miscoded gifts (e.g. a "Sweet Pea" donation parked in 4030) |

The signal lives in the **memo** (`raw_reference`), so the classifier now also
receives the memo. A row must be coded to **4030** AND match one of the two memo
patterns; either alone is not enough.

## Matching rule (mirrors the classifier exactly)

- Account marker: any `line_account_names` entry with code **prefix `4030`**.
- Memo marker (case-insensitive, word-boundary): `\yrewards?\y` (covers
  "rewards" / "reward") OR `\ybusiness checking\y`.
- **Donation-first guard**: suppressed on any row that ALSO carries a real
  donation line — a `4000`/`4100`-series donation income account or a `Donation`
  item — so a deposit bundling a gift with a 4030 line is never wrongly hidden.

## Order of application

1. **`0018_quickbooks_other_revenue_enum.sql`** — adds the new enum value.
   **Run WITHOUT `-1`** (Postgres forbids using a freshly added enum value in the
   same transaction that added it):

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0018_quickbooks_other_revenue_enum.sql
   ```

2. **Deploy the new app code** (Publish) and ensure the existing rows already
   carry line detail (`line_account_names`) and memo (`raw_reference`). New pulls
   are classified automatically; the backfill only reclassifies what is already
   staged.

   ⚠️ The QuickBooks sync is **watermark-based / incremental**: a plain "Sync now"
   only re-fetches entities updated since the watermark, so it does **not**
   backfill line detail onto the historical back-catalog. If old rows are missing
   `line_account_names`, force a full historical re-pull by resetting the
   watermark (`0014_quickbooks_reset_watermark.sql`) and running a sync first.
   Verify before assuming:

   ```sql
   SELECT count(*) FILTER (WHERE line_account_names IS NOT NULL) AS enriched,
          count(*) AS total
     FROM staged_payments WHERE status = 'pending';
   ```

3. **`0019_quickbooks_other_revenue_backfill.sql`** — reclassifies the existing
   queue. **Run WITH `-1`** (single transaction):

   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0019_quickbooks_other_revenue_backfill.sql
   ```

Both files are idempotent: 0018 uses `ADD VALUE IF NOT EXISTS`; 0019 only ever
touches `status = 'pending'` rows, so a second run is a no-op and prior
fundraiser decisions / re-includes are preserved.

## Discovery query (read-only, run against production)

Estimate how many pending rows the rule will clear (donation-guarded) before
applying 0019:

```sql
SELECT count(*) FROM staged_payments
 WHERE status = 'pending'
   AND raw_reference IS NOT NULL
   AND (raw_reference ~* '\yrewards?\y' OR raw_reference ~* '\ybusiness checking\y')
   AND EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names,'{}'::text[])) a
                WHERE lower(btrim(a)) LIKE '4030%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names,'{}'::text[])) a
                    WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names,'{}'::text[])) li
                    WHERE lower(btrim(li)) LIKE '%donation%');
```

To sanity-check what stays behind (the rows deliberately left for review):

```sql
SELECT raw_reference, line_account_names
  FROM staged_payments
 WHERE status = 'pending'
   AND EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names,'{}'::text[])) a
                WHERE lower(btrim(a)) LIKE '4030%')
   AND NOT (raw_reference ~* '\yrewards?\y' OR raw_reference ~* '\ybusiness checking\y')
 ORDER BY raw_reference;
```

## Verification (after 0019)

```sql
SELECT status, exclusion_reason, count(*)
FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;
```
