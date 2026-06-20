---
name: Stripe→QB historical restitch needs an explicit admin trigger
description: Why reconciliation cards show no Stripe until a one-time propose-all pass runs, and how the incremental sync misses historical/prior-account payouts.
---

# Stripe→QB historical restitch trigger

The incremental Stripe sync only proposes QB-deposit matches for the payouts it
pulled **in that same run** (its `seenIds`). Payouts that entered the table any
other way — the prior Stripe account, CSV-backfilled rows, anything created before
the matcher existed — are never proposed and sit `qbReconciliationStatus='unmatched'`
forever.

A `/reconciliation` card only renders its Stripe evidence panel when a payout points
at that QB staged row via `matched_qb_staged_payment_id` OR
`proposed_qb_staged_payment_id`. So while every payout is `unmatched`, **no card can
show Stripe** even when the money really did flow through Stripe.

The fix is a one-time "propose over everything" pass: `proposePayoutMatches()` with no
args (standalone wrapper around `runProposalPass`). It is account-agnostic — the WHERE
filters only on `qbReconciliationStatus IN REPROPOSABLE`
(`unmatched`/`proposed`/`conflict_approved`), with no account filter — so it covers the
prior account too. It still takes the per-account "stripe" advisory lock to serialize
against the sync worker.

**Why a human-clicked admin trigger, not an automatic backfill:** the agent cannot
write prod, and the real QB data + human QB↔CRM links live only in prod. The pass is
non-destructive (writes *proposed* matches only — never mints or archives), so it ships
as an admin button + `POST /stripe/reconciliation/propose-historical`, and a human runs
it in deployed prod after Publish, then confirms each card.

**How to apply:** if "Stripe is missing on the reconciliation cards," first check
whether any payout is actually linked (`matched`/`proposed` count > 0). If all are
`unmatched`, the restitch pass simply hasn't been run yet — it is not a matcher bug.
Some cards (checks, brokerage/stock gifts) legitimately never have Stripe.
