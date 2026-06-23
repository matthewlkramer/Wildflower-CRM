# Runbook — 0069 Correct two Annie Kuthart gifts to Tierra Indígena

## What this does

Sets `gift_allocations.entity_id = 'tierra_indigena'` on the two Annie Kuthart
recurring $52.07 online-donation allocations that currently have a **blank**
receiving entity, bumping `updated_at`. No schema change.

| Gift | Allocation | Amount | Date |
| --- | --- | --- | --- |
| `recGp8sWhhfkr1Tj1` | `synth-ga-recGp8sWhhfkr1Tj1` | $52.07 | 2022-09-20 |
| `recBZ2bNQVuaXSa1t` | `synth-ga-recBZ2bNQVuaXSa1t` | $52.07 | 2023-03-20 |

## Evidence

These are the Sept-2022 and Mar-2023 entries in Annie's **monthly Tierra Indígena
Montessori recurring series**. Two independent signals confirm the attribution:

1. **Stripe charge memo** — each gift's matching Stripe charge reads "recurring
   donation to Tierra Indígena Montessori" (same donor / date / amount).
2. **Sibling-row parity** — every other month in the series is already coded
   `tierra_indigena`. The two blank rows are **identical column-for-column** to
   those correct siblings except for `entity_id`: same `sub_amount` (52.07), same
   `grant_year` (`fy2023`), `restriction_type = unclear`, and every derived
   revenue-coding column (`object_code`, `revenue_location`, `revenue_class`,
   `coding_flags`, all `*_override`s) NULL on both. Parent gifts'
   `quickbooks_tie_status` is `missing` on every row in the series (none off-books
   / designated-to-school).

## Why a single-column update is sufficient (no re-derivation)

Because the blank rows already match their TI siblings on every other column,
setting `entity_id = 'tierra_indigena'` makes them identical to the siblings. No
revenue-coding or QB-tie recomputation is required, and none of the derived
columns would diverge from how the app codes the existing TI siblings. These gifts
stay `final_amount_source = 'human'` (not formally linked to their Stripe charges).

## Ordering

Independent — needs no prior migration (the `entity_id` column and the
`tierra_indigena` entity row already exist, so there is **no Publish step**).

## Apply

```bash
# dev
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0069_annie_kuthart_tierra_indigena.sql
```

```bash
# prod
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0069_annie_kuthart_tierra_indigena.sql
```

`psql -1` wraps the whole file in one transaction; the file has no top-level
`BEGIN/COMMIT`.

## Idempotency

Safe to re-run. The `UPDATE` is guarded on `entity_id IS NULL` (and the expected
`gift_id`), so once applied a re-run reports 0 rows affected and no other gift's
entity is ever touched.

## Verify

Confirm by **state**, not by a clean exit (an id-matched UPDATE can commit yet
have matched nothing — check the values below):

```sql
SELECT id, gift_id, entity_id
  FROM gift_allocations
 WHERE id IN ('synth-ga-recGp8sWhhfkr1Tj1', 'synth-ga-recBZ2bNQVuaXSa1t');
-- Expect: both entity_id = tierra_indigena.
```
