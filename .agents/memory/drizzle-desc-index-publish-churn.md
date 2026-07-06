---
name: drizzle .desc() index causes perpetual Publish churn
description: Why a .desc()/.asc()/NULLS index ordering makes every Publish re-issue the same DROP+CREATE, and the two-part fix.
---

# drizzle-kit `.desc()` on an index → perpetual Publish/push churn

Do NOT use `.desc()`, `.asc()`, or NULLS modifiers in a Drizzle index column list
in this repo. Define indexes with plain columns only.

**Symptom:** every Publish (or `db push`) regenerates the identical migration —
`DROP INDEX x; CREATE INDEX x ... USING btree (col)` — for the same index, forever.
Note the emitted CREATE has NO `DESC`.

**Why:** drizzle-kit 0.31.x records the DESC ordering in its snapshot and *introspects*
it back from a live DB, but its CREATE INDEX *generator omits the DESC keyword*. So the
target ("desc") is never reachable by the DDL it emits. Combined with Replit Publish
diffing the **dev DATABASE vs the prod DATABASE** (never the schema source — see
publish-diffs-dev-database.md), the two DBs drift apart on ordering and never converge:
dev ends up DESC (from an old push that created it desc), prod ends up ASC (from the
churning publish CREATEs).

**No perf cost to plain ascending:** Postgres scans a btree backward for
`ORDER BY col DESC` at identical cost; a leading equality filter + backward scan on the
composite is just as efficient. DESC index ordering only matters for mixed-direction
composite sorts (not present here).

## How to apply (fixing an existing churn)

Both steps are required — one alone just relocates the churn:

1. **Code:** remove `.desc()` from the index definition(s) → plain columns. (Prevents a
   future `db push` from re-introducing desc into dev: code↔dev would otherwise churn.)
2. **Dev DB:** recreate the affected indexes as plain ascending (DROP + CREATE without
   DESC, in a txn) so dev matches prod exactly. (Publish reads the dev DB, not the code,
   so the code change alone leaves dev DESC and Publish keeps proposing the migration.)

Then verify code == dev == prod via `pg_indexes.indexdef` (prod read-only via the
database skill). Prod is typically already ascending (the churn CREATEs made it so), so
**no prod change is needed**; the next Publish shows zero diff for that table.
