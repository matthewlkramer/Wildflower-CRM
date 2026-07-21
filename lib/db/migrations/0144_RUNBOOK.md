# 0144 + 0145 — source_links evidence-claim ledger (RUNBOOK)

ADR: `docs/adr-source-link-ledger.md`. Two files, applied in order in
SEPARATE psql invocations (0145 uses the enum value 0144 adds — Postgres
forbids using a new enum value in the transaction that added it).

## 0. Pre-flight (read-only, ADR phase 1)

Report existing double-claims (expected: ZERO rows — the app 409s have
guarded confirmed ties since 0129). If anything comes back, resolve it by
hand BEFORE applying, or the partial unique indexes / backfill will conflict:

```bash
psql "$PROD_DATABASE_URL" <<'SQL'
-- Same QB row confirmed-tied by more than one charge:
SELECT linked_qb_staged_payment_id, count(*) AS claims
FROM stripe_staged_charges
WHERE linked_qb_staged_payment_id IS NOT NULL
GROUP BY 1 HAVING count(*) > 1;
-- Charges holding BOTH a confirmed and a proposed tie (approve should clear):
SELECT id FROM stripe_staged_charges
WHERE linked_qb_staged_payment_id IS NOT NULL
  AND proposed_qb_staged_payment_id IS NOT NULL;
SQL
```

(The second query's rows are not fatal — the backfill keeps the confirmed
tie and drops the proposal — but they indicate drift worth a look.)

## 1. Apply (order matters; run AFTER Publish if Publish already shipped the schema — both are idempotent either way)

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0144_create_source_links.sql
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0145_backfill_source_links.sql
```

## 2. Verify (counts must reconcile — do NOT trust a clean exit)

```bash
psql "$PROD_DATABASE_URL" <<'SQL'
SELECT
  (SELECT count(*) FROM stripe_staged_charges WHERE linked_qb_staged_payment_id IS NOT NULL)   AS ptr_tie_confirmed,
  (SELECT count(*) FROM source_links WHERE link_type='charge_qb_tie' AND lifecycle='confirmed') AS led_tie_confirmed,
  (SELECT count(*) FROM stripe_staged_charges WHERE proposed_qb_staged_payment_id IS NOT NULL AND linked_qb_staged_payment_id IS NULL) AS ptr_tie_proposed,
  (SELECT count(*) FROM source_links WHERE link_type='charge_qb_tie' AND lifecycle='proposed')  AS led_tie_proposed,
  (SELECT count(*) FROM stripe_staged_charges WHERE linked_fee_qb_staged_payment_id IS NOT NULL) AS ptr_fee,
  (SELECT count(*) FROM source_links WHERE link_type='charge_fee_row')                          AS led_fee,
  (SELECT count(*) FROM donorbox_donations WHERE linked_qb_staged_payment_id IS NOT NULL)       AS ptr_db_qb,
  (SELECT count(*) FROM source_links WHERE link_type='donorbox_qb')                             AS led_db_qb,
  (SELECT count(*) FROM donorbox_donations WHERE linked_stripe_charge_id IS NOT NULL)           AS ptr_db_charge,
  (SELECT count(*) FROM source_links WHERE link_type='donorbox_charge')                         AS led_db_charge,
  (SELECT count(*) FROM payment_applications WHERE note LIKE 'charge_tie_supersede:%' AND match_method::text <> 'charge_tie_supersede') AS unmigrated_markers;
SQL
```

Every `ptr_*` must equal its `led_*` twin and `unmigrated_markers` must be 0.

## Rollback

Additive only. `DROP TABLE source_links;` + `DROP TYPE source_link_type,
source_link_lifecycle, source_link_provenance;` fully reverts 0144 (the
match_method enum value is harmless to leave). 0145 reverts by deleting the
`srcl_*` rows and re-setting `match_method='system'` on the marker rows.
