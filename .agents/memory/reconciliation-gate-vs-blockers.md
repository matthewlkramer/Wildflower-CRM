---
name: Reconciliation gate vs client blockers
description: Why the reconciler approve can 409 with an opaque message, and the correct fix (surface server issues, don't duplicate the gate).
---

# Reconciliation approve: server gate vs client blockers

The reconciler approve button is enabled/disabled from the client-derived
`graph.blockers` (reconciliationGraph.ts), but the server re-derives the graph and
runs the authoritative `runConsistencyGate` (reconciliationGate.ts) before
committing. **The client blockers intentionally mirror only SOME gate codes**
(donor missing/ambiguous, gift missing/ambiguous, amount-out-of-band — using the
same `amountWithinFeeBand`). Gate codes NOT mirrored client-side →
button stays enabled → approve 409s: `stripe_charge_required` (graph sets a single
`stripeEvidence.chargeId` only when EXACTLY ONE charge backs the payout; a
multi-charge payout leaves it null so no charge id is sent), plus the gift-link
codes (`gift_archived` / `opportunity_archived`,
`gift_donor_mismatch_opportunity`, `stripe_charge_unlinked`,
`gift_already_stripe_sourced`).

**Rule:** do NOT try to replicate the full gate in client blockers — that creates
drift and the server is the source of truth (it re-derives from the DB, never
trusts UI locks). Instead, on a failed approve, surface the server's
`details.issues[].message` to the reviewer.

**Why:** the gate's 409 body is
`{ error, message, details: { issues: [{ code, message }] } }` and every message
is already human-friendly/actionable ("select the Stripe charge so its gross
amount is used", "the gift has no donor"). The generated client throws `ApiError`
(custom-fetch.ts) carrying the parsed body on `err.data`; `err.message` is only the
generic top-level line. `ApiError` is NOT exported from `api-client-react`, so
duck-type `err.data.details.issues` (helper `extractGateIssues` in
wildflower-crm `lib/reconciliation.ts`).

**How to apply:** any reconciler mutation that hits `runConsistencyGate` (approve,
group-approve, create-gift outcomes) should run its `onError` through
`extractGateIssues` and fall back to `err.message` only when no issues parse.
