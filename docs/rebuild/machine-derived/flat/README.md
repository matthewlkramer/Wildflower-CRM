# Flat machine-derived CSVs

These files are denormalized inspection views generated **only by joining the checked-in machine-derived CSVs** in the parent directory. No production database query or write is involved.

## Files

- `bank_deposits_flat.csv` — one row per machine bank deposit. Parent deposit columns remain unprefixed. Child relationships are JSON arrays: `components`, `payment_units`, `stripe_payout_ties`, and `qbo_register_links`.
- `bank_deposit_components_flat.csv` — one row per machine component, with component columns, the complete parent deposit copied with a `deposit_` prefix, and the linked payment unit copied with a `unit_` prefix.
- `payment_units_flat.csv` — one row per payment unit. Units with a composition component have the parent deposit copied with a `deposit_` prefix. Units without a component have blank parent columns and `deposit_relationship_count=0`. If a future unit maps to multiple deposits, this view emits one row per unit/deposit pair; the current machine layer has at most one.

## Array/count/sum conventions

In `bank_deposits_flat.csv`, every child array has companion columns named `<array>_count` and `<array>_sum`. Array cells are valid, CSV-quoted JSON arrays of objects. Empty relationships are represented as `[]`, count `0`, and sum `0.00`.

- `components_sum` sums component `amount`.
- `payment_units_sum` sums the linked units' `gross_amount` once per unique unit.
- `stripe_payout_ties_sum` sums payout `amount`.
- `qbo_register_links_sum` sums register-link `amount`.
- `components_sum_vs_deposit_diff` is `deposit amount - components_sum`; positive means under-composed and negative means over-composed.

All dollar sums are rounded to cents. The source machine CSVs remain authoritative; these files add no records or relationships.

## QBO register flat view

- `qbo_register_flat.csv` — one row per positive QBO register-import deposit row (2,245 rows). The register columns are raw evidence fetched from the deterministic `qbo_register_export` import.
- `is_tied` is `true` only when the register row appears in the machine-derived `qbo_register_links.csv`; `tie_*` columns preserve the machine link evidence.
- When tied, `deposit_*` columns and the `components` / `payment_units` JSON arrays with their `_count` and `_sum` companions come from the canonical machine-derived `flat/bank_deposits_flat.csv` row. When untied, deposit fields are blank, arrays are `[]`, counts are `0`, and sums are `0.00`.
- This file deliberately does not derive ties from production money-model tables: register rows are raw imported evidence, while every tie, canonical deposit, composition, and payment-unit field is sourced from the checked-in machine rebuild CSVs. Array cells are valid, CSV-quoted JSON.

## Deposit-to-register pointers

`bank_deposits_flat.csv` (and the base `machine-derived/bank_deposits.csv`) includes a direct pointer for each machine deposit tied to a QBO register row:

- `qb_register_txn_id` is the tied register `bank_transaction_id`, joined from `qbo_register_links.csv`; it is empty when no register tie exists.
- `qb_register_match_basis` classifies the absolute deposit-date/register-transaction-date gap: `same_day_unique_amount`, `one_day_unique_amount`, `two_day_unique_amount`, or `three_day_unique_amount`. The reserved `human` value is for future human-decided ties.
- `qb_register_match_note` is reserved for explanatory text on `human` ties and is empty for the current deterministic links.

These pointers are strictly one-to-one per deposit and are derived only from the checked-in machine register-link CSV.

## QBO reach analysis

The augmented flat files include a direct-QBO pointer and hierarchy reach flags using interpretation B: any QBO accounting record counts. `qb_direct_provenance` is `register` for a deposit register row, `qbo_deposit_line` for a component or composition unit, and `charge_qb_tie` for a Stripe-charge source link. Payout nodes have no direct QBO pointer in the machine model.

- `qb_direct_*` identifies the node's own QBO record; it is blank when the node reaches QBO only through relatives.
- Top deposits have `qb_via_children`, `qb_via_grandchildren`, `reaches_qb_anywhere`, and `children_*` / `grandchildren_*` fan-out counts.
- Components and payouts have `qb_via_parent`, `qb_via_child`, `reaches_qb_anywhere`, and `children_*` counts. Payouts are in `stripe_payouts_flat.csv`.
- Bottom units have `qb_via_parent`, `qb_via_grandparent`, and `reaches_qb_anywhere`. Stripe-charge units are attached to payouts using the raw charge-to-payout import mapping; composition units are attached to components.
- `stripe_payouts_flat.csv` is one row per machine payout tie, with parent deposit fields and a JSON `charges` array.

The charge-level `charge_qb_tie` / `charge_fee_row` links come from the checked-in human-decisions registry, not machine recomputation. They are surfaced with separate provenance so strict machine-only consumers can exclude those direct pointers.

## All QB ties

`bank_deposits_flat.csv` also includes the union of every production QB record tied to a deposit through the three supported mechanisms:

- `register` — `bank_deposit_qbo_register` joined to its register `bank_transactions` row.
- `component_qbo_line` — the staged-payment row referenced by a composing `bank_deposit_components.source_staged_payment_id`.
- `provisional_qbo` — the staged-payment row referenced by the legacy/provisional `deposit_qbo_components` overlay.

The `qb_links` column is valid JSON containing compact objects with `tie_source`, `qb_record_id`, `amount`, `date`, `payee`, `memo`, `reference`, `account`, and (when available) `qb_deposit_id`. `qb_links_count` is the number of unique QB records in the union, and `qb_links_sum` sums their amounts. Empty unions are `[]`, `0`, and `0.00`. Production deposit IDs are translated to canonical machine IDs through `id_remap.csv`. If the same QB record appears through multiple mechanisms, it is represented once, preferring `register`, then `component_qbo_line`, then `provisional_qbo`; mechanism coverage counts remain available from the source joins.
