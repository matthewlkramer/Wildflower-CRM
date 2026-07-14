---
name: Sibling Stripe-fee QB row link
description: Charge↔QB tie gross-or-net matching + confirm-time auto-claim of the deposit's negative "Stripe fee" row as plane-1 evidence.
---

## Rules

- **Charge↔QB exact match accepts GROSS or NET** (to the cent). A bookkeeper
  either books the gross donation line (then a sibling negative fee line) or
  the post-fee net. When both a gross row and a net row fit, gross wins; a
  cross gross/net collision is ambiguous and needs name similarity.
- **Fee link = plane-1 settlement evidence ONLY.**
  `stripe_staged_charges.linked_fee_qb_staged_payment_id` marks the deposit's
  negative "Stripe fee" row as explained by the charge. Fee rows must NEVER
  enter `payment_applications` or any money sum — the column is display/audit
  passthrough only (workbench chip, gift audit view).
- **Claim rule** (confirm-time + 0127 backfill, byte-for-byte the same):
  candidate = NEGATIVE row of the SAME QB deposit (realm + entity type +
  entity id), amount exactly −(gross − net), fee-ish payer/line text, not
  spoken for (fee-claimed / donor-tied / proposed / settlement-link deposit).
  No status filter — negative rows derive status `excluded`, which IS the fee
  row's normal state.
- **Equal-fee twins pair rank-to-rank** (charges by id × rows by qb_line_id,
  id) so each row is claimed at most once and reruns are deterministic. The
  TS pairer (`pairChargeFeeRows`) and the SQL backfill must stay lockstep —
  changing one without the other silently diverges runtime vs backfill.
- **Best-effort, never aborts confirm**: each stamp runs under a SAVEPOINT;
  a cross-payout race on a shared deposit that trips the partial unique index
  rolls back just that stamp (logged) and the confirm proceeds.

**Why:** fees netted out of deposits looked like unreconciled money; but
counting them anywhere would double-book (Stripe gross is already the counted
evidence). No revert path — mirrors confirmed donor ties; a wrong link is a
reviewed SQL clear (safe: nothing derives money from the column).

**How to apply:** any change to the claim predicate or pairing order must
touch BOTH chargeQbTie.ts and the 0127-style backfill; keep `feeRowsTied` in
the confirm response so manual mode's auto-grab is never silent.
