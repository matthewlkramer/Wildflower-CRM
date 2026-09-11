# 0245 Strategic Grant Partners bundled-gift correction

## Purpose

This is a data-only correction ratified by the CRM owner. Strategic Grant
Partners' FY18-19 funding should be represented as:

- one **$800,000 pledge** (`rectelDbOgMh2Ca3y`);
- three pledge payments of **$400,000**, **$100,000**, and **$300,000**;
- one separate **$25,000 direct gift** that arrived bundled with the third
  pledge payment.

Before this correction, the first two pledge-payment records already represented
$400,000 + $100,000. The third record was one $325,000 pledge payment with two
allocations ($300,000 + $25,000), so the pledge's active gifts totaled $825,000
despite its correct stored paid rollup of $800,000.

## Money-history boundary

The migration does **not** update any of these accounting/history tables:

- `bank_deposits`;
- `bank_transactions`;
- `staged_payments` (the QuickBooks mirror);
- `qbo_accounting_checks`.

The historical bank event remains the single **$326,500 Wells Fargo deposit on
2018-09-06** (`bdep_0600314fc0e164a1f15604c2`). It contains the SGP receipt plus
an existing excluded $1,500 component. The two existing QuickBooks source rows
remain **$300,000** (`eYUufuwn1mea0hs80eKzK`) and **$25,000**
(`3BKPGN7dLcb_pvliqNtRk`). Migration 0200 had preserved both rows while merging
their CRM gift/payment-unit representation into one $325,000 gift and unit.

Only CRM donor-credit and reconciliation composition change:

- existing SGP payment unit/component: $325,000 → $300,000, with its QBO link
  preserved;
- the previously absorbed QBO-backed $25,000 payment unit is restored and a
  $25,000 component is added within the same historical deposit;
- the existing $25,000 QBO-register `source_links` pointer is reattached from
  the merged unit to the restored $25,000 unit;
- existing $25,000 allocation moved intact to a new stand-alone direct gift;
- existing FY19 pledge-payment gift reduced to $300,000;
- pledge `paid` recomputed from its three active payments to $800,000.

The existing CRM credit date on the split gift (`2017-06-07`) is preserved on
both resulting gift headers. The payment units retain the authoritative bank/QBO
receipt date (`2018-09-06`).

## Safety and idempotency

- `psql -1` applies the file atomically; any failed assertion rolls back every
  change.
- First-run preflight requires the exact reviewed opportunity, three gifts,
  $300,000 + $25,000 allocation split, merged payment unit, component, both QBO
  mirror rows, their allocation/register evidence, deposit amount/date, and
  excluded $1,500 component.
- The migration aborts if any reviewed amount, relationship, or count drifted.
- Deterministic ids and `audit_0245_sgp_bundled_gift_split` make a successful
  re-run a verified no-op.
- Postflight proves the pledge payments, direct gift, unit/component split,
  untouched QBO evidence, and unchanged historical deposit.

## Read-only production preflight

From the repository root, run:

