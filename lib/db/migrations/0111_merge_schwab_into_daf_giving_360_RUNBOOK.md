# Runbook — 0111: merge "Schwab Charitable" into "DAF Giving 360"

One-time cleanup that collapses a duplicate `daf`-type payment intermediary.
Schwab Charitable renamed itself to **DAF Giving 360**, but both names exist as
separate `payment_intermediaries` rows, so the same DAF sponsor appears twice in
pickers and lists. This re-points every reference from the old row onto the new
one and archives the old row.

There is no in-app merge for payment intermediaries (the entity-merge engine
only covers organizations and people), so this ships as a reviewed, idempotent
SQL file applied by a human against production (invariant #7 — the agent cannot
write to prod).

## The exact ids

| role     | name              | id                  |
| -------- | ----------------- | ------------------- |
| Survivor | DAF Giving 360    | `recgLXRqc6jUJxxXm` |
| Loser    | Schwab Charitable | `recoHqSe1gJkIKVVb` |

Both are `type = 'daf'`, neither archived, neither carries a
`quickbooks_customer_id`. The survivor already owns 1 gift; its name is already
correct (no rename of intent, just an idempotent set).

## What it does (data-only, idempotent, non-destructive)

1. **Preflight guard** — aborts if the survivor row is missing (wrong DB / wrong
   id). A missing loser is fine (every re-point simply touches 0 rows).
2. **Dedups the donor↔intermediary join** (`donor_payment_intermediaries`) before
   re-pointing — it has three partial unique indexes on
   `(donor, payment_intermediary_id)`. Empty today, but any loser-owned link whose
   `(donor, survivor)` pair already exists is deleted first so re-pointing can
   never violate a unique index.
3. **Re-points every reference column** loser → survivor:
   - `gifts_and_payments.payment_intermediary_id` *(no FK in prod; holds real data — 1 row)*
   - `staged_payments.matched_payment_intermediary_id` *(no FK in prod; holds the Schwab ref — 1 row)*
   - `staged_payments.intermediary_id`
   - `donor_payment_intermediaries.payment_intermediary_id`
   - `organizations.payment_intermediary_id`
   - `people_entity_roles.payment_intermediary_id`
   - `emails.payment_intermediary_id`
   - `addresses.payment_intermediary_id`
   - `phone_numbers.payment_intermediary_id`
   - `donorbox_donations.matched_payment_intermediary_id`
   - `stripe_staged_charges.matched_payment_intermediary_id`

   The two no-FK columns are handled by the same explicit `UPDATE` as the rest —
   the missing constraint makes no difference to the re-point.
4. **Preserves survivor identity** — sets `name = 'DAF Giving 360'` (idempotent)
   and carries the loser's `quickbooks_customer_id` onto the survivor **only** if
   the survivor's is null and the loser's is not (`COALESCE(survivor, loser)` —
   both null today).
5. **Retires the loser via archive** — `archived_at = COALESCE(archived_at, now())`
   so it drops out of lists/pickers while staying recoverable (invariant #6,
   archive-don't-delete; matches the user's non-destructive preference). `COALESCE`
   stops a re-run from resetting the timestamp.
6. **Verification report** — recounts every reference to the loser (must be 0) and
   raises an exception if any remain, rolling the whole `-1` transaction back.

## Derived state — nothing to re-derive

Re-pointing `gifts_and_payments.payment_intermediary_id` changes neither the gift
amount nor its QuickBooks links (matched / created / group_reconciled staged rows,
`payment_applications`, LinkedTxn provenance), so each moved gift's
derived-but-persisted `quickbooks_tie_status` is **unaffected**. No re-derivation
is required.

## Apply

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0111_merge_schwab_into_daf_giving_360.sql
```

No enum / schema prerequisite — it only re-points and archives existing data, so
it does not depend on a prior Publish. `-1` wraps the file in one transaction;
the file contains **no** internal `BEGIN`/`COMMIT`.

## Before / after verification

Run these read-only queries against `$PROD_DATABASE_URL`.

**Before** — confirm the two rows and the loser's live footprint (expect 2:
1 gift + 1 matched staged payment):

```sql
SELECT id, name, type, archived_at, quickbooks_customer_id
  FROM payment_intermediaries
 WHERE id IN ('recgLXRqc6jUJxxXm', 'recoHqSe1gJkIKVVb');

