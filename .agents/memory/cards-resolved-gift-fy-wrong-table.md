---
name: cards resolved-gift fiscal-year wrong-table 500
description: grant_year is allocation-level, not gift-level; how a raw-sql subquery read the wrong table and took down the whole /reconciliation/cards endpoint, plus the fastest way to diagnose raw-sql column errors.
---

# Resolved-gift fiscal year is allocation-level

`grant_year` lives ONLY on `gift_allocations`. `gifts_and_payments` has NO
`grant_year` column. So any "resolved gift fiscal year" value must be read from
`gift_allocations` (guarded `grant_year IS NOT NULL`, deterministic
`ORDER BY created_at, id`, `LIMIT 1`), never `SELECT g.grant_year FROM
gifts_and_payments g`.

**Why:** a chargeSub LATERAL subquery in
`artifacts/api-server/src/routes/reconciliation/cards.ts` (the per-Stripe-charge
resolved-gift columns) hand-duplicates the shared quickbooks projection's
resolved-gift scalar subqueries. It drifted: its fiscal-year subquery read
`g.grant_year FROM gifts_and_payments g`, which Postgres rejects at PLAN time
("column g.grant_year does not exist"). Because that scalar subquery sits in the
LATERAL's SELECT list, it is planned on EVERY `/api/reconciliation/cards`
request — even with zero Stripe charges — so the whole endpoint 500'd. Raw
`sql\`\`` templates are invisible to `tsc`, so typecheck and unit tests passed;
it failed the same on dev and prod (it was never data-specific).

**How to apply:** the charge-context resolved-gift subqueries must mirror the
shared projection but with the charge's link columns
(`COALESCE(matched_gift_id, created_gift_id)` — charges have NO
group_reconciled pointer). If you touch either the shared resolved-gift
subqueries or the chargeSub copies, change BOTH in lockstep. Gift-resident
columns (name, amount, date_received, org/household/person id, archived_at)
stay `FROM gifts_and_payments`; allocation-resident facts (grant_year, usage,
restriction axes, entity) come `FROM gift_allocations`.

# Diagnosing raw-sql column/structure errors fast

`drizzle .toSQL()` returns the exact emitted SQL + params WITHOUT touching the
DB. To catch wrong-table/wrong-column and other structural faults in a big
generated query:

1. Build the query object (or dump it from the handler behind a temporary
   env-gated `.toSQL()` write), inline the `$N` params.
2. Run `EXPLAIN <sql>` against the DB. EXPLAIN plans the whole query (all
   scalar subqueries and LATERALs) but executes nothing — so it surfaces
   "column/function/operator does not exist" and type errors immediately, and
   it does NOT OOM or get signal-killed on heavy queries (executing the full
   table scan via the SQL sandbox does get killed).
3. EXPLAIN misses true runtime/per-row errors (more-than-one-row, cast-on-value)
   — for those, execute with a small LIMIT over rows that match the offending
   shape.

Bisect a large query by EXPLAINing the shared/base projection first, then the
full query; the delta localizes the fault (here: shared EXPLAIN passed, full
EXPLAIN failed → bug was in the cards-local additions).
