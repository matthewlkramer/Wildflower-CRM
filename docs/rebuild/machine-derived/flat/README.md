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