SELECT 'gifts'         AS ref, count(*) FROM gifts_and_payments      WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb'
UNION ALL SELECT 'staged_matched',  count(*) FROM staged_payments         WHERE matched_payment_intermediary_id = 'recoHqSe1gJkIKVVb'
UNION ALL SELECT 'staged_interm',   count(*) FROM staged_payments         WHERE intermediary_id = 'recoHqSe1gJkIKVVb'
UNION ALL SELECT 'donor_links',     count(*) FROM donor_payment_intermediaries WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb'
UNION ALL SELECT 'organizations',   count(*) FROM organizations           WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb'
UNION ALL SELECT 'entity_roles',    count(*) FROM people_entity_roles     WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb'
UNION ALL SELECT 'emails',          count(*) FROM emails                  WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb'
UNION ALL SELECT 'addresses',       count(*) FROM addresses               WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb'
UNION ALL SELECT 'phone_numbers',   count(*) FROM phone_numbers           WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb'
UNION ALL SELECT 'donorbox',        count(*) FROM donorbox_donations      WHERE matched_payment_intermediary_id = 'recoHqSe1gJkIKVVb'
UNION ALL SELECT 'stripe_charges',  count(*) FROM stripe_staged_charges   WHERE matched_payment_intermediary_id = 'recoHqSe1gJkIKVVb';
```

**After** — every count above must be 0, the survivor must own the moved rows,
and the loser must be archived:

```sql
-- All zero:
SELECT count(*) FROM gifts_and_payments WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb';
SELECT count(*) FROM staged_payments    WHERE matched_payment_intermediary_id = 'recoHqSe1gJkIKVVb';

-- Survivor now owns the moved gift (>= 2) + the moved staged payment (>= 1):
SELECT count(*) FROM gifts_and_payments WHERE payment_intermediary_id = 'recgLXRqc6jUJxxXm';
SELECT count(*) FROM staged_payments    WHERE matched_payment_intermediary_id = 'recgLXRqc6jUJxxXm';

-- Loser archived, survivor active with the right name:
SELECT id, name, archived_at FROM payment_intermediaries
 WHERE id IN ('recgLXRqc6jUJxxXm', 'recoHqSe1gJkIKVVb');
```

The `RAISE NOTICE` at the end of the migration prints the same summary
(`remaining refs to loser = 0`, survivor counts, and the loser's `archived_at`),
and the trailing exception guard rolls the transaction back if any reference to
the loser survives.

## Idempotency

Re-running is a stable no-op: after the first run nothing references the loser, so
every re-point `UPDATE` touches 0 rows; the dedup `DELETE` and the archive
`COALESCE` are guarded; and the loser's `archived_at` is preserved (not reset).

## Alternative: hard delete instead of archive

The default is archive (recoverable, app-wide convention). If the reviewer would
rather the duplicate cease to exist entirely, a hard delete is safe **after** this
file has run and the verification shows 0 remaining references — all of the
loser's `ON DELETE CASCADE` child columns are empty, and the re-point clears the
`RESTRICT`-backed `gifts_and_payments` reference first:

```sql
DELETE FROM payment_intermediaries WHERE id = 'recoHqSe1gJkIKVVb';
```

Archive is preferred; only hard-delete on an explicit reviewer decision.

## Rollback

Un-archive the loser:

```sql
UPDATE payment_intermediaries SET archived_at = NULL, updated_at = now()
 WHERE id = 'recoHqSe1gJkIKVVb';
```

The re-point itself is not automatically reversible in bulk (the original
loser↔row associations are not recorded once moved). Today only 2 rows move (the
1 gift + 1 matched staged payment); if a full reversal is ever needed, re-point
those specific rows back to `recoHqSe1gJkIKVVb` by hand.
