---
status: ratified
last_verified: 2026-09-23
---

# Donor routing and payment intermediaries

These are three related but independent facts. They must not be edited through
one bundled settings form.

## Primary household

`people.primary_household_id` is the sole current primary-household fact for an
individual. It is optional, points only to an active household, and is edited
on the individual's **Primary household** card.

When donor-of-record routing is automatic, an individual's primary household
is the implicit next step. If no primary household exists, the individual is
the donor of record.

## Default donor of record

`donor_routing_preferences` stores an optional explicit routing decision for an
individual, household, or organization. No row means automatic behavior. An
explicit row may keep the current record, route to another donor record, or
require a decision each time.

This setting answers only **who receives donor credit**. It never edits a
primary household or a payment intermediary.

## Payment intermediary relationships

`donor_payment_intermediaries` records the payment intermediaries a donor uses.
Each row has exactly one donor FK, and each donor/intermediary pair has one
durable row. Removing a relationship archives it; adding the same pair later
restores the row so history and audit evidence are retained.

A donor may have at most one active relationship marked `is_default`. Archived
relationships and archived payment intermediaries cannot be defaults and are
not offered to new gifts. The **Payment intermediaries** card is the only UI
that creates, archives, restores, or chooses the preferred relationship.

## New-gift resolution

An explicitly selected `gifts_and_payments.payment_intermediary_id` always
wins. Otherwise, after donor-of-record routing is resolved:

1. use the payment-intermediary default explicitly set on the source record the
   user selected;
2. if the source has no usable default, use the resolved donor of record's
   default;
3. otherwise leave the gift's payment intermediary empty.

The database function `resolve_default_payment_intermediary` is the shared
authority for this rule. The new-gift trigger and the donor detail API both use
it, so the UI preview and stored gift cannot disagree.