```bash
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT id, awarded_amount, paid, status, pledge_committed_at, archived_at
FROM opportunities_and_pledges
WHERE id = 'rectelDbOgMh2Ca3y';

SELECT id, name, amount, date_received, opportunity_id, archived_at
FROM gifts_and_payments
WHERE id IN (
  'recYYkpHXjHh2n7g6',
  'rec6elo1J3tNAoAjs',
  'recaKMBM7D9Bxv662',
  'gift_0245_sgp_direct_25'
)
ORDER BY id;

SELECT id, gift_id, sub_amount, grant_year, display_usage,
       purpose_verbatim, restriction_description
FROM gift_allocations
WHERE gift_id IN ('recaKMBM7D9Bxv662', 'gift_0245_sgp_direct_25')
ORDER BY gift_id, sub_amount DESC;

SELECT id, kind, gift_id, gross_amount, net_amount, received_date,
       source_staged_payment_id
FROM payment_units
WHERE id IN (
  'pu_eYUufuwn1mea0hs80eKzK',
  'pu_3BKPGN7dLcb_pvliqNtRk'
)
ORDER BY id;

SELECT c.id, c.bank_deposit_id, c.payment_unit_id, c.amount,
       c.source, c.source_staged_payment_id, c.exclusion_reason
FROM bank_deposit_components c
WHERE c.bank_deposit_id = 'bdep_0600314fc0e164a1f15604c2'
ORDER BY c.amount DESC, c.id;

SELECT id, amount, deposit_date, memo, reference
FROM bank_deposits
WHERE id = 'bdep_0600314fc0e164a1f15604c2';

SELECT id, amount, date_received, qb_entity_type, qb_entity_id,
       qb_doc_number, qb_deposit_to_account_name
FROM staged_payments
WHERE id IN ('eYUufuwn1mea0hs80eKzK', '3BKPGN7dLcb_pvliqNtRk')
ORDER BY amount DESC;

SELECT id, link_type, qb_staged_payment_id, bank_transaction_id,
       payment_unit_id, gift_allocation_id, lifecycle, provenance
FROM source_links
WHERE id IN (
  'srcl_qla_eYUufuwn1mea0hs80eKzK_synth-ga-recaKMBM7D9Bxv662',
  'srcl_qla_3BKPGN7dLcb_pvliqNtRk_synth-ga-recuRLvecG7IgHgY6',
  'srcl_qru_bnk_00131128bdef8fd2c7bee604',
  'srcl_qru_bnk_2c81a4c08fe3508073012685'
)
ORDER BY id;

SELECT id, txn_date, payee, deposit
FROM bank_transactions
WHERE id IN (
  'bnk_00131128bdef8fd2c7bee604',
  'bnk_2c81a4c08fe3508073012685'
)
ORDER BY deposit DESC;
"
```

Before first application, expect:

- pledge awarded/paid: `$800,000 / $800,000`;
- active pledge gifts: `$400,000`, `$100,000`, `$325,000`;
- the `$325,000` gift has exactly `$300,000` and `$25,000` FY2019 allocations;
- `pu_eYUufuwn1mea0hs80eKzK` has `$325,000` gross and `$300,000` net, while its
  component is `$325,000`; this is the reviewed merge state from migration 0200;
- the untouched QBO source rows and register evidence remain `$300,000` and
  `$25,000`, with both register claims temporarily pointing to the merged unit;
- deposit `bdep_0600314fc0e164a1f15604c2` is `$326,500`, composed of the
  `$325,000` SGP component and an excluded `$1,500` component;
- none of the deterministic `0245` target ids exists yet.

## Apply to production

This data correction requires no schema change and no application republish.
Only a human applies it to production:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0245_split_strategic_grant_partners_bundled_gift.sql
```

Expected successful output includes:

```text
NOTICE:  0245: SGP verified — $800,000 pledge paid $400,000 + $100,000 + $300,000; separate $25,000 direct gift; $326,500 deposit and $300,000 + $25,000 QBO records preserved
```

## Postflight verification

Re-run the read-only preflight query. The expected final state is:

- pledge `rectelDbOgMh2Ca3y`: awarded `$800,000`, paid `$800,000`;
- its three active gifts: `$400,000`, `$100,000`, `$300,000`;
- direct gift `gift_0245_sgp_direct_25`: `$25,000`, no pledge/opportunity link;
- the original gift has one `$300,000` FY2019 allocation;
- the direct gift has the moved `$25,000` FY2019 allocation, including its
  existing Massachusetts/restriction coding;
- the deposit still totals `$326,500`, now composed of `$300,000`, `$25,000`,
  and the existing excluded `$1,500`;
- the QBO mirror rows remain `$300,000` and `$25,000`, both dated `2018-09-06`;
- the `$25,000` allocation and register evidence point to the restored
  `pu_3BKPGN7dLcb_pvliqNtRk` payment unit;
- exactly one audit row exists:
  `audit_0245_sgp_bundled_gift_split`.

## Re-run and rollback guidance

After a successful apply, re-running the exact production command changes no
records and repeats the verification notice. It aborts if the verified final
state has drifted.

Do not manually reverse this correction. If the owner later revises the donor
intent, prepare a new separately numbered, reviewed migration that preserves the
bank/QBO source history and records its own audit entry.
