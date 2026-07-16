# 0129 — Charge-tie supersede backfill (RUNBOOK)

## What this fixes

Before `applyChargeTieSupersedePairs` existed, confirming a gift↔charge tie
(`stripe_staged_charges.linked_qb_staged_payment_id`) left the tied QB row's
counted booking at the QB grain. The `/reconciliation-clusters` view reads the
charge grain, so all of that already-booked money showed as **unlinked**.

This migration retro-applies exactly the decision the app now makes on every
tie confirm (`chargeTieSupersede.ts`, `decideChargeTieSupersede`):

- **Move** (86 rows, $38,581.42): book a counted Stripe copy on the tied
  charge (deterministic id `pacts_<source row id>`, note starts with the app's
  marker `charge_tie_supersede:<qbId>`), then demote the QB source row to
  `corroborating`, keeping its amount.
- **Demote only** (7 rows, $1,505.02): the charge already carries a counted
  Stripe row for the same gift — just demote the QB row.
- **Conservative skip** (2 rows — human review below): booking the copy would
  over-apply the charge's gross cap.
- Override-mismatch ties (QB amount ≠ charge gross AND ≠ net to the cent) are
  **untouched** — same as the app's exact-cents same-money test.
- Finishes by re-deriving `quickbooks_tie_status` for every gift holding a
  supersede-managed corroborating QB row (mirrors `deriveGiftQbTie`).

Prod audit (2026-07-16): 95 counted QB rows behind exact-money ties across
95 gifts; zero QB payments with more than one tied charge (no join fan-out);
zero colliding corroborating rows.

## Apply

Ship the code first (Publish), then from the project root:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0129_charge_tie_supersede_backfill.sql
```

The file has no `BEGIN/COMMIT` — `-1` wraps it in a single transaction.

## Expected first-run counts

| Step | Statement | Expected |
|------|-----------|----------|
| 1 | INSERT counted Stripe copies | **INSERT 0 86** |
| 2 | DELETE colliding corroborating rows | **DELETE 0** |
| 3 | UPDATE demote QB rows → corroborating | **UPDATE 93** |
| 4 | UPDATE re-derive `quickbooks_tie_status` | small; varies (guarded `IS DISTINCT FROM`) |

Re-run: all zeros (every statement is guarded on current facts).

## After applying

Run the tie-status backfill as a belt-and-braces sweep (recomputes every
gift with the app's own derivation):

```bash
pnpm --filter @workspace/scripts run backfill:gift-qb-tie
```

Then run the verification queries at the bottom of the SQL file. Key checks:

- movable counted QB rows remaining behind exact ties → **2 rows** (exactly
  the skipped pair below)
- `pacts_%` copies → **86 | 38581.42**
- copies on the wrong charge → **0**
- `repair 0129`-marked corroborating rows → **93 | 40086.44**

## Human review — the 2 conservative skips

Both are cases where the tied charge is already fully counted for a
**different** gift, so the same money is booked twice (once per gift). The
migration leaves the QB booking counted (visible, under-counts nothing);
resolving them means picking/merging the right gift, after which the app's
supersede converges the tie on its own:

| QB payment (`staged_payments.id`) | QB counted row | Gift kept on QB side | Amount | Tied charge | Charge counted for |
|---|---|---|---|---|---|
| `R2a_3l4HEIV7b4sWIAfjO` | `NcREIplmwERjlOYM1VpZp` | `O19isipf8UIhokCX94iCu` ("Alexander Brown") | $150.00 | `ch_3TUqs3AhXr9x8yiR1Y2lJjss` | a different gift, $150.00 (full gross) |
| `4xofH29oI7mJehqCs_LnN` | `fd4133b0-1f3d-42af-940a-5cd87fefb3ac` | `rec5zYlQZnqKKbQCU` ("FY26 Cantoni $1044 to WF") | $1,044.16 | `ch_3ShBTqAhXr9x8yiR0hT9X8Ay` | a different gift, $1,044.16 (full gross) |

Likely duplicate gifts — check each pair in the gift merge flow; once the
duplicate is merged/archived, re-running this file (or the app's next tie
confirm pass) converges the leftover row.

## Reversibility

Fully app-reversible: reverting a tie in the workbench removes the marked
Stripe copy (`charge_tie_supersede:<qbId>` note prefix) and promotes the
demoted QB row back to counted (`applyChargeTieSupersedePairs`, revert path).
No data is deleted by this migration except (guarded, expected-zero)
colliding corroborating crumbs.
