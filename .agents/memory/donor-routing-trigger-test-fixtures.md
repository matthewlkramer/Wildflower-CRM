---
name: Donor-routing trigger rewrites test fixtures
description: gifts_apply_preferred_donor_trg fires on direct DB inserts in tests; fixtures needing an individual as donor of record must seed an explicit 'self' routing preference.
---

# Donor-routing trigger rewrites gift test fixtures

The `gifts_apply_preferred_donor_trg` BEFORE INSERT trigger on
`gifts_and_payments` (donor attribution phase 2; in the test DB's
PROGRAM_MIGRATIONS list) applies preferred-donor routing to EVERY insert —
including direct `db.insert()` calls in integration tests. Default rule: an
individual with a `primary_household_id` and no `donor_routing_preferences`
row gets rerouted to their household as donor of record.

**Why:** A giving-relationship test merged from GitHub was written before the
trigger existed and failed deterministically here — its "direct gift by
person" fixtures were silently rewritten to household gifts at insert time
(symptom: donorOfRecordTotal 0, member gifts leaking into person views).
Externally-developed PRs can pass in their environment and fail after merge
when a local trigger changed write semantics — a semantic merge conflict, not
a flake.

**How to apply:** Any test fixture that inserts a gift with
`individualGiverPersonId` for a person who has a primary household must first
seed a `donor_routing_preferences` row with `mode: 'self'` for that person
(target fields NULL per the shape check). Deleting the person cascades the
preference row. Note an explicit 'self' preference also changes
`resolveDonorRouting` output: resolvedDonor becomes the person, not the
household default — expectations must be consistent with the fixture.
