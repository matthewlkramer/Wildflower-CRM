# 0072 — `people_entity_roles(person_id, connection)` index

## What this does

Adds a composite index `people_entity_roles_person_id_connection_idx` on
`(person_id, connection)`.

It supports the new individual **soft-credit** rollups: a person's *Lifetime
giving* and *Last gift* now also include an **organization's** gift when the
person is that gift's primary contact, its advisor, OR a **current principal**
of the donor organization (e.g. Arthur Rock → Arthur Rock & Company; Katherine
Bradley → Bradley Holdings). The "current principal" leg runs a correlated
subquery filtering `people_entity_roles` by
`(person_id, connection='principal', current='current')` once per people-list
row, so this index keeps that lookup fast.

The other two soft-credit legs (primary contact, advisor) and the organization
match are already covered by existing `gifts_and_payments` indexes
(`primary_contact_person_id`, `advisor_person_id`, `organization_id`), so only
this principal-role index was missing.

## Schema changes (additive, non-destructive)

1. `CREATE INDEX IF NOT EXISTS people_entity_roles_person_id_connection_idx ON people_entity_roles (person_id, connection)`

No data change, no column change, nothing dropped.

## Apply

The file is idempotent (`CREATE INDEX IF NOT EXISTS`), so re-running is a no-op.

```bash
psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0072_people_principal_connection_index.sql   # dev
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0072_people_principal_connection_index.sql   # prod
```

> Note: on a large `people_entity_roles` table, `CREATE INDEX` briefly locks the
> table for writes. If that is a concern in prod, run the equivalent
> `CREATE INDEX CONCURRENTLY` by hand (it cannot run inside the `-1`
> transaction).
