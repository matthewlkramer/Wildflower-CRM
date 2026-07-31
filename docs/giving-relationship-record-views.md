# Giving relationship record views

The giving-relationship endpoint and card present one deduplicated fundraising view without changing the donor-of-record or accounting model.

## Attribution rules

- Individual: gifts recorded directly to the person, gifts to the person's primary household, and gifts from organizations where the person is a current principal.
- Household: gifts recorded directly to the household, gifts recorded to current household members, and gifts from organizations where any current member is a principal.
- Organization: gifts recorded directly to the organization.
- Every gift is counted once in the relationship total even when several household members are principals of the same organization.
- Archived gifts and archived people are excluded.

## Intermediaries

Giving through a DAF or other payment intermediary is displayed as an overlapping delivery-method total. It is never added to the relationship total and never treated as the donor.

## UI

The shared card appears on individual, household, and organization record pages. It shows:

- relationship total;
- donor-of-record total;
- gift count and largest gift;
- the resolved preferred donor pathway;
- attribution breakdown with counts and amounts; and
- recent gifts labeled by why they are included.
