# Runbook: 0015 + 0016 — additional QuickBooks auto-exclude reasons

Extends the QuickBooks review-queue noise classifier with four
more "this is not a gift" categories the fundraiser flagged. The classifier
(`artifacts/api-server/src/lib/quickbooksExclusionRules.ts`) already filters
**new** pulls automatically once the code ships; these two SQL files reclassify
the **existing** queue.

## What the new rules catch

| Reason                     | Marker (confirmed in production)                                              |
| -------------------------- | ---------------------------------------------------------------------------- |
| `government_reimbursement` | Exact payer name **`CSP`** (a government program that reimburses the org).    |
| `loan` (guaranty)          | Guaranty-revenue income account **`4102…`** or a **`%guaranty%`** line item.  |
| `interest`                 | **`4010…`** "Interest Earned" income account or an **`INTEREST`** line item.  |
| `tax_refund`               | Refund posted back to **`7010.4…`** (payroll taxes), **`7020…`** (taxes), or **`7006…`** (insurance). |

Notes:

- **Unemployment tax** and **workers-comp refund** have NO QuickBooks item/account
  of their own — they post back to the expense accounts above, so they are grouped
  under one `tax_refund` reason. (The enum value is hard to remove later; if these
  ever need to be split out, that's a new migration.)
- **Guaranty fees** are loan activity, so they reuse the existing `loan` reason
  rather than a new value.
- **CSP** is matched by exact payer identity, so it is excluded even when the
  payment also carries a donation-coded line.

## Donation-first guard

The three **line-based** rules (guaranty, interest, tax_refund) are suppressed on
any row that ALSO carries a real **donation line** — a `4000`/`4100`-series
donation income account or a `Donation` item. A deposit that bundles a gift with
a fee/interest/refund line is therefore left in `pending`, never wrongly hidden.
The CSP rule (payer identity) is NOT guarded.

## Order of application

1. **`0015_quickbooks_exclusion_reasons_enum.sql`** — adds the new enum values.
   **Run WITHOUT `-1`** (Postgres forbids using a freshly added enum value in the
   same transaction that added it):

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0015_quickbooks_exclusion_reasons_enum.sql
   ```

2. **Deploy the new app code** (Publish) and ensure the existing rows already
   carry line detail (`line_item_names` / `line_account_names`) — Parts E/F/G
   match nothing while those columns are NULL.

   ⚠️ The QuickBooks sync is **watermark-based / incremental**: a plain "Sync now"
   only re-fetches entities updated since the watermark, so it does **not**
   backfill line detail onto the historical back-catalog. To enrich old rows you
   must force a **full historical re-pull** by resetting the watermark
   (`0014_quickbooks_reset_watermark.sql`) and then running a sync. If the
   membership rollout (0012–0014) already did this re-pull and no rows have since
   fallen behind, line detail is already present — verify before assuming:

   ```sql
   SELECT count(*) FILTER (WHERE line_item_names IS NOT NULL) AS enriched,
          count(*) AS total
     FROM staged_payments WHERE status = 'pending';
   ```

   If `enriched` is well below `total`, run the 0014 watermark reset + a "Sync
   now" first, then proceed.

3. **`0016_quickbooks_more_exclusions_backfill.sql`** — reclassifies the existing
   queue. **Run WITH `-1`** (single transaction):

   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0016_quickbooks_more_exclusions_backfill.sql
   ```

Both files are idempotent: 0015 uses `ADD VALUE IF NOT EXISTS`; 0016 only ever
touches `status = 'pending'` rows, so a second run is a no-op and prior
fundraiser decisions / re-includes are preserved.

## Discovery queries (read-only, run against production)

Estimate how many pending rows each rule will clear (donation-guarded), before
applying 0016:

```sql
-- CSP
SELECT count(*) FROM staged_payments
 WHERE status = 'pending' AND lower(btrim(payer_name)) = 'csp';

-- interest / guaranty / tax_refund (donation-guarded)
SELECT
  count(*) FILTER (WHERE has_guaranty)                         AS guaranty,
  count(*) FILTER (WHERE has_interest AND NOT has_guaranty)    AS interest,
  count(*) FILTER (WHERE has_tax AND NOT has_guaranty AND NOT has_interest) AS tax_refund
FROM (
  SELECT
    EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names,'{}'::text[])) a WHERE lower(btrim(a)) LIKE '4102%')
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names,'{}'::text[])) li WHERE lower(btrim(li)) LIKE '%guaranty%') AS has_guaranty,
    EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names,'{}'::text[])) a WHERE lower(btrim(a)) LIKE '4010%')
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names,'{}'::text[])) li WHERE lower(btrim(li)) LIKE '%interest%') AS has_interest,
    EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names,'{}'::text[])) a
             WHERE lower(btrim(a)) LIKE '7010.4%' OR lower(btrim(a)) LIKE '7020%' OR lower(btrim(a)) LIKE '7006%') AS has_tax
  FROM staged_payments
  WHERE status = 'pending'
    AND lower(btrim(coalesce(payer_name,''))) <> 'csp'
    AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names,'{}'::text[])) a WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
    AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names,'{}'::text[])) li WHERE lower(btrim(li)) LIKE '%donation%')
) s;
```

(At discovery time the snapshot was: CSP 58, interest 65, tax_refund 51,
guaranty 10 — clearing ~184 pending rows.)

## Verification (after 0016)

```sql
SELECT status, exclusion_reason, count(*)
FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;
```
