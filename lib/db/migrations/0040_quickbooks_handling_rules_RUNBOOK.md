# 0040 — QuickBooks handling rules (admin-editable) + seed

## What this ships

Moves the QuickBooks "exclude as noise" classifier off the **ingest** code path
into an admin-editable, DB-backed rule list (`quickbooks_handling_rules`) and adds
the first `auto_create_approve` rule (**AmazonSmile** → mint a gift attributed to
the donor org "Amazon / Amazon Foundation", allocate to **GenOps**
(`intended_usage = 'gen_ops'`), match it, and land it in the auto/approved queue).

- **Rule edits affect NEW incoming payments only** — already-queued staged rows
  are never reclassified.
- The hardcoded `classifyStagedPayment` classifier stays in the codebase and still
  drives the manual `reclassifyStagedPayments` maintenance path (unchanged).
- The seed reproduces today's exclusion behavior **exactly** — guaranteed by the
  vitest fidelity test
  `artifacts/api-server/src/__tests__/quickbooks-rules-fidelity.test.ts`
  (`evaluateRules(SEED_RULES)` === `classifyStagedPayment` over fixtures).

## Schema vs. data

- The **enum** `quickbooks_rule_action` and the **table**
  `quickbooks_handling_rules` reach production via the normal **Publish** (drizzle)
  diff. This file (re)creates them idempotently too, so it is self-contained and
  safe to run before *or* after a Publish.
- The **seed rows** are DATA and are delivered only by this file.

## Lockstep

`lib/db/migrations/0040_quickbooks_handling_rules.sql` is the SQL mirror of
`SEED_RULES` in `artifacts/api-server/src/lib/quickbooksRules.ts`. Any change to
the classifier / seed must update **both**, and the fidelity test must stay green.

## Apply (production)

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0040_quickbooks_handling_rules.sql
```

## Idempotency / safety

- Enum + table use `IF NOT EXISTS` / `duplicate_object` guards.
- Seed `INSERT`s use `ON CONFLICT (id) DO NOTHING` — re-running adds nothing and
  never overwrites an admin's later edits.
- The AmazonSmile rule's target org is resolved by **name** at apply time. If the
  donor org is absent, the rule is still seeded but **disabled** (it can never mint
  a gift to a null donor); a fundraiser enables it from the admin page once the org
  exists. Verify after apply:

```sql
SELECT id, enabled, target_organization_id, target_intended_usage
  FROM quickbooks_handling_rules WHERE id = 'seed_amazonsmile';
```

## Relationship to 0035

`0035_quickbooks_amazon_smile_gifts_backfill.sql` was the one-time catch-up that
converted the AmazonSmile rows already sitting in the queue. This migration is the
**going-forward** rule that auto-handles *future* AmazonSmile payments, so the
queue no longer accumulates them. 0035 minted header-only gifts (manual allocation
afterward); this rule additionally allocates to GenOps automatically.
