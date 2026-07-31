# Donor attribution phase 3

Phase 3 normalizes historical CRM attribution and retires transitional household
membership rows. It does not alter accounting evidence.

## Historical normalization

The migration automatically changes a historical gift from an individual to that
individual's primary household only when all of the following are true:

- the gift is active;
- the individual has an active primary household; and
- the individual has no explicit donor-routing preference.

Every automatic change receives both an audit-log entry and a resolved cleanup
record. Gift amount, date, allocations, payment intermediary, QuickBooks, Stripe,
Donorbox, payment-unit, application, and source-link evidence are unchanged.

Explicit target pathways generate medium-confidence review proposals rather than
automatic changes. Applying a proposal rechecks the current donor and pathway in
a transaction, so stale proposals cannot silently overwrite later work.

## Intermediary suggestions

A donor with exactly one intermediary across active historical gifts and no current
default receives a medium-confidence proposal. A human must apply it. Historical
usage never becomes a default merely because the migration ran.

## Household authority

`people.primary_household_id` is the sole household-membership authority.
Household detail pages read members directly from that pointer. Phase 3 deletes
legacy household rows from `people_entity_roles`, stops dual-writing them, and
rejects new household-role writes at both the API and database layers.
