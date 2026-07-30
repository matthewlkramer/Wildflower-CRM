# Donor attribution phase 2

## Routing semantics

- No `donor_routing_preferences` row means **Automatic default**.
- An individual with a primary household automatically routes to that household.
- Other donors automatically use themselves.
- A stored `self` row is an explicit override of the automatic default.
- A stored `target` row routes to another donor record.
- A stored `ask` row blocks gift creation until a donor decision is made.

The database trigger on `gifts_and_payments` is the shared enforcement boundary,
so manual, reconciliation, Stripe, Donorbox, QuickBooks, and future creation paths
cannot drift.

## Payment intermediaries

The intermediary remains separate from the donor of record. An explicitly supplied
gift intermediary wins. Otherwise the trigger uses the resolved donor's default,
falling back to the originally selected donor's default.

## Related giving

Individuals receive related-giving credit only for current-principal organizations,
not organizations where they are merely a primary contact or advisor. Households
receive credit for direct gifts, current members' direct gifts, and organizations
where current members are current principals. Archived gifts are excluded.
