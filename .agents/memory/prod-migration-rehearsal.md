---
name: Prod data-migration rehearsal + retroactive supersede
description: How to rehearse a human-run prod SQL repair on a scratch DB, and the precedent that historical charge-tie repairs must include the supersede ledger moves, not just evidence links.
---

# Rehearse prod data migrations on a scratch DB

**Rule:** before handing a human a prod data-repair SQL file, rehearse it:
schema-only clone + prod-shaped fixtures + run twice + snapshot compare.

**Why:** the preflight assert block protects against *unexpected prod state*,
but only a real execution catches column typos, enum casts, FK/CHECK
violations, and non-idempotent writes. `psql -1` makes failures harmless
(full rollback), but a *logic* bug commits wrong data — the rehearsal is the
only pre-run proof of the end state.

**How to apply:**
1. `CREATE DATABASE <scratch>` then `pg_dump --schema-only "$DATABASE_URL" | psql <scratch>`
   (template-copy fails while the API server holds dev connections; schema
   dump works). Seed only not-null-no-default columns (query `pg_attribute`
   joined to `pg_attrdef` to find them) plus whatever the preflight asserts.
2. Run the file exactly as the human will (`psql -1 -v ON_ERROR_STOP=1 -f …`),
   verify the end state with explicit SELECTs.
3. Run it a second time and compare an md5 over an ORDER BY'd dump of every
   affected table — byte-identical proves idempotency, including the
   `ON CONFLICT … DO UPDATE … WHERE` no-op guards.
4. Drop the scratch DB.

# Retroactive charge-tie supersede belongs IN the repair file

**Rule:** when a repair migration writes confirmed `charge_qb_tie` links for
QB rows that carry counted cash applications, it must also apply the
supersede ledger decisions (move / demote_only / nothing-when-inexact) in the
same file — evidence-links-only is NOT enough.

**Why:** the runtime supersede recompute fires only on a tie confirm/revert
transition through the API. Ties written by SQL never trigger it, so prod
sits indefinitely in a drift state (including live double-counts where the
gift is booked on both the charge and the QB row). Precedent: repairs 0129
and 0154 both did the moves in SQL, exactly mirroring
`decideChargeTieSupersede` (exact-cents move, demote keeps amount,
`match_method='charge_tie_supersede'` discriminator, copied confirmer).

**How to apply:** for each tied QB row with applications, fetch BOTH sides'
ledgers first; classify per the runtime decision table; never move a row
whose gift differs from the charge-side gift if it would violate book-once —
tie it, note the cross-gift duplicate, and leave the ledger for a human.
