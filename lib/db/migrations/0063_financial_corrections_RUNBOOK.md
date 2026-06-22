# Runbook — 0063_financial_corrections

## What this does

Adds the two tables behind the **financial-corrections review queue**
(Task #338 — link evidence to gifts many-to-many with correction proposals;
INV-5/6 & §4.2/§4.8):

### `gift_evidence_links`

The additive **many-to-many CORROBORATING** layer between a CRM gift and a piece
of funding/accounting evidence (a QuickBooks staged row or a Stripe staged
charge). One gift may point at several evidence rows (the Stripe charge AND the
QuickBooks deposit for the same money) and one evidence row may corroborate
several gifts (a bulk deposit that batches many donors).

- `evidence_kind` — `'qb_staged'` (→ `staged_payments.id`) or `'stripe_charge'`
  (→ `stripe_staged_charges.id`), CHECK-constrained.
- `evidence_id` — polymorphic; carries **no foreign key** (like
  `duplicate_dismissals`), disambiguated by `evidence_kind`.
- `gift_id` — FK to `gifts_and_payments` with **ON DELETE CASCADE**: a
  corroborating link is a re-derivable CRM-side annotation, not part of the money
  trail, so deleting/merging a gift simply drops its links (the detector
  re-surfaces the tie if it still holds) without touching the battle-tested gift
  merge/delete paths.
- `sub_amount` — optional portion of the evidence attributed to this gift, for
  display/audit only.
- Unique index `(gift_id, evidence_kind, evidence_id)` makes a link idempotent;
  a reverse index `(evidence_kind, evidence_id)` answers "which gifts does this
  evidence corroborate?".

**Book-once is preserved structurally.** These links are *corroborating only* and
never contribute to any counted total. The single COUNTED (book-once) source of a
gift's amount stays where it already lives — `gifts_and_payments.final_amount_*`
and the partial-unique
`staged_payments.matched/created/group_reconciled_gift_id` /
`staged_payment_splits` pointers. A corroborating link can never become "the
counted source", so adding any number of them cannot double-count a dollar.

### `financial_correction_dismissals`

Records correction proposals an admin has explicitly marked **"leave as is"**, so
the detector never re-surfaces them. Mirrors `duplicate_dismissals` (0054).

- `kind` — the proposal kind (`'merge_gifts'` | `'link_evidence'`).
- `proposal_key` — the detector's canonical, order-independent key for the
  proposal (sorted gift ids for a merge; evidence id + sorted gift ids for a
  link), so a dismissal is idempotent regardless of detector ordering.
- Unique index `(kind, proposal_key)` makes a dismissal idempotent.
- No foreign keys by design — historical review state; a key pointing at
  since-merged/archived rows is harmless because that proposal can no longer be
  produced.

## Safety

- **Additive and idempotent.** `CREATE TABLE IF NOT EXISTS` +
  `CREATE INDEX IF NOT EXISTS`. No existing data is read or modified.
- Re-running is a no-op.

## How to apply (production, by a human)

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0063_financial_corrections.sql
```

Apply **after** the schema/code Publish (both tables also ship via the normal
Drizzle schema diff; this file is the reviewed, idempotent equivalent for a
human-applied path). Order relative to Publish does not matter — the file is
self-contained and creates the tables itself. It does reference
`gifts_and_payments` and `users`, which already exist in every environment.

## Verify

```sql
SELECT to_regclass('public.gift_evidence_links') IS NOT NULL AS gel_exists;
SELECT to_regclass('public.financial_correction_dismissals') IS NOT NULL
  AS fcd_exists;
SELECT indexname FROM pg_indexes
WHERE tablename IN ('gift_evidence_links', 'financial_correction_dismissals')
ORDER BY tablename, indexname;
```
