# 0229 — Fidelity $80k QBO re-split repair

This data-only repair aligns the two current QBO-derived payment units for bank
deposit `bdep_fdaf5e42f6f5ac0556ce564b` with their $65,000 and $15,000
components, and points both units to the existing $80,000 gift
`reccnVv6dWZCMjS8J`.

It does not create, archive, or delete records. The SQL aborts unless it sees the
reviewed same-payer two-component shape, and its postflight proves component and
gift-linked unit totals both equal the bank deposit. It is idempotent.

Apply to development first from the repository root. Development has no QBO
components for this historical target, so a successful `target has no QBO
components ...; no-op` notice is the expected result:

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0229_repair_fidelity_80k_qbo_resplit.sql
```

After the accompanying code is published, a human applies the same reviewed
file to production:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0229_repair_fidelity_80k_qbo_resplit.sql
```

Then search the reconciliation workbench for `80000`. The 2025-12-30 Fidelity
row must show two composition parts, one $80,000 multi-allocation gift card, and
no additional `Needs CRM gift` card.
