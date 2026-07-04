---
name: payment_applications corroborating vs counted link_role
description: Every payment_applications reader must filter link_role='counted'; corroborating rows are audit-only and must never enter a money read.
---

# `payment_applications.link_role` — counted vs corroborating

`payment_applications` (PA) is the unified unit↔gift ledger. Phase 5 folded the
old FK-less `gift_evidence_links` (gel) table INTO it as `link_role='corroborating'`
rows (design doc §5 Decision 2). So PA now holds two kinds of row:

- `counted` — the money trail. `amount_applied` is NOT NULL and > 0. Included in
  every SUM / tie / settled derivation.
- `corroborating` — an audit annotation (a gift↔evidence link that does NOT book
  money). `amount_applied` is NULL. Must NEVER enter a money total.

## The rule

**Every read of `payment_applications` that feeds a money total, a "has a payment
landed?" check, or a tie/settled derivation MUST filter `link_role = 'counted'`.**
The role-scoped partial uniques and the role-aware `amount_applied` CHECK enforce
write shape, but reads are plain SQL — nothing stops a query from summing/【EXISTS】-ing
across both roles.

**Why:** A code review caught a real leak — `giftPaymentSummary.ts`
(`settledGrossForGift`, `hasLinkedPaymentForGift`) filtered only
`evidence_source='quickbooks'`, not `link_role='counted'`. A gift whose ONLY PA
row was corroborating (exactly what the corrections `/apply` flow and the 0090
backfill produce) flipped `hasLinkedPayment` TRUE, changing `derivedSettledAmount`
from NULL ("nothing landed yet") to '0' ("settled $0") — the precise distinction
that read model exists to preserve. No counted SUM moved a dollar (corroborating
amount is NULL), but it silently corrupted a derived money surface the moment the
dual-write/backfill ran.

**How to apply:** When adding or reviewing any PA reader, grep for
`payment_applications` and confirm each one carries `link_role = 'counted'` (the
helpers in `artifacts/api-server/src/lib/paymentApplications.ts` already do; the
raw subqueries in `giftPaymentSummary.ts` now do too). The regression guard is the
"corroborating links stay out of the settled read model" test in
`financialCorrections.integration.test.ts` (corroborating-only gift ⇒
`derivedSettledAmount` NULL).

## Related

The corroborating rows have their own per-anchor partial uniques
(`..._corroborating_uq`, partial on `link_role='corroborating'`), DISJOINT from the
counted book-once uniques, so a counted and a corroborating row for the same
(anchor, gift) coexist.

## Read-flip is DONE — gel is frozen; parity is no longer a gate

The Phase-5 read-flip has shipped: `gift_evidence_links` (gel) is now WRITE-FROZEN.
The corroborating ledger is the SOLE home for evidence↔gift links. No api-server
source reads or writes gel anymore — corrections `/apply` writes only the
corroborating PA row, and giftCombine re-homes only corroborating PA rows (keyed on
the anchor `qb:{paymentId}` / `st:{stripeChargeId}`, deleting the loser's row when
the survivor already corroborates that anchor to dodge 23505). The only remaining
references are historical comments + the design doc + migrations 0063/0090/0091.

## gel is DROPPED (Phase 5 S7 complete)

The physical `DROP TABLE gift_evidence_links` shipped as the reviewed, human-applied
`lib/db/migrations/0091_drop_gift_evidence_links.sql` (idempotent `IF EXISTS`, no
CASCADE — gel had only outgoing FKs, so RESTRICT-on-surprise is the safe default;
applied via `psql -1`). The Drizzle schema file, its barrel export, and the obsolete
`parity-gift-evidence-links.ts` script + its package.json entry are all gone; the
test's gel references (the `gelCount()` regression guard, schema field, dbMod
assignment, afterAll cleanup) were removed. The corroborating PA ledger is now the
ONLY home for evidence↔gift links — there is no `parity:gift-evidence-links` gate.

**Prod DROP ships via Publish (VERIFIED, durable lesson):** a table dropped in DEV
ships to prod through the **Publish schema diff automatically and non-interactively**.
Here the user Published without hand-applying 0091 and gel was still dropped from prod
cleanly (`to_regclass` → NULL in prod, app healthy, no `relation does not exist`).
Schema/DDL is Publish's job — the reviewed-idempotent-SQL-file rule (replit.md
invariant #7) is for prod **DATA** changes, not DDL. So 0091 was belt-and-suspenders:
kept as documentation / a manual fallback, but prod did NOT need it applied by hand.
Caveat: the DEV post-merge `drizzle-kit push` is a *different*, INTERACTIVE path that
can abort on drops (see `post-push-abort`) — that abort risk is dev-only, not deploy.
