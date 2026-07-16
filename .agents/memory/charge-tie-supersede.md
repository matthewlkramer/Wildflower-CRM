---
name: Charge-tie supersede & tie evidence vs claim
description: Moving tie-booked QB money to the charge grain, and why the QB derived-status tie arm must require a BOOKED charge while pick-list blockers use raw linkage.
---

## Supersede (one-count at the charge-tie grain)

- On charge↔QB tie confirm (and via backfill migration), a QB `counted`
  payment_applications row whose amount is the EXACT same money as the tied
  charge (== charge gross OR net, to the cent) is moved to the charge grain:
  a copy is minted against the charge (note starts with marker
  `charge_tie_supersede:<qbStagedPaymentId>`, deterministic id `pacts_<paId>`)
  and the QB row is demoted to `corroborating`.
- Untouched by design: override-mismatch ties (amount differs from both gross
  and net) and charges already counted for a DIFFERENT gift (cap-skip — human
  review). Demote-only when the charge already carries the same gift's counted
  row. Revert restores the QB counted row and deletes the marker copy.

## Tie facts are TWO distinct predicates — never conflate

- **Evidence (status)**: a charge-grain tie makes the QB row `match_confirmed`
  ONLY if the tied charge itself carries a counted stripe ledger row. Raw
  linkage as evidence broke the refunded-charge sweep tests: a refunded charge
  merely tied to a deposit flipped the QB row to match_confirmed and hid
  its excluded/pending work.
- **Claim (pick-list blocker / eligibility)**: raw `linked_qb_staged_payment_id`
  linkage, booked or not — the tie claims the row, so re-picking it elsewhere
  must gray/409 even before the charge's money is booked.
- The QB derived-status CASE has alias twins outside derivedStatus.ts (raw-SQL
  status CASEs in workbench-cluster, deposit-picker, and bundle-anchor routes);
  any semantic change to one arm must be applied to ALL twins — grep
  `linked_qb_staged_payment_id` across routes.

**Why:** derived status is the single honesty signal for "is this money
booked?"; a claim-only tie showing as confirmed silently hides open work, and
an unbooked-tie pick would double-book if allowed.

**How to apply:** touching tie semantics, refund sweeps, or QB staged status →
decide evidence vs claim first, then update derivedStatus.ts AND every raw-SQL
twin together; the refunded-charge-exclusion + bundle-anchor integration tests
catch each side respectively.
