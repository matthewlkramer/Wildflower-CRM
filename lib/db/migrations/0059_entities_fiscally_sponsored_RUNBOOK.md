# 0059 — Mark named fund entities as fiscally sponsored

## What this does

Adds a visible **fiscally-sponsored** flag to fund entities (schema column
`entities.fiscally_sponsored`, default `false`) and marks the three fiscally
sponsored entities as such in production:

- **Embracing Equity** (slug `n_equity`)
- **Rising Tide** (slug `rising_tide`)
- **Tierra Indigena** (slug `n_indigena`)

The flag is **informational only** — it is shown and toggleable in the admin
entities table but does not drive coding rules, analytics, or reconciliation
behavior. (It is unrelated to the QuickBooks `fiscally_sponsored` staged-payment
exclusion reason, which is a separate concept and untouched.)

## Order of operations

1. **Publish** the schema/code first. The new `fiscally_sponsored` column ships
   via the normal Publish schema diff (default `false` for all existing rows),
   and the admin UI toggle ships with it.
2. **Apply the data file** once Publish is live:

   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0059_entities_fiscally_sponsored.sql
   ```

## Verify

Before applying, confirm the three slugs exist in the target environment:

```sql
SELECT id, name, fiscally_sponsored FROM entities
WHERE id IN ('n_equity', 'rising_tide', 'n_indigena')
ORDER BY id;
```

If any slug differs in prod, edit the id list in the `.sql` file before running.

After applying, all three rows should show `fiscally_sponsored = true`.

## Safety

- Idempotent: re-running is a no-op (the `UPDATE` only touches rows not already
  `true`, and only for the three named slugs).
- Non-destructive: only ever sets the flag to `true` for these three entities;
  never clears it and never touches any other entity.
