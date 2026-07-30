---
name: Donor related-giving credit
description: Current principal and primary-household related-giving rules.
---

# Donor related-giving credit

Giving totals are derived, never stored as soft-credit rows.

An individual receives credit for:

- gifts recorded directly to that individual;
- gifts recorded to the individual's `primary_household_id`; and
- gifts from organizations where the individual is a **current principal**
  (`people_entity_roles.connection='principal' AND current='current'`).

Primary-contact and advisor relationships do not create donor credit. They are
relationship-management context, not evidence that the person controls the gift.

A household receives credit for:

- gifts recorded directly to the household;
- direct gifts by people whose `primary_household_id` points to the household;
- gifts from organizations where any such current household member is a current
  principal.

Organization records retain their own direct giving total. Cross-record related
giving intentionally appears on both the organization and credited person or
household, but each record's own calculation counts a given gift only once.

Archived gifts are excluded from every giving and most-recent-gift calculation.
