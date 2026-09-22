# Migration 0261 — Enrichment queue and organization EIN

This additive, idempotent migration adds confidence metadata to enrichment
suggestions and a nullable, normalized EIN to organizations. It does not seed
suggestions or write canonical organization data.

Run after deploying the matching schema and API:

```sh
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0261_enrichment_queue_ein.sql
```

The EIN constraint accepts only `NN-NNNNNNN`; the partial unique index permits
multiple organizations without an EIN while preventing duplicate normalized
values. Re-running the migration is safe.